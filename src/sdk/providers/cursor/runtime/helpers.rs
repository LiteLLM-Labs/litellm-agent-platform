use reqwest::Method;
use serde_json::{json, Value};

use crate::sdk::agents::{
    responses::response_json, AgentRuntime, AgentSdkError, Lap, SessionContext,
};

pub(crate) fn run_id(raw: &Value) -> Option<String> {
    raw.get("run")
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .or_else(|| {
            raw.get("agent")
                .and_then(|value| value.get("latestRunId"))
                .and_then(Value::as_str)
        })
        .or_else(|| raw.get("latestRunId").and_then(Value::as_str))
        .map(str::to_owned)
}

pub(crate) fn prompt_from_events(events: &[Value]) -> Result<Value, AgentSdkError> {
    let mut text = Vec::new();
    for event in events {
        if event.get("type").and_then(Value::as_str) != Some("user.message") {
            continue;
        }
        let Some(content) = event.get("content").and_then(Value::as_array) else {
            continue;
        };
        for block in content {
            if block.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(value) = block.get("text").and_then(Value::as_str) {
                    text.push(value.to_owned());
                }
            }
        }
    }
    if text.is_empty() {
        return Err(AgentSdkError::InvalidRequest(
            "cursor runtime requires at least one user.message text block".to_owned(),
        ));
    }
    Ok(json!({ "text": text.join("\n\n") }))
}

pub(crate) fn agent_id_from_context(
    session_id: &str,
    context: Option<&SessionContext>,
) -> String {
    context
        .and_then(|context| context.agent_id.clone())
        .or_else(|| context.and_then(|context| context.provider_session_id.clone()))
        .unwrap_or_else(|| session_id.to_owned())
}

#[allow(dead_code)]
pub(super) fn cursor_agent_id(client: &Lap, session_id: &str) -> Result<String, AgentSdkError> {
    Ok(agent_id_from_context(
        session_id,
        client.context_for_session(session_id)?.as_ref(),
    ))
}

#[allow(dead_code)]
pub(super) async fn latest_run_id(client: &Lap, agent_id: &str) -> Result<String, AgentSdkError> {
    let response = client
        .request(
            AgentRuntime::Cursor,
            Method::GET,
            &format!("/v1/agents/{agent_id}"),
        )?
        .send()
        .await?;
    let raw = response_json(response).await?;
    run_id(&raw).ok_or(AgentSdkError::MissingField("latestRunId"))
}
