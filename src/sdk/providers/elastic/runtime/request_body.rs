use serde_json::{json, Map, Value};

use crate::sdk::agents::AgentSdkError;

/// Streaming converse path on the Kibana Agent Builder API.
const CONVERSE_ASYNC_SUFFIX: &str = "/api/agent_builder/converse/async";

/// A Kibana space that does not require a `/s/<space>` URL prefix.
fn is_default_space(space: Option<&str>) -> bool {
    matches!(space.map(str::trim), None | Some("") | Some("default"))
}

/// Resolved Elastic binding for a LAP session. Serialized into the session's
/// `provider_session_id` so it survives across turns (and processes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ElasticBinding {
    pub(crate) agent_id: String,
    pub(crate) space: Option<String>,
    pub(crate) connector_id: Option<String>,
}

impl ElasticBinding {
    /// Resolve the binding from per-agent provider options, falling back to the
    /// runtime-level default Elastic agent ID when the agent omits its own.
    pub(crate) fn resolve(
        options: Option<&Value>,
        default_agent_id: Option<String>,
    ) -> Result<Self, AgentSdkError> {
        let agent_id = options
            .and_then(|opts| {
                opts.get("elastic_agent_id")
                    .or_else(|| opts.get("elasticAgentId"))
            })
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .or(default_agent_id)
            .ok_or_else(|| {
                AgentSdkError::InvalidRequest(
                    "elastic_agent_builder requires an elastic_agent_id on the agent config or a \
                     runtime-level default Elastic agent ID"
                        .to_owned(),
                )
            })?;
        let space = options
            .and_then(|opts| {
                opts.get("elastic_space_id")
                    .or_else(|| opts.get("elasticSpaceId"))
            })
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let connector_id = options
            .and_then(|opts| {
                opts.get("elastic_connector_id")
                    .or_else(|| opts.get("elasticConnectorId"))
            })
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        Ok(Self {
            agent_id,
            space,
            connector_id,
        })
    }

    pub(crate) fn encode(&self) -> String {
        let mut map = Map::new();
        map.insert("agent_id".to_owned(), Value::String(self.agent_id.clone()));
        if let Some(space) = &self.space {
            map.insert("space".to_owned(), Value::String(space.clone()));
        }
        if let Some(connector_id) = &self.connector_id {
            map.insert(
                "connector_id".to_owned(),
                Value::String(connector_id.clone()),
            );
        }
        Value::Object(map).to_string()
    }

    /// Parse an encoded binding. A bare (non-JSON) value is treated as the agent
    /// ID so older rows or manual configuration still resolve.
    pub(crate) fn decode(encoded: &str) -> Self {
        match serde_json::from_str::<Value>(encoded) {
            Ok(Value::Object(map)) => Self {
                agent_id: map
                    .get("agent_id")
                    .and_then(Value::as_str)
                    .unwrap_or(encoded)
                    .to_owned(),
                space: map
                    .get("space")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                connector_id: map
                    .get("connector_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            },
            _ => Self {
                agent_id: encoded.to_owned(),
                space: None,
                connector_id: None,
            },
        }
    }

    pub(crate) fn converse_path(&self) -> String {
        if is_default_space(self.space.as_deref()) {
            CONVERSE_ASYNC_SUFFIX.to_owned()
        } else {
            let space = self.space.as_deref().unwrap_or_default();
            format!("/s/{space}{CONVERSE_ASYNC_SUFFIX}")
        }
    }

    pub(crate) fn converse_body(&self, input: &str, conversation_id: Option<&str>) -> Value {
        let mut body = Map::new();
        body.insert("agent_id".to_owned(), Value::String(self.agent_id.clone()));
        body.insert("input".to_owned(), Value::String(input.to_owned()));
        if let Some(conversation_id) = conversation_id {
            body.insert(
                "conversation_id".to_owned(),
                Value::String(conversation_id.to_owned()),
            );
        }
        if let Some(connector_id) = &self.connector_id {
            body.insert(
                "connector_id".to_owned(),
                Value::String(connector_id.clone()),
            );
        }
        Value::Object(body)
    }
}

/// Pull the latest user-message text out of LAP `user.message` events.
pub(crate) fn prompt_from_events(events: &[Value]) -> Result<String, AgentSdkError> {
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
            "elastic_agent_builder runtime requires at least one user.message text block"
                .to_owned(),
        ));
    }
    Ok(text.join("\n\n"))
}

/// Synthetic send-response used to drive the shared runtime loop: the real
/// converse call happens during streaming, so the send phase only reports that
/// a turn is running and echoes the known conversation ID (if any).
pub(crate) fn pending_send_raw(conversation_id: Option<&str>) -> Value {
    json!({
        "status": "running",
        "provider_run_id": conversation_id.unwrap_or(super::PENDING_RUN_MARKER),
    })
}
