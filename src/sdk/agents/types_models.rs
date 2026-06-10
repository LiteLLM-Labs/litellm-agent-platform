use serde::Serialize;
use serde_json::Value;

use super::AgentRuntime;

#[derive(Debug, Clone, Serialize)]
pub struct ListModelsParams {
    #[serde(skip)]
    pub lap_agent_runtime: AgentRuntime,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub object: String,
    pub created: i64,
    pub owned_by: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelList {
    pub object: String,
    pub data: Vec<ModelInfo>,
}

impl ModelList {
    pub fn from_ids<I, S>(ids: I, owned_by: impl Into<String>) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let owned_by = owned_by.into();
        Self {
            object: "list".to_owned(),
            data: ids
                .into_iter()
                .map(|id| ModelInfo {
                    id: id.into(),
                    object: "model".to_owned(),
                    created: 0,
                    owned_by: owned_by.clone(),
                })
                .collect(),
        }
    }

    pub fn from_provider_value(raw: Value, owned_by: impl Into<String>) -> Option<Self> {
        let owned_by = owned_by.into();
        let items = raw
            .get("data")
            .and_then(Value::as_array)
            .or_else(|| raw.get("models").and_then(Value::as_array))?;
        let data = items
            .iter()
            .filter_map(|item| model_info(item, &owned_by))
            .collect::<Vec<_>>();
        Some(Self {
            object: "list".to_owned(),
            data,
        })
    }
}

fn model_info(item: &Value, default_owner: &str) -> Option<ModelInfo> {
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| item.get("name").and_then(Value::as_str))
        .map(|id| id.strip_prefix("models/").unwrap_or(id).to_owned())?;
    Some(ModelInfo {
        id,
        object: "model".to_owned(),
        created: item.get("created").and_then(Value::as_i64).unwrap_or(0),
        owned_by: item
            .get("owned_by")
            .and_then(Value::as_str)
            .unwrap_or(default_owner)
            .to_owned(),
    })
}
