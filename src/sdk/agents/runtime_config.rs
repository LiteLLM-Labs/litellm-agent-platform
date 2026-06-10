use std::collections::HashMap;

use reqwest::RequestBuilder;

use super::types::{
    AgentRuntime, LapConfig, ANTHROPIC_VERSION, GEMINI_API_REVISION, MANAGED_AGENTS_BETA,
};

#[derive(Debug, Clone)]
pub(super) struct RuntimeConfig {
    pub(super) base_url: String,
    auth: RuntimeAuth,
}

#[derive(Debug, Clone)]
enum RuntimeAuth {
    AnthropicApiKey(String),
    Bearer(String),
    GoogleApiKey(String),
    ElasticApiKey(String),
}

impl RuntimeConfig {
    pub(super) fn authorize(&self, request: RequestBuilder) -> RequestBuilder {
        match &self.auth {
            RuntimeAuth::AnthropicApiKey(api_key) => request
                .header("x-api-key", api_key)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .header("anthropic-beta", MANAGED_AGENTS_BETA),
            RuntimeAuth::Bearer(api_key) => request.bearer_auth(api_key),
            RuntimeAuth::GoogleApiKey(api_key) => request
                .header("x-goog-api-key", api_key)
                .header("Api-Revision", GEMINI_API_REVISION),
            // Kibana requires `Authorization: ApiKey <key>` plus the `kbn-xsrf`
            // header on every mutating request to the Agent Builder APIs.
            RuntimeAuth::ElasticApiKey(api_key) => request
                .header("Authorization", format!("ApiKey {api_key}"))
                .header("kbn-xsrf", "true"),
        }
    }
}

pub(super) fn runtime_configs(config: LapConfig) -> HashMap<AgentRuntime, RuntimeConfig> {
    let mut runtimes = HashMap::new();
    if let Some(api_key) = config.anthropic_api_key {
        runtimes.insert(
            AgentRuntime::ClaudeManagedAgents,
            RuntimeConfig {
                base_url: config.anthropic_base_url.trim_end_matches('/').to_owned(),
                auth: RuntimeAuth::AnthropicApiKey(api_key),
            },
        );
    }
    if let Some(api_key) = config.cursor_api_key {
        runtimes.insert(
            AgentRuntime::Cursor,
            RuntimeConfig {
                base_url: config.cursor_base_url.trim_end_matches('/').to_owned(),
                auth: RuntimeAuth::Bearer(api_key),
            },
        );
    }
    if let Some(api_key) = config.gemini_api_key {
        runtimes.insert(
            AgentRuntime::GeminiAntigravity,
            RuntimeConfig {
                base_url: config.gemini_base_url.trim_end_matches('/').to_owned(),
                auth: RuntimeAuth::GoogleApiKey(api_key),
            },
        );
    }
    if let Some(api_key) = config.elastic_api_key {
        runtimes.insert(
            AgentRuntime::ElasticAgentBuilder,
            RuntimeConfig {
                base_url: config.elastic_base_url.trim_end_matches('/').to_owned(),
                auth: RuntimeAuth::ElasticApiKey(api_key),
            },
        );
    }
    runtimes
}

pub(super) fn configured_http_client() -> reqwest::Client {
    reqwest::Client::new()
}
