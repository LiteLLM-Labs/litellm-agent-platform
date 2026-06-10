use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;

use crate::{
    errors::GatewayError,
    proxy::{auth::master_key::require_any_gateway_key, state::AppState},
    sdk::{
        agents::{
            AgentRuntime, AgentSdkError, ListModelsParams, ModelInfo, ModelList,
            CLAUDE_MANAGED_AGENTS,
        },
        providers,
    },
};

const CLAUDE_AGENTS_LEGACY: &str = "claude_agents";

#[derive(Debug, Deserialize)]
pub struct ModelsQuery {
    runtime: Option<String>,
}

pub async fn models(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<ModelsQuery>,
) -> Result<Json<ModelList>, GatewayError> {
    require_any_gateway_key(&headers, &state)?;

    if let Some(runtime) = query
        .runtime
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return Ok(Json(runtime_models(&state, runtime).await?));
    }

    let data = state
        .config
        .model_list
        .iter()
        .map(|entry| ModelInfo {
            id: entry.model_name.clone(),
            object: "model".to_owned(),
            created: 0,
            owned_by: "litellm".to_owned(),
        })
        .collect();

    Ok(Json(ModelList {
        object: "list".to_owned(),
        data,
    }))
}

async fn runtime_models(state: &AppState, alias: &str) -> Result<ModelList, GatewayError> {
    if let Some(pool) = state.db.as_ref() {
        let resolved = crate::http::runtime_resolution::resolve_runtime(pool, state, alias).await?;
        let client = crate::http::sessions::lap_from_credential(&resolved)?;
        return client
            .beta()
            .models()
            .list(ListModelsParams {
                lap_agent_runtime: resolved.agent_runtime,
            })
            .await
            .map_err(model_discovery_error);
    }
    let runtime = static_runtime_for_alias(alias)?;
    Ok(ModelList::from_ids(
        runtime.default_model_ids().iter().copied(),
        alias,
    ))
}

fn static_runtime_for_alias(alias: &str) -> Result<AgentRuntime, GatewayError> {
    let alias = if alias == CLAUDE_AGENTS_LEGACY {
        CLAUDE_MANAGED_AGENTS
    } else {
        alias
    };

    let model_registry = providers::model_registry();
    if let Some(entry) = model_registry.entry_for_id(alias) {
        return Ok(entry.runtime);
    }

    let runtime_registry = providers::runtime_registry();
    if let Some(entry) = runtime_registry.entry_for_id(alias) {
        return Ok(entry.runtime);
    }

    Err(GatewayError::InvalidJsonMessage(format!(
        "unsupported runtime: {alias}"
    )))
}

fn model_discovery_error(error: AgentSdkError) -> GatewayError {
    match error {
        AgentSdkError::Provider { status, body } => GatewayError::SandboxError(format!(
            "managed agent provider request failed with status {status}: {body}"
        )),
        other => GatewayError::SandboxError(other.to_string()),
    }
}
