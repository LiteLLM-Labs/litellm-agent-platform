use std::collections::HashMap;

use axum::http::{HeaderName, HeaderValue};
use reqwest::Url;
use serde::Serialize;
use sqlx::PgPool;

use crate::{
    errors::GatewayError,
    proxy::{
        config::{GatewayConfig, McpAuthType},
        credential_crypto,
    },
};

use super::registry::McpServerRegistry;

/// A session-scoped MCP server with freshly resolved credentials.
/// Lives only for the duration of one agent run — never cached or shared.
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedMcpServer {
    pub name: String,
    pub url: String,
    #[serde(skip)]
    pub auth_header: Option<(HeaderName, HeaderValue)>,
    /// Flattened headers (including auth) for serialization to agent harnesses.
    pub headers: HashMap<String, String>,
}

/// Configuration for an MCP server attached to an agent.
/// Supports two modes: reference a gateway-registered server by name,
/// or inline a full server spec with URL + auth.
#[derive(Debug, Clone, serde::Deserialize, Serialize)]
pub struct AgentMcpServerSpec {
    pub name: String,
    /// Override URL. If absent, inherits from gateway registry by `name`.
    #[serde(default)]
    pub url: Option<String>,
    /// Auth type (bearer_token, api_key, etc.). Inherits from registry if absent.
    #[serde(default)]
    pub auth_type: Option<McpAuthType>,
    /// Credential source: `os.environ/VAR`, `vault:key_name`, or literal.
    #[serde(default)]
    pub auth_value: Option<String>,
    /// Static headers always sent upstream.
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
}

/// Resolves MCP servers for an agent session with fresh credentials.
/// Stateless — call once per agent run, discard results after injection.
pub async fn resolve(
    specs: &[AgentMcpServerSpec],
    registry: &McpServerRegistry,
    config: &GatewayConfig,
    pool: Option<&PgPool>,
) -> Result<Vec<ResolvedMcpServer>, GatewayError> {
    let mut resolved = Vec::with_capacity(specs.len());

    for spec in specs {
        resolved.push(resolve_one(spec, registry, config, pool).await?);
    }

    Ok(resolved)
}

async fn resolve_one(
    spec: &AgentMcpServerSpec,
    registry: &McpServerRegistry,
    config: &GatewayConfig,
    pool: Option<&PgPool>,
) -> Result<ResolvedMcpServer, GatewayError> {
    let (url, auth_type, base_headers) = if let Ok(registered) = registry.resolve(&spec.name) {
        let url = spec
            .url
            .as_deref()
            .map(|u| u.to_owned())
            .unwrap_or_else(|| registered.url.to_string());
        let auth_type = spec.auth_type.unwrap_or(McpAuthType::None);
        let headers = spec
            .headers
            .clone()
            .unwrap_or_else(|| registered.static_headers.clone());
        (url, auth_type, headers)
    } else {
        let url = spec.url.as_deref().ok_or_else(|| {
            GatewayError::InvalidConfig(format!(
                "agent mcp_server '{}' not in registry and has no url",
                spec.name
            ))
        })?;
        let auth_type = spec.auth_type.unwrap_or(McpAuthType::None);
        let headers = spec.headers.clone().unwrap_or_default();
        (url.to_owned(), auth_type, headers)
    };

    let _parsed_url: Url = url.parse().map_err(|e| {
        GatewayError::InvalidConfig(format!("mcp_server '{}': invalid url: {e}", spec.name))
    })?;

    let auth_header = match &spec.auth_value {
        Some(raw) => {
            let value = resolve_credential(raw, config, pool).await?;
            build_auth_header(&spec.name, auth_type, Some(&value))?
        }
        None => None,
    };

    let mut headers = base_headers;
    if let Some((ref name, ref value)) = auth_header {
        if let Ok(v) = value.to_str() {
            headers.insert(name.as_str().to_owned(), v.to_owned());
        }
    }

    Ok(ResolvedMcpServer {
        name: spec.name.clone(),
        url,
        auth_header,
        headers,
    })
}

/// Resolve a credential value from its source pattern.
/// - `os.environ/VAR_NAME` → read env var at call time
/// - `vault:key_name` → decrypt from vault (requires pool + system user)
/// - anything else → literal value
async fn resolve_credential(
    raw: &str,
    config: &GatewayConfig,
    pool: Option<&PgPool>,
) -> Result<String, GatewayError> {
    if let Some(var_name) = raw.strip_prefix("os.environ/") {
        return std::env::var(var_name).map_err(|_| {
            GatewayError::InvalidConfig(format!(
                "mcp_server auth_value references unset env var: {var_name}"
            ))
        });
    }

    if let Some(key_name) = raw.strip_prefix("vault:") {
        let pool = pool.ok_or_else(|| {
            GatewayError::InvalidConfig(
                "vault: credential source requires database connection".to_owned(),
            )
        })?;
        let encryption_key =
            credential_crypto::encryption_key(config.general_settings.master_key.as_deref())?;
        let encrypted = crate::db::credentials::resolve_vault_key(pool, key_name, "system").await?;
        let encrypted = encrypted.ok_or_else(|| {
            GatewayError::InvalidConfig(format!("vault key not found: {key_name}"))
        })?;
        return credential_crypto::decrypt_value(&encrypted, &encryption_key);
    }

    Ok(raw.to_owned())
}

fn build_auth_header(
    name: &str,
    auth_type: McpAuthType,
    auth_value: Option<&str>,
) -> Result<Option<(HeaderName, HeaderValue)>, GatewayError> {
    if auth_type == McpAuthType::None {
        return Ok(None);
    }

    let value = auth_value.unwrap_or_default();

    let (header_name, value_str): (HeaderName, String) = match auth_type {
        McpAuthType::BearerToken => (
            HeaderName::from_static("authorization"),
            format!("Bearer {value}"),
        ),
        McpAuthType::ApiKey => (HeaderName::from_static("x-api-key"), value.to_owned()),
        McpAuthType::Basic => (
            HeaderName::from_static("authorization"),
            format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(value)
            ),
        ),
        McpAuthType::Authorization => (HeaderName::from_static("authorization"), value.to_owned()),
        McpAuthType::Token => (
            HeaderName::from_static("authorization"),
            format!("token {value}"),
        ),
        McpAuthType::None
        | McpAuthType::Oauth2
        | McpAuthType::Oauth2TokenExchange
        | McpAuthType::AwsSigv4 => {
            return Err(GatewayError::InvalidConfig(format!(
                "{name}: auth_type '{}' not yet supported",
                auth_type.as_str()
            )));
        }
    };

    let header_value = HeaderValue::from_str(&value_str).map_err(|e| {
        GatewayError::InvalidConfig(format!("{name}: invalid auth_value for header: {e}"))
    })?;
    Ok(Some((header_name, header_value)))
}

use base64::Engine;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::config::{GeneralSettings, McpServersConfig, SlackSettings};

    #[test]
    fn resolve_credential_literal_returns_as_is() {
        let config = test_config();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(resolve_credential("my-token-123", &config, None));
        assert_eq!(result.unwrap(), "my-token-123");
    }

    #[test]
    fn resolve_credential_env_var_reads_at_call_time() {
        let config = test_config();
        let rt = tokio::runtime::Runtime::new().unwrap();

        unsafe { std::env::set_var("TEST_MCP_SESSION_TOKEN", "fresh-value") };
        let result = rt.block_on(resolve_credential(
            "os.environ/TEST_MCP_SESSION_TOKEN",
            &config,
            None,
        ));
        assert_eq!(result.unwrap(), "fresh-value");
        unsafe { std::env::remove_var("TEST_MCP_SESSION_TOKEN") };
    }

    #[test]
    fn resolve_credential_missing_env_var_errors() {
        let config = test_config();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let result = rt.block_on(resolve_credential(
            "os.environ/NONEXISTENT_VAR_XYZ_9999",
            &config,
            None,
        ));
        assert!(result.is_err());
    }

    #[test]
    fn resolve_credential_vault_without_pool_errors() {
        let config = test_config();
        let rt = tokio::runtime::Runtime::new().unwrap();

        let result = rt.block_on(resolve_credential("vault:some-key", &config, None));
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("database connection"));
    }

    #[test]
    fn build_auth_header_bearer() {
        let result = build_auth_header("test", McpAuthType::BearerToken, Some("abc")).unwrap();
        let (name, value) = result.unwrap();
        assert_eq!(name.as_str(), "authorization");
        assert_eq!(value.to_str().unwrap(), "Bearer abc");
    }

    #[test]
    fn build_auth_header_none_yields_nothing() {
        let result = build_auth_header("test", McpAuthType::None, None).unwrap();
        assert!(result.is_none());
    }

    fn test_config() -> GatewayConfig {
        GatewayConfig {
            model_list: Vec::new(),
            mcp_servers: McpServersConfig::default(),
            general_settings: GeneralSettings::default(),
            slack: SlackSettings::default(),
            agents: Vec::new(),
        }
    }
}
