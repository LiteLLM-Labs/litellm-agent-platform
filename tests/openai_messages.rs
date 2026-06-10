use std::{collections::HashMap, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    response::Response,
    Router,
};
use litellm_rust::{
    http::routes::router,
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
use wiremock::{
    matchers::{header as header_match, method, path},
    Mock, MockServer, ResponseTemplate,
};

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

fn openai_gpt_entry(api_base: String) -> ModelEntry {
    ModelEntry {
        model_name: "gpt-5.5".to_owned(),
        litellm_params: LiteLlmParams {
            model: "openai/gpt-5.5".to_owned(),
            api_key: Some("sk-openai-test".to_owned()),
            api_base: Some(api_base),
            extra: Default::default(),
        },
    }
}

fn openai_messages_app(upstream: &MockServer) -> Router {
    let config = config_with_models(vec![openai_gpt_entry(upstream.uri())]);
    router(build_state(&config))
}

async fn post_messages(app: Router, payload: Value) -> Response {
    app.oneshot(
        Request::builder()
            .method("POST")
            .uri("/v1/messages")
            .header(header::AUTHORIZATION, "Bearer sk-local")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(payload.to_string()))
            .unwrap(),
    )
    .await
    .unwrap()
}

async fn mount_openai_json_response(upstream: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/v1/responses"))
        .and(header_match("authorization", "Bearer sk-openai-test"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "resp_test",
            "object": "response",
            "status": "completed",
            "model": "gpt-5.5",
            "output_text": "openai ok",
            "output": [],
            "usage": {"input_tokens": 4, "output_tokens": 2, "total_tokens": 6}
        })))
        .mount(upstream)
        .await;
}

async fn assert_openai_json_upstream_request(upstream: &MockServer) {
    let requests = upstream.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(body["model"], "gpt-5.5");
    assert_eq!(body["max_output_tokens"], 16);
    assert_eq!(body["input"][0]["role"], "system");
    assert_eq!(body["input"][0]["content"], "Be brief.");
    assert_eq!(body["input"][1]["role"], "user");
    assert_eq!(body["input"][1]["content"], "hi");
}

async fn mount_openai_stream_response(upstream: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/v1/responses"))
        .and(header_match("authorization", "Bearer sk-openai-test"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(openai_stream_body()),
        )
        .mount(upstream)
        .await;
}

fn openai_stream_body() -> String {
    [
        "event: response.output_text.delta",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"stream ok\"}",
        "",
        "event: response.completed",
        "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_stream\",\"model\":\"gpt-5.5\",\"output_text\":\"stream ok\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2,\"total_tokens\":5}}}",
        "",
        "data: [DONE]",
        "",
    ]
    .join("\n")
}

fn build_router(config: &GatewayConfig) -> ModelRouter {
    let mut providers = ProviderRegistry::new();
    providers::register_all(&mut providers);
    ModelRouter::from_config(config, &providers).unwrap()
}

fn build_state(config: &GatewayConfig) -> Arc<AppState> {
    let http = AppState::build_http_client().unwrap();
    Arc::new(
        AppState::new(
            config.clone(),
            build_router(config),
            http,
            HashMap::new(),
            None,
        )
        .unwrap(),
    )
}

#[tokio::test]
async fn openai_model_on_messages_uses_responses_endpoint() {
    let upstream = MockServer::start().await;
    mount_openai_json_response(&upstream).await;
    let response = post_messages(
        openai_messages_app(&upstream),
        json!({
            "model": "gpt-5.5",
            "system": "Be brief.",
            "max_tokens": 16,
            "messages": [{"role": "user", "content": "hi"}]
        }),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["type"], "message");
    assert_eq!(body["role"], "assistant");
    assert_eq!(body["content"][0]["text"], "openai ok");
    assert_eq!(body["usage"]["input_tokens"], 4);
    assert_eq!(body["usage"]["output_tokens"], 2);
    assert_openai_json_upstream_request(&upstream).await;
}

#[tokio::test]
async fn openai_model_on_streaming_messages_returns_anthropic_sse() {
    let upstream = MockServer::start().await;
    mount_openai_stream_response(&upstream).await;
    let response = post_messages(
        openai_messages_app(&upstream),
        json!({
            "model": "gpt-5.5",
            "max_tokens": 16,
            "stream": true,
            "messages": [{"role": "user", "content": "hi"}]
        }),
    )
    .await;

    assert_eq!(response.status(), StatusCode::OK);
    let content_type = response.headers().get(header::CONTENT_TYPE).cloned();
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    assert_eq!(content_type.as_ref().unwrap(), "text/event-stream");
    let body = std::str::from_utf8(&body).unwrap();
    assert!(body.contains("event: message_start"));
    assert!(body.contains("event: content_block_delta"));
    assert!(body.contains("stream ok"));
    assert!(body.contains("event: message_stop"));
    assert_openai_stream_upstream_request(&upstream).await;
}

async fn assert_openai_stream_upstream_request(upstream: &MockServer) {
    let requests = upstream.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(body["stream"], true);
}
