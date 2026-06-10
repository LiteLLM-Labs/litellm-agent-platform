#[path = "managed_agents_support/sdk.rs"]
mod sdk_support;

mod managed_agents_sdk {
    pub mod gemini;
}

use litellm_rust::sdk::agents::{parse_sse, AgentEventKind, AgentEventPayload, AgentRuntime};
use serde_json::json;
use wiremock::MockServer;

#[tokio::test]
async fn creates_claude_managed_agent_with_anthropic_shape() {
    let server = MockServer::start().await;
    sdk_support::mount_claude_agent_create(&server).await;

    let agent = sdk_support::create_claude_agent(&server).await;

    assert_eq!(agent.id, "agent_123");
    assert_eq!(agent.version, Some(1));
}

#[tokio::test]
async fn creates_session_and_sends_events_with_runtime_ids() {
    let server = MockServer::start().await;
    sdk_support::mount_session_round_trip(&server).await;

    let (session, sent) = sdk_support::create_session_and_send_events(&server).await;

    assert_eq!(session.id, "sesn_123");
    assert_eq!(sent.raw, json!({ "data": [] }));
}

#[tokio::test]
async fn registered_claude_session_uses_provider_session_id() {
    let server = MockServer::start().await;
    sdk_support::mount_registered_claude_session_send(&server).await;

    let sent = sdk_support::register_claude_session_and_send_events(&server).await;

    assert_eq!(sent.raw, json!({ "data": [] }));
}

#[tokio::test]
async fn streams_session_events() {
    let server = MockServer::start().await;
    sdk_support::mount_session_stream(&server).await;

    let events = sdk_support::stream_mock_session_events(&server, "sesn_123").await;

    assert_eq!(events[0].kind(), AgentEventKind::AgentMessage);
    let AgentEventPayload::AgentMessage(message) = events[0].payload() else {
        panic!("expected agent message payload");
    };
    assert_eq!(message.content[0]["text"], "hello");
    assert_eq!(events[1].kind(), AgentEventKind::SessionStatusIdle);
}

#[test]
fn parses_sse_and_resolves_supported_runtimes() {
    let events = parse_sse(
        "event: agent.message\n\
         data: {\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}\n\n",
    )
    .unwrap();

    assert_eq!(events[0].event_type, "agent.message");
    assert_eq!(
        AgentRuntime::try_from("cursor").unwrap(),
        AgentRuntime::Cursor
    );
    assert_eq!(
        AgentRuntime::try_from("gemini_antigravity").unwrap(),
        AgentRuntime::GeminiAntigravity
    );
    let catalog_ids: Vec<_> = AgentRuntime::catalog()
        .iter()
        .map(|entry| entry.id)
        .collect();
    assert_eq!(
        catalog_ids,
        vec!["claude_managed_agents", "cursor", "gemini_antigravity"]
    );
    assert!(AgentRuntime::try_from("opencode").is_err());
    assert!(AgentRuntime::try_from("not-a-runtime").is_err());
}

#[tokio::test]
async fn cursor_provider_stream_conforms_to_anthropic_reference_events() {
    let server = MockServer::start().await;
    sdk_support::mount_cursor_stream_conformance(&server).await;

    let (client, session) = sdk_support::create_cursor_session(&server).await;
    assert_eq!(session.id, sdk_support::CURSOR_AGENT_ID);

    let initial_events = sdk_support::stream_session_events(&client, &session.id).await;
    sdk_support::assert_initial_cursor_stream(&initial_events);

    sdk_support::register_cursor_session(&client, session.id);
    sdk_support::send_cursor_prompt(&client).await;

    let events =
        sdk_support::stream_session_events(&client, sdk_support::LAP_CURSOR_SESSION_ID).await;
    sdk_support::assert_cursor_events_match_reference(&events);
}
