use serde_json::{json, Value};
use wiremock::{
    matchers::{header, method, path},
    Mock, MockServer, ResponseTemplate,
};

use super::super::{request_json, AppFixture};

pub async fn exercise_claude_gateway_mcp_vault(fixture: &AppFixture) {
    let anthropic = mock_anthropic_runtime().await;
    save_anthropic_credentials(fixture, &anthropic).await;
    let agent_id = create_gmail_agent(fixture).await;

    create_idle_runtime_session(fixture, &agent_id, "first").await;
    create_idle_runtime_session(fixture, &agent_id, "second").await;

    let requests = anthropic.received_requests().await.unwrap();
    let agent_bodies = request_bodies(&requests, "/v1/agents");
    assert_eq!(agent_bodies.len(), 2);
    assert_agent_mcp_body(&agent_bodies[0]);
    assert_vault_credential(&requests);
    assert_sessions_reuse_vault(&requests);
}

async fn save_anthropic_credentials(fixture: &AppFixture, anthropic: &MockServer) {
    request_json(
        fixture.app.clone(),
        "POST",
        "/api/providers/anthropic",
        Some(json!({ "api_key": "anthropic-test", "api_base": anthropic.uri() })),
    )
    .await;
}

async fn create_gmail_agent(fixture: &AppFixture) -> String {
    let agent = request_json(
        fixture.app.clone(),
        "POST",
        "/api/agents",
        Some(gmail_agent_body()),
    )
    .await;
    agent["id"].as_str().unwrap().to_owned()
}

fn gmail_agent_body() -> Value {
    json!({
        "name": "gmail-vault-agent",
        "owner_id": "user-1",
        "runtime": "claude_managed_agents",
        "model": "claude-sonnet-4-6",
        "system": "Use Gmail MCP tools.",
        "tools": [{ "type": "mcp_toolset", "mcp_server_name": "mcp_gmail" }],
        "config": {
            "runtime": "claude_managed_agents",
            "mcp_servers": [{
                "name": "mcp_gmail",
                "type": "url",
                "url": "https://backend.composio.dev/v3/mcp/${COMPOSIO_MCP_SERVER_ID}/mcp?user_id=${COMPOSIO_USER_ID}"
            }]
        }
    })
}

async fn create_idle_runtime_session(fixture: &AppFixture, agent_id: &str, title: &str) {
    request_json(
        fixture.app.clone(),
        "POST",
        "/session",
        Some(json!({
            "agent": agent_id,
            "agent_id": agent_id,
            "runtime": "claude_managed_agents",
            "title": title
        })),
    )
    .await;
}

fn assert_agent_mcp_body(body: &Value) {
    assert_eq!(
        body["mcp_servers"],
        json!([{ "name": "mcp_gmail", "type": "url", "url": "http://localhost/mcp_gmail/mcp" }])
    );
    assert!(body["mcp_servers"][0].get("authorization_token").is_none());
    let gmail_toolset = body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool.get("mcp_server_name").and_then(Value::as_str) == Some("mcp_gmail"))
        .unwrap();
    assert_eq!(
        gmail_toolset["default_config"]["permission_policy"],
        json!({ "type": "always_allow" })
    );
}

fn assert_vault_credential(requests: &[wiremock::Request]) {
    let credential_bodies = request_bodies(
        requests,
        "/v1/vaults/vault_111111111111111111111111/credentials",
    );
    assert_eq!(credential_bodies.len(), 1);
    assert_eq!(
        credential_bodies[0]["auth"],
        json!({
            "type": "static_bearer",
            "mcp_server_url": "http://localhost/mcp_gmail/mcp",
            "token": "sk-local"
        })
    );
}

fn assert_sessions_reuse_vault(requests: &[wiremock::Request]) {
    let session_bodies = request_bodies(requests, "/v1/sessions");
    assert_eq!(session_bodies.len(), 2);
    assert_eq!(
        session_bodies[0]["vault_ids"],
        json!(["vault_111111111111111111111111"])
    );
    assert_eq!(
        session_bodies[1]["vault_ids"],
        session_bodies[0]["vault_ids"]
    );
    assert_eq!(count_requests(requests, "/v1/vaults"), 1);
}

async fn mock_anthropic_runtime() -> MockServer {
    let anthropic = MockServer::start().await;
    mount_anthropic(
        &anthropic,
        "/v1/agents",
        json!({ "id": "ag_111111111111111111111111" }),
    )
    .await;
    mount_anthropic(
        &anthropic,
        "/v1/environments",
        json!({ "id": "env_111111111111111111111111" }),
    )
    .await;
    mount_anthropic(
        &anthropic,
        "/v1/vaults",
        json!({ "id": "vault_111111111111111111111111" }),
    )
    .await;
    mount_anthropic(
        &anthropic,
        "/v1/vaults/vault_111111111111111111111111/credentials",
        json!({ "id": "vcred_111111111111111111111111" }),
    )
    .await;
    mount_anthropic(
        &anthropic,
        "/v1/sessions",
        json!({ "id": "sesn_111111111111111111111111" }),
    )
    .await;
    anthropic
}

async fn mount_anthropic(server: &MockServer, route: &str, body: Value) {
    Mock::given(method("POST"))
        .and(path(route))
        .and(header("x-api-key", "anthropic-test"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(server)
        .await;
}

fn request_bodies(requests: &[wiremock::Request], request_path: &str) -> Vec<Value> {
    requests
        .iter()
        .filter(|request| request.url.path() == request_path)
        .map(|request| serde_json::from_slice(&request.body).unwrap())
        .collect()
}

fn count_requests(requests: &[wiremock::Request], request_path: &str) -> usize {
    requests
        .iter()
        .filter(|request| request.url.path() == request_path)
        .count()
}
