use axum::http::{HeaderMap, StatusCode};
use serde_json::Value;

use crate::{
    errors::GatewayError,
    sdk::{
        providers::base::{
            anthropic_messages::BaseAnthropicMessagesTransformation,
            openai_responses::BaseOpenAiResponsesTransformation, ProviderRequest,
        },
        providers::openai::openai_responses::transformation::OpenAiResponsesTransformation,
        routing::Deployment,
    },
};

use super::translation;

impl BaseAnthropicMessagesTransformation for OpenAiResponsesTransformation {
    fn map_anthropic_messages_params(
        &self,
        body: Value,
        deployment: &Deployment,
    ) -> Result<Value, GatewayError> {
        Ok(translation::anthropic_messages_to_openai_responses(
            body, deployment,
        ))
    }

    fn validate_environment(
        &self,
        deployment: &Deployment,
        inbound_headers: &HeaderMap,
    ) -> Result<HeaderMap, GatewayError> {
        BaseOpenAiResponsesTransformation::validate_environment(self, deployment, inbound_headers)
    }

    fn upstream_request_id_header(&self) -> &'static str {
        "x-request-id"
    }
}

pub(crate) fn messages_url(deployment: &Deployment) -> String {
    deployment.responses_url()
}

pub(crate) fn transform_request(
    transformer: &OpenAiResponsesTransformation,
    body: Value,
    deployment: &Deployment,
    inbound_headers: &HeaderMap,
) -> Result<ProviderRequest, GatewayError>
{
    transformer.transform_anthropic_messages_request(body, deployment, inbound_headers)
}

pub(crate) fn transform_response_headers(
    transformer: &OpenAiResponsesTransformation,
    upstream: &HeaderMap,
    stream: bool,
) -> HeaderMap
{
    transformer.transform_anthropic_messages_response_headers(upstream, stream)
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
