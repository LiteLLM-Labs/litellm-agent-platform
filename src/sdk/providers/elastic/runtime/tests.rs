use futures_util::{stream, StreamExt};
use serde_json::{json, Value};

use super::request_body::{prompt_from_events, ElasticBinding};
use super::stream::normalize_elastic_stream;
use crate::sdk::agents::{AgentEvent, AgentEventStream, AgentSdkError};

fn binding(space: Option<&str>, connector: Option<&str>) -> ElasticBinding {
    ElasticBinding {
        agent_id: "elastic-ai-agent".to_owned(),
        space: space.map(str::to_owned),
        connector_id: connector.map(str::to_owned),
    }
}

#[test]
fn converse_path_handles_default_space() {
    assert_eq!(
        binding(None, None).converse_path(),
        "/api/agent_builder/converse/async"
    );
    assert_eq!(
        binding(Some("default"), None).converse_path(),
        "/api/agent_builder/converse/async"
    );
}

#[test]
fn converse_path_handles_custom_space() {
    assert_eq!(
        binding(Some("marketing"), None).converse_path(),
        "/s/marketing/api/agent_builder/converse/async"
    );
}

#[test]
fn converse_body_includes_agent_input_and_optional_fields() {
    let body = binding(None, Some("openai-connector")).converse_body("hi there", Some("conv-1"));
    assert_eq!(body["agent_id"], json!("elastic-ai-agent"));
    assert_eq!(body["input"], json!("hi there"));
    assert_eq!(body["conversation_id"], json!("conv-1"));
    assert_eq!(body["connector_id"], json!("openai-connector"));

    let first = binding(None, None).converse_body("hi", None);
    assert!(first.get("conversation_id").is_none());
    assert!(first.get("connector_id").is_none());
}

#[test]
fn resolve_prefers_agent_config_then_default() {
    let opts = json!({
        "elastic_agent_id": "agent-from-config",
        "elastic_space_id": "ops",
        "elastic_connector_id": "conn-1"
    });
    let resolved =
        ElasticBinding::resolve(Some(&opts), Some("default-agent".to_owned())).unwrap();
    assert_eq!(resolved.agent_id, "agent-from-config");
    assert_eq!(resolved.space.as_deref(), Some("ops"));
    assert_eq!(resolved.connector_id.as_deref(), Some("conn-1"));

    let fallback = ElasticBinding::resolve(Some(&json!({})), Some("default-agent".to_owned()))
        .unwrap();
    assert_eq!(fallback.agent_id, "default-agent");
}

#[test]
fn resolve_errors_when_no_agent_id() {
    let err = ElasticBinding::resolve(Some(&json!({})), None).unwrap_err();
    assert!(matches!(err, AgentSdkError::InvalidRequest(_)));
}

#[test]
fn binding_encode_decode_roundtrip() {
    let original = binding(Some("ops"), Some("conn-1"));
    let decoded = ElasticBinding::decode(&original.encode());
    assert_eq!(original, decoded);

    // Bare values degrade to a plain agent id.
    let bare = ElasticBinding::decode("just-an-agent");
    assert_eq!(bare.agent_id, "just-an-agent");
    assert!(bare.space.is_none());
}

#[test]
fn prompt_from_events_extracts_latest_text() {
    let events = vec![json!({
        "type": "user.message",
        "content": [{ "type": "text", "text": "Hello Elastic" }]
    })];
    assert_eq!(prompt_from_events(&events).unwrap(), "Hello Elastic");

    let empty: Vec<Value> = vec![json!({ "type": "session.status_running" })];
    assert!(prompt_from_events(&empty).is_err());
}

fn event(value: Value) -> AgentEvent {
    serde_json::from_value(value).unwrap()
}

fn source_stream(events: Vec<AgentEvent>) -> AgentEventStream {
    Box::pin(stream::iter(
        events.into_iter().map(Ok::<_, AgentSdkError>),
    ))
}

async fn collect(stream: AgentEventStream) -> Vec<AgentEvent> {
    stream
        .map(|event| event.unwrap())
        .collect::<Vec<_>>()
        .await
}

#[tokio::test]
async fn normalizes_elastic_events_and_captures_conversation_id() {
    let raw = vec![
        event(json!({ "type": "conversation_created", "conversation_id": "conv-42" })),
        event(json!({ "type": "reasoning", "reasoning": "thinking" })),
        event(json!({
            "type": "tool_call",
            "tool_call_id": "call-1",
            "tool_id": "search",
            "params": { "q": "elastic" }
        })),
        event(json!({
            "type": "tool_result",
            "tool_call_id": "call-1",
            "results": "hit"
        })),
        event(json!({ "type": "message_chunk", "text_chunk": "Hello " })),
        event(json!({ "type": "message_chunk", "text_chunk": "world" })),
        event(json!({ "type": "round_complete" })),
    ];

    let events = collect(normalize_elastic_stream(source_stream(raw))).await;
    let types: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();

    assert_eq!(
        types,
        vec![
            "session.status_running",
            "agent.thinking",
            "agent.tool_use",
            "agent.tool_result",
            "agent.message",
            "session.status_idle",
        ]
    );

    // conversation_id surfaces as provider_run_id for persistence.
    let idle = events
        .iter()
        .find(|e| e.event_type == "session.status_idle")
        .unwrap();
    assert_eq!(idle.data["provider_run_id"], json!("conv-42"));

    let message = events
        .iter()
        .find(|e| e.event_type == "agent.message")
        .unwrap();
    assert_eq!(
        message.data["content"],
        json!([{ "type": "text", "text": "Hello world" }])
    );

    let tool_use = events
        .iter()
        .find(|e| e.event_type == "agent.tool_use")
        .unwrap();
    assert_eq!(tool_use.data["id"], json!("call-1"));
    assert_eq!(tool_use.data["name"], json!("search"));
}

#[tokio::test]
async fn emits_idle_when_stream_ends_without_round_complete() {
    let raw = vec![
        event(json!({ "type": "conversation_created", "conversation_id": "conv-7" })),
        event(json!({ "type": "message_chunk", "text_chunk": "done" })),
    ];
    let events = collect(normalize_elastic_stream(source_stream(raw))).await;
    let types: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();
    assert_eq!(
        types,
        vec!["session.status_running", "agent.message", "session.status_idle"]
    );
}

#[tokio::test]
async fn maps_error_events() {
    let raw = vec![event(json!({
        "type": "error",
        "error": { "message": "boom" }
    }))];
    let events = collect(normalize_elastic_stream(source_stream(raw))).await;
    assert_eq!(events.last().unwrap().event_type, "session.error");
    assert_eq!(
        events.last().unwrap().data["error"]["message"],
        json!("boom")
    );
}
