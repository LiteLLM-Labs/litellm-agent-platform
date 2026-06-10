//! Live integration test: drive a real Elastic Agent Builder agent through the
//! LAP SDK (`litellm_rust`, the `elastic_agent_builder` runtime) directly — NO
//! HTTP gateway, NO master key. Only the `Lap` client pointed at your Kibana.
//!
//! It binds to an existing Elastic agent, opens a session, sends a prompt,
//! streams the normalized events, captures the Elastic `conversation_id`, then
//! sends a SECOND prompt re-using that conversation (exactly as the HTTP layer
//! does between turns) to prove continuity.
//!
//! This is a LIVE test, `#[ignore]` by default. Provide:
//!     ELASTIC_KIBANA_URL   e.g. https://<id>.kb.<region>.<csp>.elastic.cloud
//!     ELASTIC_API_KEY      encoded Kibana API key
//!     ELASTIC_AGENT_ID     id of your existing Elastic Agent Builder agent
//!     ELASTIC_SPACE        optional Kibana space (default: "default")
//!
//! Run:
//!     ELASTIC_KIBANA_URL=... ELASTIC_API_KEY=... ELASTIC_AGENT_ID=... \
//!       cargo test --test elastic_agent_builder_live -- --ignored --nocapture

use std::time::Duration;

use futures_util::StreamExt;
use litellm_rust::sdk::agents::{
    AgentEvent, AgentModel, AgentRuntime, CreateAgentParams, CreateEnvironmentParams,
    CreateSessionParams, Lap, LapConfig, ManagedSessionRef, SendEventsParams,
};
use serde_json::{json, Value};

struct Env {
    kibana_url: String,
    api_key: String,
    agent_id: String,
    space: String,
}

fn env_or_skip() -> Option<Env> {
    let kibana_url = std::env::var("ELASTIC_KIBANA_URL").ok()?;
    let api_key = std::env::var("ELASTIC_API_KEY").ok()?;
    let agent_id = std::env::var("ELASTIC_AGENT_ID").ok()?;
    if kibana_url.is_empty() || api_key.is_empty() || agent_id.is_empty() {
        return None;
    }
    Some(Env {
        kibana_url: kibana_url.trim_end_matches('/').to_owned(),
        api_key,
        agent_id,
        space: std::env::var("ELASTIC_SPACE").unwrap_or_else(|_| "default".to_owned()),
    })
}

fn lap(env: &Env) -> Lap {
    Lap::new(LapConfig::elastic(
        env.api_key.clone(),
        env.kibana_url.clone(),
    ))
}

/// Provider options the HTTP layer would normally pull from the LAP agent config.
fn provider_options(env: &Env) -> Value {
    json!({
        "elastic_agent_id": env.agent_id,
        "elastic_space_id": env.space,
    })
}

async fn bind_agent(lap: &Lap, env: &Env) -> litellm_rust::sdk::agents::ManagedAgent {
    lap.beta()
        .agents()
        .create(CreateAgentParams {
            lap_agent_runtime: AgentRuntime::ElasticAgentBuilder,
            lap_provider_options: Some(provider_options(env)),
            name: "Elastic SDK QA".into(),
            model: AgentModel::from("elastic"),
            system: String::new(),
            description: None,
            tools: Vec::new(),
            mcp_servers: Vec::new(),
            env_vars: None,
            workspace: None,
            metadata: None,
        })
        .await
        .expect("agents().create (bind) should succeed")
}

async fn open_session(lap: &Lap, agent_id: &str) -> litellm_rust::sdk::agents::Session {
    let env_id = lap
        .beta()
        .environments()
        .create(CreateEnvironmentParams {
            lap_agent_runtime: AgentRuntime::ElasticAgentBuilder,
            name: "elastic-sdk-qa".into(),
            config: json!({}),
            description: None,
            scope: None,
        })
        .await
        .expect("environments().create should succeed")
        .id;
    lap.beta()
        .sessions()
        .create(CreateSessionParams {
            agent: agent_id.to_owned(),
            environment_id: env_id,
            title: "elastic sdk session".into(),
            lap_agent_runtime: Some(AgentRuntime::ElasticAgentBuilder),
            metadata: None,
            vault_ids: None,
            resources: None,
        })
        .await
        .expect("sessions().create should succeed")
}

/// Send one prompt, stream the turn, return (assistant_text, conversation_id).
async fn run_turn(lap: &Lap, session_id: &str, prompt: &str) -> (String, Option<String>) {
    lap.beta()
        .sessions()
        .events()
        .send(
            session_id,
            SendEventsParams {
                events: vec![json!({
                    "type": "user.message",
                    "content": [{ "type": "text", "text": prompt }],
                })],
            },
        )
        .await
        .expect("events().send should succeed");

    let stream = lap
        .beta()
        .sessions()
        .events()
        .stream(session_id)
        .await
        .expect("events().stream should open");
    futures_util::pin_mut!(stream);

    let mut assistant = String::new();
    let mut conversation_id = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        let next = tokio::time::timeout_at(deadline, stream.next()).await;
        let Ok(Some(item)) = next else { break };
        let event: AgentEvent = item.expect("stream yields ok events");
        if let Some(id) = event.data.get("provider_run_id").and_then(Value::as_str) {
            if !id.is_empty() && id != "elastic_pending" {
                conversation_id = Some(id.to_owned());
            }
        }
        println!("[live] event: {}", event.event_type);
        if event.event_type == "agent.message" {
            if let Some(text) = event
                .data
                .get("content")
                .and_then(Value::as_array)
                .and_then(|blocks| blocks.first())
                .and_then(|b| b.get("text"))
                .and_then(Value::as_str)
            {
                assistant.push_str(text);
            }
        }
        if matches!(
            event.event_type.as_str(),
            "session.status_idle" | "session.error"
        ) {
            break;
        }
    }
    (assistant, conversation_id)
}

#[tokio::test]
#[ignore = "requires a live Elastic Agent Builder deployment; see file header"]
async fn elastic_agent_builder_two_turn_conversation() {
    let Some(env) = env_or_skip() else {
        eprintln!("skipping: set ELASTIC_KIBANA_URL, ELASTIC_API_KEY, ELASTIC_AGENT_ID to run");
        return;
    };

    let lap = lap(&env);

    // 1. bind + open a session
    let agent = bind_agent(&lap, &env).await;
    assert_eq!(
        agent.id, env.agent_id,
        "binds to the existing Elastic agent"
    );
    let session = open_session(&lap, &agent.id).await;
    println!("[live] session id={}", session.id);

    // 2. turn 1
    let (text1, conv1) = run_turn(&lap, &session.id, "In one short sentence, who are you?").await;
    println!("[live] turn1 assistant: {text1}");
    let conv1 = conv1.expect(
        "turn 1 should capture a real Elastic conversation_id — if this fails the SSE \
         event names from your Kibana version differ from the normalizer; run a raw \
         converse call and share the `type:` fields",
    );
    println!("[live] conversation_id={conv1}");

    // 3. re-register the session with the captured conversation_id, exactly as the
    //    HTTP layer's register_runtime_session does on the next turn (DB-backed there,
    //    explicit here since there is no gateway).
    let binding = session
        .raw
        .get("provider_session_id")
        .and_then(Value::as_str)
        .expect("session raw carries the encoded Elastic binding")
        .to_owned();
    lap.register_session(ManagedSessionRef {
        session_id: session.id.clone(),
        lap_agent_runtime: AgentRuntime::ElasticAgentBuilder,
        provider_session_id: Some(binding),
        provider_agent_id: None,
        provider_run_id: Some(conv1.clone()),
    })
    .expect("register_session should succeed");

    // 4. turn 2 — must continue the same Elastic conversation
    let (text2, conv2) = run_turn(&lap, &session.id, "Repeat that back verbatim.").await;
    println!("[live] turn2 assistant: {text2}");

    if let Some(conv2) = conv2 {
        assert_eq!(
            conv1, conv2,
            "second turn reuses the same Elastic conversation_id"
        );
    }
    assert!(!text1.is_empty(), "turn 1 produced assistant text");
}

/// Multi-turn back-and-forth with memory-dependent prompts. Each turn is a live
/// streamed converse; the captured conversation_id is fed back between turns so
/// later turns must recall earlier context.
#[tokio::test]
#[ignore = "requires a live Elastic Agent Builder deployment; see file header"]
async fn elastic_agent_builder_back_and_forth() {
    let Some(env) = env_or_skip() else {
        eprintln!("skipping: set ELASTIC_KIBANA_URL, ELASTIC_API_KEY, ELASTIC_AGENT_ID to run");
        return;
    };

    let lap = lap(&env);
    let agent = bind_agent(&lap, &env).await;
    let session = open_session(&lap, &agent.id).await;
    let binding = session
        .raw
        .get("provider_session_id")
        .and_then(Value::as_str)
        .expect("session raw carries the encoded Elastic binding")
        .to_owned();
    println!("[live] session id={}", session.id);

    let turns = [
        "Remember this for later: my project codename is BlueFalcon. Acknowledge in one short sentence.",
        "What is my project codename? Answer with just the codename.",
        "Spell that codename backwards.",
    ];

    let mut conversation_id: Option<String> = None;
    for (i, prompt) in turns.iter().enumerate() {
        // Between turns, re-register with the conversation_id (what the HTTP layer
        // persists + reloads from the DB). No-op on turn 0 (none captured yet).
        if let Some(conv) = &conversation_id {
            lap.register_session(ManagedSessionRef {
                session_id: session.id.clone(),
                lap_agent_runtime: AgentRuntime::ElasticAgentBuilder,
                provider_session_id: Some(binding.clone()),
                provider_agent_id: None,
                provider_run_id: Some(conv.clone()),
            })
            .expect("register_session should succeed");
        }

        println!("\n[live] >>> user turn {}: {prompt}", i + 1);
        let (text, conv) = run_turn(&lap, &session.id, prompt).await;
        println!("[live] <<< assistant turn {}: {text}", i + 1);

        if let Some(conv) = conv {
            if let Some(existing) = &conversation_id {
                assert_eq!(existing, &conv, "conversation_id stays stable across turns");
            } else {
                conversation_id = Some(conv);
            }
        }
        assert!(!text.is_empty(), "turn {} produced assistant text", i + 1);
    }

    let conv = conversation_id.expect("a conversation_id was captured");
    println!("\n[live] back-and-forth complete on conversation_id={conv}");
}
