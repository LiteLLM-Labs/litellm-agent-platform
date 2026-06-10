use litellm_rust::sdk::agents::{
    AgentModel, AgentRuntime, CreateAgentParams, Lap, LapConfig, MANAGED_AGENTS_BETA,
};
use serde_json::json;
use wiremock::{
    matchers::{body_json, header, method, path},
    Mock, MockServer, ResponseTemplate,
};

#[tokio::test]
async fn claude_agent_create_strips_mcp_server_auth_from_agent_definition() {
    let server = MockServer::start().await;
    mount_mcp_agent_create(&server).await;

    let agent = create_mcp_agent(&server).await;

    assert_eq!(agent.id, "agent_mcp");
}

async fn mount_mcp_agent_create(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/v1/agents"))
        .and(header("x-api-key", "sk-ant-test"))
        .and(header("anthropic-beta", MANAGED_AGENTS_BETA))
        .and(body_json(json!({
            "name": "MCP Assistant",
            "model": "claude-opus-4-8",
            "system": "Use connected tools.",
            "tools": [{ "type": "mcp_toolset", "mcp_server_name": "gateway" }],
            "mcp_servers": [{ "type": "url", "name": "gateway", "url": "https://gateway.example.com/mcp" }]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "agent_mcp",
            "version": 1
        })))
        .mount(server)
        .await;
}

async fn create_mcp_agent(server: &MockServer) -> litellm_rust::sdk::agents::ManagedAgent {
    client(server)
        .beta()
        .agents()
        .create(CreateAgentParams {
            lap_agent_runtime: AgentRuntime::ClaudeManagedAgents,
            lap_provider_options: None,
            name: "MCP Assistant".to_owned(),
            model: AgentModel::from("claude-opus-4-8"),
            system: "Use connected tools.".to_owned(),
            description: None,
            tools: vec![json!({ "type": "mcp_toolset", "mcp_server_name": "gateway" })],
            mcp_servers: vec![json!({
                "type": "url",
                "name": "gateway",
                "url": "https://gateway.example.com/mcp",
                "authorization_token": "sk-local"
            })],
            env_vars: None,
            workspace: None,
            metadata: None,
        })
        .await
        .unwrap()
}

fn client(server: &MockServer) -> Lap {
    Lap::new(LapConfig {
        anthropic_api_key: Some("sk-ant-test".to_owned()),
        anthropic_base_url: server.uri(),
        ..LapConfig::default()
    })
}
