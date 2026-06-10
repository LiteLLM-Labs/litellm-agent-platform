use serde_json::json;

use super::{anthropic_v1_base, gateway_mcp_credentials};
use crate::{
    agents::config::E2bSandboxParams,
    proxy::{
        config::{GatewayConfig, GeneralSettings},
        state::AppState,
    },
    sdk::{providers::ProviderRegistry, routing::Router as ModelRouter},
};

#[test]
fn collects_gateway_mcp_credentials() {
    let state = state("https://gateway.example.com", Some("sk-master"));
    let credentials = gateway_mcp_credentials(
        &state,
        &[
            json!({
                "name": "gmail",
                "url": "https://gateway.example.com/mcp_gmail/mcp",
                "authorization_token": "sk-scoped"
            }),
            json!({
                "name": "platform",
                "url": "https://gateway.example.com/mcp/platform/agent_1?session_id=ses_1"
            }),
            json!({
                "name": "external",
                "url": "https://mcp.example.com/mcp",
                "authorization_token": "external-token"
            }),
        ],
    );

    assert_eq!(credentials.len(), 2);
    assert_eq!(
        credentials[0].url,
        "https://gateway.example.com/mcp/platform/agent_1?session_id=ses_1"
    );
    assert_eq!(credentials[0].token, "sk-master");
    assert_eq!(
        credentials[1].url,
        "https://gateway.example.com/mcp_gmail/mcp"
    );
    assert_eq!(credentials[1].token, "sk-scoped");
}

#[test]
fn normalizes_anthropic_v1_base() {
    assert_eq!(
        anthropic_v1_base("https://api.anthropic.com"),
        "https://api.anthropic.com/v1"
    );
    assert_eq!(
        anthropic_v1_base("https://api.anthropic.com/v1/"),
        "https://api.anthropic.com/v1"
    );
}

fn state(proxy_base_url: &str, master_key: Option<&str>) -> AppState {
    let config = config(proxy_base_url, master_key);
    let router = ModelRouter::from_config(&empty_config(), &ProviderRegistry::new()).unwrap();
    AppState::new(
        config,
        router,
        AppState::build_http_client().unwrap(),
        Default::default(),
        None,
    )
    .unwrap()
}

fn config(proxy_base_url: &str, master_key: Option<&str>) -> GatewayConfig {
    GatewayConfig {
        model_list: Vec::new(),
        mcp_servers: Default::default(),
        general_settings: GeneralSettings {
            master_key: master_key.map(str::to_owned),
            public_base_url: Some(proxy_base_url.to_owned()),
            e2b_sandbox_params: E2bSandboxParams {
                e2b_api_key: None,
                e2b_template: "litellm-4gb".to_owned(),
                timeout_seconds: 1800,
                workspace_dir: "/workspace".to_owned(),
                e2b_api_base: "https://e2b.example.com".to_owned(),
                envs: Default::default(),
            },
            ..Default::default()
        },
        slack: Default::default(),
        agents: Vec::new(),
    }
}

fn empty_config() -> GatewayConfig {
    GatewayConfig {
        model_list: Vec::new(),
        mcp_servers: Default::default(),
        general_settings: GeneralSettings::default(),
        slack: Default::default(),
        agents: Vec::new(),
    }
}
