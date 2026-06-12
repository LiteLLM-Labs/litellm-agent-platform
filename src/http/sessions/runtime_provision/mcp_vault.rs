use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};
use sqlx::PgPool;

use crate::{
    db::credentials,
    errors::GatewayError,
    proxy::state::AppState,
    sdk::agents::{AgentRuntime, ANTHROPIC_VERSION, MANAGED_AGENTS_BETA},
};

use super::CreatedRuntimeSession;

const STORE_PREFIX: &str = "anthropic-managed-agent-mcp-vault:";
const STORE_ACTOR: &str = "runtime_provision";

#[derive(Debug, Clone, PartialEq, Eq)]
struct McpVaultCredential {
    url: String,
    token: String,
}

#[derive(Debug, Default)]
struct StoredVault {
    vault_id: Option<String>,
    credential_urls: BTreeSet<String>,
    /// Hash of each credential's token keyed by URL, for staleness detection.
    credential_hashes: BTreeMap<String, String>,
}

pub(super) async fn vault_ids(
    state: &AppState,
    pool: &PgPool,
    created: &CreatedRuntimeSession,
    mcp_servers: &[Value],
) -> Result<Option<Vec<String>>, GatewayError> {
    if created.resolved.agent_runtime != AgentRuntime::ClaudeManagedAgents {
        return Ok(None);
    }

    let required = gateway_mcp_credentials(state, mcp_servers);
    if required.is_empty() {
        return Ok(None);
    }

    let store_name = store_name(created);
    let mut stored = load_stored_vault(pool, &store_name).await?;
    let mut changed = false;
    let vault_id = match stored.vault_id.clone() {
        Some(vault_id) => vault_id,
        None => {
            let vault_id = create_vault(state, created).await?;
            stored.vault_id = Some(vault_id.clone());
            changed = true;
            vault_id
        }
    };

    for credential in required {
        let token_hash = stable_hash(&credential.token);
        let is_stale = stored
            .credential_hashes
            .get(&credential.url)
            .is_none_or(|h| *h != token_hash);
        if !is_stale {
            continue;
        }
        create_credential(state, created, &vault_id, &credential).await?;
        stored.credential_urls.insert(credential.url.clone());
        stored.credential_hashes.insert(credential.url, token_hash);
        changed = true;
    }

    if changed {
        save_stored_vault(pool, &store_name, &stored).await?;
    }

    Ok(Some(vec![vault_id]))
}

fn gateway_mcp_credentials(state: &AppState, mcp_servers: &[Value]) -> Vec<McpVaultCredential> {
    let Some(proxy_base) = state.resolved_mcp_proxy_base_url() else {
        return Vec::new();
    };
    let proxy_prefix = format!("{}/", proxy_base.trim_end_matches('/'));
    let master_key = state.config.general_settings.master_key.as_deref();
    let mut by_url = BTreeMap::new();

    for server in mcp_servers {
        let Some(url) = server
            .get("url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|url| url.starts_with(&proxy_prefix))
        else {
            continue;
        };
        let token = server
            .get("authorization_token")
            .and_then(Value::as_str)
            .or(master_key);
        if let Some(token) = token {
            by_url
                .entry(url.to_owned())
                .or_insert_with(|| token.to_owned());
        }
    }

    by_url
        .into_iter()
        .map(|(url, token)| McpVaultCredential { url, token })
        .collect()
}

async fn load_stored_vault(pool: &PgPool, store_name: &str) -> Result<StoredVault, GatewayError> {
    let Some(row) = credentials::get_by_name(pool, store_name).await? else {
        return Ok(StoredVault::default());
    };
    Ok(StoredVault {
        vault_id: row
            .credential_values
            .get("vault_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
        credential_urls: row
            .credential_values
            .get("credential_urls")
            .and_then(Value::as_array)
            .map(|urls| {
                urls.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        credential_hashes: row
            .credential_values
            .get("credential_hashes")
            .and_then(Value::as_object)
            .map(|obj| {
                obj.iter()
                    .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

async fn save_stored_vault(
    pool: &PgPool,
    store_name: &str,
    stored: &StoredVault,
) -> Result<(), GatewayError> {
    let credential_urls = stored
        .credential_urls
        .iter()
        .cloned()
        .collect::<Vec<String>>();
    credentials::upsert(
        pool,
        store_name,
        json!({
            "vault_id": stored.vault_id,
            "credential_urls": credential_urls,
            "credential_hashes": stored.credential_hashes,
        }),
        json!({
            "provider": "anthropic",
            "purpose": "managed_agent_mcp_vault",
        }),
        STORE_ACTOR,
    )
    .await
}

async fn create_vault(
    state: &AppState,
    created: &CreatedRuntimeSession,
) -> Result<String, GatewayError> {
    let response = state
        .http
        .post(format!(
            "{}/vaults?beta=true",
            anthropic_v1_base(&created.resolved.credential.api_base)
        ))
        .header("x-api-key", &created.resolved.credential.api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", MANAGED_AGENTS_BETA)
        .json(&json!({ "display_name": "LiteLLM MCP Gateway" }))
        .send()
        .await
        .map_err(GatewayError::Upstream)?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GatewayError::SandboxError(format!(
            "Anthropic vault create failed with status {status}: {body}"
        )));
    }
    let vault: Value = response.json().await.map_err(GatewayError::Upstream)?;
    vault
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| GatewayError::SandboxError("Anthropic vault response missing id".to_owned()))
}

async fn create_credential(
    state: &AppState,
    created: &CreatedRuntimeSession,
    vault_id: &str,
    credential: &McpVaultCredential,
) -> Result<(), GatewayError> {
    let response = state
        .http
        .post(format!(
            "{}/vaults/{vault_id}/credentials?beta=true",
            anthropic_v1_base(&created.resolved.credential.api_base)
        ))
        .header("x-api-key", &created.resolved.credential.api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", MANAGED_AGENTS_BETA)
        .json(&json!({
            "auth": {
                "type": "static_bearer",
                "mcp_server_url": credential.url,
                "token": credential.token
            }
        }))
        .send()
        .await
        .map_err(GatewayError::Upstream)?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(GatewayError::SandboxError(format!(
            "Anthropic vault credential create failed with status {status}: {body}"
        )));
    }
    Ok(())
}

fn store_name(created: &CreatedRuntimeSession) -> String {
    format!(
        "{STORE_PREFIX}{}",
        stable_hash(&format!(
            "{}\0{}",
            anthropic_v1_base(&created.resolved.credential.api_base),
            created.resolved.credential.api_key
        ))
    )
}

fn anthropic_v1_base(api_base: &str) -> String {
    let base = api_base.trim_end_matches('/');
    if base.ends_with("/v1") {
        base.to_owned()
    } else {
        format!("{base}/v1")
    }
}

fn stable_hash(input: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests;
