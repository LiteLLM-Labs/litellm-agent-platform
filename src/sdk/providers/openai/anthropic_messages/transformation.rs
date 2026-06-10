use axum::http::{HeaderMap, StatusCode};
use serde_json::Value;

use crate::{
    errors::GatewayError,
    sdk::{
        providers::base::{openai_responses::BaseOpenAiResponsesTransformation, ProviderRequest},
        routing::Deployment,
    },
};

use super::translation;

pub(crate) fn messages_url(deployment: &Deployment) -> String {
    deployment.responses_url()
}

pub(crate) fn transform_request<T>(
    transformer: &T,
    body: Value,
    deployment: &Deployment,
    inbound_headers: &HeaderMap,
) -> Result<ProviderRequest, GatewayError>
where
    T: BaseOpenAiResponsesTransformation,
{
    transformer.transform_openai_responses_request(
        translation::anthropic_messages_to_openai_responses(body, deployment),
        deployment,
        inbound_headers,
    )
}

pub(crate) fn transform_response_headers<T>(
    transformer: &T,
    upstream: &HeaderMap,
    stream: bool,
) -> HeaderMap
where
    T: BaseOpenAiResponsesTransformation,
{
    transformer.transform_openai_responses_response_headers(upstream, stream)
}

pub(crate) fn transform_response_body(
    body: Vec<u8>,
    status: StatusCode,
    stream: bool,
    deployment: &Deployment,
    content_type: Option<&str>,
) -> Result<Vec<u8>, GatewayError> {
    if !status.is_success() {
        return Ok(body);
    }
    if stream {
        return Ok(translation::openai_response_to_anthropic_sse(
            &body,
            content_type,
            deployment,
        )?
        .into_bytes());
    }
    let raw: Value = serde_json::from_slice(&body)?;
    Ok(serde_json::to_vec(
        &translation::openai_response_to_anthropic_message(&raw, deployment),
    )?)
}
