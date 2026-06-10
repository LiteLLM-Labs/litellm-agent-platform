use std::{collections::HashMap, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    Router,
};
use litellm_rust::{
    http::routes::router,
    model_prices::ModelCostMap,
    proxy::{
        config::{GatewayConfig, GeneralSettings, LiteLlmParams, ModelEntry},
        state::AppState,
    },
    sdk::{
        providers::{self, ProviderRegistry},
        routing::Router as ModelRouter,
    },
};
use serde_json::{json, Value};
use tower::util::ServiceExt;

fn config_with_models(model_list: Vec<ModelEntry>) -> GatewayConfig {
    GatewayConfig {
        model_list,
        mcp_servers: Default::default(),
        general_settings: GeneralSettings {
            master_key: Some("sk-local".to_owned()),
            ..Default::default()
        },
        slack: Default::default(),
        agents: Vec::new(),
    }
}

fn test_config() -> GatewayConfig {
    config_with_models(vec![ModelEntry {
        model_name: "claude".to_owned(),
        litellm_params: LiteLlmParams {
            model: "anthropic/claude-sonnet-4-5".to_owned(),
            api_key: Some("sk-ant-test".to_owned()),
            api_base: Some("https://api.anthropic.com".to_owned()),
            extra: Default::default(),
        },
    }])
}

fn test_model_cost_map() -> ModelCostMap {
    serde_json::from_value(json!({
        "claude-sonnet-4-6": {"litellm_provider": "anthropic", "mode": "chat"},
        "claude-3-haiku-20240307": {"litellm_provider": "anthropic", "mode": "chat"},
        "gpt-5.5": {"litellm_provider": "openai", "mode": "chat"}
    }))
    .unwrap()
}

fn wildcard_anthropic_entry(api_key: Option<&str>) -> ModelEntry {
    ModelEntry {
        model_name: "anthropic/*".to_owned(),
        litellm_params: LiteLlmParams {
            model: "anthropic/*".to_owned(),
            api_key: api_key.map(str::to_owned),
            api_base: Some("https://api.anthropic.com".to_owned()),
            extra: Default::default(),
        },
    }
}

fn openai_gpt_entry(api_key: Option<&str>) -> ModelEntry {
    ModelEntry {
        model_name: "gpt-5.5".to_owned(),
        litellm_params: LiteLlmParams {
            model: "openai/gpt-5.5".to_owned(),
            api_key: api_key.map(str::to_owned),
            api_base: Some("https://api.openai.com".to_owned()),
            extra: Default::default(),
        },
    }
}

async fn get_json(app: Router, uri: &str, expected: StatusCode) -> Value {
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .header(header::AUTHORIZATION, "Bearer sk-local")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), expected);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

fn response_model_ids(body: &Value) -> Vec<String> {
    body["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["id"].as_str().unwrap().to_owned())
        .collect()
}

fn build_router(config: &GatewayConfig) -> ModelRouter {
    let mut providers = ProviderRegistry::new();
    providers::register_all(&mut providers);
    ModelRouter::from_config(config, &providers).unwrap()
}

fn build_state(config: &GatewayConfig) -> Arc<AppState> {
    build_state_with_model_cost_map(config, HashMap::new())
}

fn build_state_with_model_cost_map(
    config: &GatewayConfig,
    model_cost_map: ModelCostMap,
) -> Arc<AppState> {
    let http = AppState::build_http_client().unwrap();
    Arc::new(
        AppState::new(
            config.clone(),
            build_router(config),
            http,
            model_cost_map,
            None,
        )
        .unwrap(),
    )
}

#[tokio::test]
async fn lists_configured_models_with_openai_shape() {
    let body = get_json(
        router(build_state(&test_config())),
        "/v1/models",
        StatusCode::OK,
    )
    .await;
    assert_eq!(body["object"], "list");
    assert_eq!(body["data"][0]["id"], "claude");
    assert_eq!(body["data"][0]["object"], "model");
    assert_eq!(body["data"][0]["created"], 0);
    assert_eq!(body["data"][0]["owned_by"], "anthropic");
}

#[tokio::test]
async fn expands_wildcard_models_from_model_cost_map() {
    let config = config_with_models(vec![wildcard_anthropic_entry(Some("sk-ant-test"))]);
    let app = router(build_state_with_model_cost_map(
        &config,
        test_model_cost_map(),
    ));
    let body = get_json(app, "/v1/models", StatusCode::OK).await;
    assert_eq!(body["object"], "list");
    assert_eq!(
        response_model_ids(&body),
        vec!["claude-3-haiku-20240307", "claude-sonnet-4-6"]
    );
    assert_eq!(body["data"][0]["owned_by"], "anthropic");
}

#[tokio::test]
async fn lists_exact_models_without_provider_credentials() {
    let config = config_with_models(vec![
        wildcard_anthropic_entry(Some("sk-ant-test")),
        openai_gpt_entry(None),
    ]);
    let app = router(build_state_with_model_cost_map(
        &config,
        test_model_cost_map(),
    ));
    let body = get_json(app, "/v1/models", StatusCode::OK).await;
    assert_eq!(
        response_model_ids(&body),
        vec!["claude-3-haiku-20240307", "claude-sonnet-4-6", "gpt-5.5"]
    );
}

#[tokio::test]
async fn provider_response_includes_configured_model_sources() {
    let config = config_with_models(vec![
        wildcard_anthropic_entry(Some("sk-ant-test")),
        openai_gpt_entry(None),
    ]);
    let app = router(build_state_with_model_cost_map(
        &config,
        test_model_cost_map(),
    ));
    let body = get_json(app, "/api/providers", StatusCode::OK).await;
    let models = body["configured_models"].as_array().unwrap();
    assert_eq!(models.len(), 3);
    assert_eq!(models[0]["id"], "claude-3-haiku-20240307");
    assert_eq!(models[0]["provider_id"], "anthropic");
    assert_eq!(models[0]["source"], "config.yaml");
    assert_eq!(models[0]["configured_model"], "anthropic/*");
    assert_eq!(models[0]["source_detail"], "expanded from anthropic/*");
    assert_eq!(models[2]["id"], "gpt-5.5");
    assert_eq!(models[2]["provider_id"], "openai");
    assert_eq!(models[2]["source"], "config.yaml");
    assert_eq!(models[2]["source_detail"], "model_list entry");
}

#[tokio::test]
async fn rejects_runtime_models_without_database() {
    let app = router(build_state(&test_config()));
    let body = get_json(
        app,
        "/v1/models?runtime=cursor",
        StatusCode::SERVICE_UNAVAILABLE,
    )
    .await;
    assert_eq!(body["error"]["message"], "database is not configured");
}

#[tokio::test]
async fn rejects_unknown_runtime_models_without_database() {
    let app = router(build_state(&test_config()));
    let body = get_json(app, "/v1/models?runtime=unknown", StatusCode::BAD_REQUEST).await;
    assert_eq!(
        body["error"]["message"],
        "invalid request json: unsupported runtime: unknown"
    );
}
