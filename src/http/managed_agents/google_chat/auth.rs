use std::{
    sync::OnceLock,
    time::{Duration, Instant},
};

use jsonwebtoken::{decode, decode_header, jwk::Jwk, Algorithm, DecodingKey, Validation};
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;

use crate::errors::GatewayError;

const GOOGLE_OIDC_JWKS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_CHAT_JWT_JWKS_URL: &str =
    "https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com";
const GOOGLE_CHAT_SERVICE_ACCOUNT: &str = "chat@system.gserviceaccount.com";
const KEY_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

static GOOGLE_OIDC_KEYS: OnceLock<tokio::sync::RwLock<Option<CachedKeys>>> = OnceLock::new();
static GOOGLE_CHAT_JWT_KEYS: OnceLock<tokio::sync::RwLock<Option<CachedKeys>>> = OnceLock::new();

#[derive(Debug, Clone, Deserialize)]
struct RawJwkSet {
    keys: Vec<Value>,
}

#[derive(Debug, Clone)]
struct CachedKeys {
    keys: RawJwkSet,
    fetched_at: Instant,
}

#[derive(Debug, Deserialize)]
struct GoogleChatClaims {
    iss: String,
    aud: String,
    email: Option<String>,
    email_verified: Option<bool>,
}

#[derive(Clone, Copy)]
enum KeySetKind {
    GoogleOidc,
    GoogleChatJwt,
}

pub(crate) async fn verify_google_chat_request(
    client: &Client,
    authorization: Option<&str>,
    endpoint_audience: Option<&str>,
    project_number: Option<&str>,
) -> Result<(), GatewayError> {
    let token = bearer_token(authorization)?;
    let mut first_error = None;
    if let Some(audience) = endpoint_audience {
        match verify_endpoint_id_token(client, token, audience).await {
            Ok(()) => return Ok(()),
            Err(error) => first_error = Some(error),
        }
    }
    if let Some(audience) = project_number {
        match verify_project_number_jwt(client, token, audience).await {
            Ok(()) => return Ok(()),
            Err(error) if first_error.is_none() => first_error = Some(error),
            Err(_) => {}
        }
    }
    Err(first_error.unwrap_or(GatewayError::Unauthorized))
}

async fn verify_endpoint_id_token(
    client: &Client,
    token: &str,
    auth_audience: &str,
) -> Result<(), GatewayError> {
    let claims = decode_google_chat_token(
        client,
        token,
        auth_audience,
        KeySetKind::GoogleOidc,
        &["https://accounts.google.com", "accounts.google.com"],
    )
    .await?;
    if !is_chat_endpoint_claims(&claims) {
        return Err(GatewayError::Unauthorized);
    }
    Ok(())
}

async fn verify_project_number_jwt(
    client: &Client,
    token: &str,
    auth_audience: &str,
) -> Result<(), GatewayError> {
    let claims = decode_google_chat_token(
        client,
        token,
        auth_audience,
        KeySetKind::GoogleChatJwt,
        &[GOOGLE_CHAT_SERVICE_ACCOUNT],
    )
    .await?;
    if !is_chat_project_claims(&claims, auth_audience) {
        return Err(GatewayError::Unauthorized);
    }
    Ok(())
}

async fn decode_google_chat_token(
    client: &Client,
    token: &str,
    auth_audience: &str,
    key_set: KeySetKind,
    issuers: &[&str],
) -> Result<GoogleChatClaims, GatewayError> {
    let header = decode_header(token).map_err(|_| GatewayError::Unauthorized)?;
    let key_id = header
        .kid
        .or(header.x5t)
        .ok_or(GatewayError::Unauthorized)?;
    let mut keys = google_chat_keys(client, key_set, false).await?;
    let mut key_value = keys
        .keys
        .iter()
        .find(|key| key_matches(key, &key_id))
        .cloned();
    if key_value.is_none() {
        keys = google_chat_keys(client, key_set, true).await?;
        key_value = keys
            .keys
            .iter()
            .find(|key| key_matches(key, &key_id))
            .cloned();
    }
    let key_value = key_value.ok_or(GatewayError::Unauthorized)?;
    let jwk: Jwk = serde_json::from_value(key_value).map_err(GatewayError::InvalidJson)?;
    let key = DecodingKey::from_jwk(&jwk).map_err(|_| GatewayError::Unauthorized)?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[auth_audience]);
    validation.set_issuer(issuers);
    validation.leeway = 300;
    validation.validate_nbf = true;
    decode::<GoogleChatClaims>(token, &key, &validation)
        .map(|data| data.claims)
        .map_err(|_| GatewayError::Unauthorized)
}

fn bearer_token(authorization: Option<&str>) -> Result<&str, GatewayError> {
    authorization
        .and_then(|value| value.trim().strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(GatewayError::Unauthorized)
}

async fn google_chat_keys(
    client: &Client,
    kind: KeySetKind,
    force_refresh: bool,
) -> Result<RawJwkSet, GatewayError> {
    let cache = key_cache(kind);
    if !force_refresh {
        if let Some(cached) = cache.read().await.as_ref() {
            if cached.fetched_at.elapsed() < KEY_CACHE_TTL {
                return Ok(cached.keys.clone());
            }
        }
    }
    let fresh = fetch_google_chat_keys(client, jwks_url(kind)).await?;
    *cache.write().await = Some(CachedKeys {
        keys: fresh.clone(),
        fetched_at: Instant::now(),
    });
    Ok(fresh)
}

fn key_cache(kind: KeySetKind) -> &'static tokio::sync::RwLock<Option<CachedKeys>> {
    match kind {
        KeySetKind::GoogleOidc => GOOGLE_OIDC_KEYS.get_or_init(|| tokio::sync::RwLock::new(None)),
        KeySetKind::GoogleChatJwt => {
            GOOGLE_CHAT_JWT_KEYS.get_or_init(|| tokio::sync::RwLock::new(None))
        }
    }
}

fn jwks_url(kind: KeySetKind) -> &'static str {
    match kind {
        KeySetKind::GoogleOidc => GOOGLE_OIDC_JWKS_URL,
        KeySetKind::GoogleChatJwt => GOOGLE_CHAT_JWT_JWKS_URL,
    }
}

async fn fetch_google_chat_keys(client: &Client, url: &str) -> Result<RawJwkSet, GatewayError> {
    client
        .get(url)
        .send()
        .await
        .map_err(GatewayError::Upstream)?
        .json()
        .await
        .map_err(GatewayError::Upstream)
}

fn key_matches(key: &Value, key_id: &str) -> bool {
    key.get("kid").and_then(Value::as_str) == Some(key_id)
        || key.get("x5t").and_then(Value::as_str) == Some(key_id)
}

fn is_chat_endpoint_claims(claims: &GoogleChatClaims) -> bool {
    claims.email.as_deref() == Some(GOOGLE_CHAT_SERVICE_ACCOUNT)
        && claims.email_verified == Some(true)
}

fn is_chat_project_claims(claims: &GoogleChatClaims, auth_audience: &str) -> bool {
    claims.iss == GOOGLE_CHAT_SERVICE_ACCOUNT && claims.aud == auth_audience
}

#[cfg(test)]
mod tests {
    use super::{
        bearer_token, is_chat_endpoint_claims, is_chat_project_claims, GoogleChatClaims,
        GOOGLE_CHAT_SERVICE_ACCOUNT,
    };

    #[test]
    fn endpoint_claims_require_verified_chat_service_account_email() {
        assert!(is_chat_endpoint_claims(&claims(
            "https://accounts.google.com",
            "https://lap.example/api",
            Some(GOOGLE_CHAT_SERVICE_ACCOUNT),
            Some(true),
        )));
        assert!(!is_chat_endpoint_claims(&claims(
            "https://accounts.google.com",
            "https://lap.example/api",
            Some("other@example.com"),
            Some(true),
        )));
        assert!(!is_chat_endpoint_claims(&claims(
            "https://accounts.google.com",
            "https://lap.example/api",
            Some(GOOGLE_CHAT_SERVICE_ACCOUNT),
            Some(false),
        )));
    }

    #[test]
    fn project_claims_require_chat_issuer_and_configured_audience() {
        assert!(is_chat_project_claims(
            &claims(GOOGLE_CHAT_SERVICE_ACCOUNT, "1234567890", None, None,),
            "1234567890"
        ));
        assert!(!is_chat_project_claims(
            &claims("wrong", "1234567890", None, None),
            "1234567890"
        ));
        assert!(!is_chat_project_claims(
            &claims(GOOGLE_CHAT_SERVICE_ACCOUNT, "1234567890", None, None,),
            "0987654321"
        ));
    }

    #[test]
    fn bearer_token_requires_bearer_prefix() {
        assert_eq!(bearer_token(Some("Bearer token-1")).unwrap(), "token-1");
        assert!(bearer_token(Some("token-1")).is_err());
        assert!(bearer_token(Some("Bearer   ")).is_err());
    }

    fn claims(
        iss: &str,
        aud: &str,
        email: Option<&str>,
        email_verified: Option<bool>,
    ) -> GoogleChatClaims {
        GoogleChatClaims {
            iss: iss.to_owned(),
            aud: aud.to_owned(),
            email: email.map(str::to_owned),
            email_verified,
        }
    }
}
