//! OAuth 2.1 for connectors: discovery, registration, PKCE, the callback and
//! refresh (ADR-0092).
//!
//! The shape follows the protocol's authorization rules. A server that wants a
//! token answers `401` and names its protected resource metadata (RFC 9728);
//! that names the authorization server, whose own metadata (RFC 8414, or the
//! OpenID equivalent) gives the endpoints. The app registers itself there as a
//! public client (RFC 7591) when the server allows it, and signs in with PKCE
//! `S256` (a server that does not say it supports `S256` is refused, as the
//! protocol requires) and the resource indicator (RFC 8707), so the token is
//! good for that server and no other.
//!
//! The browser comes back through `subrosa://connector/callback`, the pattern
//! of ADR-0055: the verifier is written to the keychain before the browser
//! opens and is read only by Rust, so another app that squats the scheme and
//! receives the code holds half of what the exchange needs.

use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Digest as _;

use super::tokens;
use crate::domain::types::AppError;
use crate::redacted::Redacted;

pub const REDIRECT_URI: &str = "subrosa://connector/callback";
/// A sign-in left unfinished this long is forgotten.
const PENDING_TTL_SECS: i64 = 15 * 60;
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_METADATA_BYTES: usize = 256 * 1024;

/// Each message a literal the i18n extractor reads (ADR-0047).
fn error(code: &str) -> AppError {
    match code {
        "connector_oauth_discovery" => AppError::new(
            "connector_oauth_discovery",
            "This connector does not say how to sign in. Check its address.",
        ),
        "connector_oauth_pkce" => AppError::new(
            "connector_oauth_pkce",
            "This connector's sign-in does not support the protection Sub Rosa requires.",
        ),
        "connector_oauth_registration" => AppError::new(
            "connector_oauth_registration",
            "This connector does not let apps register themselves, so Sub Rosa cannot sign in to it yet.",
        ),
        "connector_oauth_expired" => AppError::new(
            "connector_oauth_expired",
            "That sign-in took too long. Start it again.",
        ),
        "connector_oauth_denied" => {
            AppError::new("connector_oauth_denied", "The sign-in was cancelled.")
        }
        "connector_sign_in" => AppError::new(
            "connector_sign_in",
            "This connector needs you to sign in again.",
        ),
        "connector_keychain" => AppError::new(
            "connector_keychain",
            "Your system credential store is unavailable.",
        ),
        _ => AppError::new(
            "connector_oauth_failed",
            "The sign-in could not be completed. Try again.",
        ),
    }
}

pub struct Pkce {
    pub verifier: Redacted<String>,
    pub challenge: String,
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// A fresh verifier (256 random bits) and its `S256` challenge.
pub fn pkce() -> Pkce {
    let verifier = b64(&rand::random::<[u8; 32]>());
    let challenge = challenge_for(&verifier);
    Pkce {
        verifier: Redacted::new(verifier),
        challenge,
    }
}

pub fn challenge_for(verifier: &str) -> String {
    b64(&sha2::Sha256::digest(verifier.as_bytes()))
}

pub fn random_state() -> String {
    b64(&rand::random::<[u8; 32]>())
}

/// Scheme, host and port. Only ever called on an address `secure` accepted,
/// so the scheme is https, or http on this machine.
fn origin(url: &reqwest::Url) -> String {
    let host = url.host_str().unwrap_or_default();
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    if url.scheme() == "https" {
        format!("https://{host}{port}")
    } else {
        format!("http://{host}{port}")
    }
}

/// Where a server's protected resource metadata may be (RFC 9728 §3.1): with
/// the endpoint's path inserted after the well-known segment, then without.
pub fn protected_resource_candidates(endpoint: &reqwest::Url) -> Vec<String> {
    let base = origin(endpoint);
    let path = endpoint.path().trim_end_matches('/');
    let mut candidates = Vec::new();
    if !path.is_empty() {
        candidates.push(format!("{base}/.well-known/oauth-protected-resource{path}"));
    }
    candidates.push(format!("{base}/.well-known/oauth-protected-resource"));
    candidates
}

/// Where an issuer's metadata may be: RFC 8414 with path insertion, OpenID
/// Connect with path insertion, then OpenID Connect appended to the issuer.
pub fn authorization_server_candidates(issuer: &reqwest::Url) -> Vec<String> {
    let base = origin(issuer);
    let path = issuer.path().trim_end_matches('/');
    if path.is_empty() {
        vec![
            format!("{base}/.well-known/oauth-authorization-server"),
            format!("{base}/.well-known/openid-configuration"),
        ]
    } else {
        vec![
            format!("{base}/.well-known/oauth-authorization-server{path}"),
            format!("{base}/.well-known/openid-configuration{path}"),
            format!("{base}{path}/.well-known/openid-configuration"),
        ]
    }
}

/// An endpoint the sign-in may use: the same rule as a connector's own
/// address (https, or http on this machine).
fn secure(raw: &str) -> Option<reqwest::Url> {
    super::mcp::validate_endpoint(raw).ok()
}

fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            crate::http_client::build(
                crate::http_client::credentialed(HTTP_TIMEOUT),
                "connector sign-in",
            )
        })
        .clone()
}

async fn read_bounded(mut response: reqwest::Response) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_METADATA_BYTES {
            return None;
        }
    }
    Some(body)
}

async fn get_json(url: &str) -> Option<Value> {
    let parsed = secure(url)?;
    let started = Instant::now();
    let response = client()
        .get(parsed.clone())
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .ok()?;
    let status = response.status().as_u16();
    let body = if (200..300).contains(&status) {
        read_bounded(response).await
    } else {
        None
    };
    super::mcp::ledger(
        &parsed,
        "GET",
        0,
        body.as_ref().map_or(0, Vec::len),
        Some(status),
        started,
    );
    serde_json::from_slice(&body?).ok()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthServer {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default)]
    pub registration_endpoint: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    /// The resource indicator a token is bound to (RFC 8707).
    #[serde(default)]
    pub resource: Option<String>,
}

/// `(authorization servers, scopes, resource)` from protected resource
/// metadata.
pub fn parse_protected_resource(value: &Value) -> (Vec<String>, Vec<String>, Option<String>) {
    let strings = |key: &str| -> Vec<String> {
        value
            .get(key)
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .take(16)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    (
        strings("authorization_servers"),
        strings("scopes_supported"),
        value
            .get("resource")
            .and_then(Value::as_str)
            .map(str::to_string),
    )
}

/// The endpoints an authorization server's metadata gives, refused when one
/// is not secure or PKCE `S256` is not declared.
pub fn parse_auth_server(value: &Value, issuer: &str) -> Result<AuthServer, AppError> {
    let endpoint = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|url| secure(url).is_some())
            .map(str::to_string)
    };
    let authorization_endpoint =
        endpoint("authorization_endpoint").ok_or_else(|| error("connector_oauth_discovery"))?;
    let token_endpoint =
        endpoint("token_endpoint").ok_or_else(|| error("connector_oauth_discovery"))?;
    let s256 = value
        .get("code_challenge_methods_supported")
        .and_then(Value::as_array)
        .is_some_and(|methods| methods.iter().any(|method| method.as_str() == Some("S256")));
    if !s256 {
        return Err(error("connector_oauth_pkce"));
    }
    Ok(AuthServer {
        issuer: value
            .get("issuer")
            .and_then(Value::as_str)
            .unwrap_or(issuer)
            .to_string(),
        authorization_endpoint,
        token_endpoint,
        registration_endpoint: endpoint("registration_endpoint"),
        scopes: Vec::new(),
        resource: None,
    })
}

/// The canonical address of a server, as a resource indicator: no fragment,
/// no query, no trailing slash.
pub fn canonical_resource(endpoint: &reqwest::Url) -> String {
    let path = endpoint.path().trim_end_matches('/');
    format!("{}{path}", origin(endpoint))
}

/// Follows the chain from a server's `401` to its authorization server.
pub async fn discover(
    endpoint: &reqwest::Url,
    metadata_hint: Option<&str>,
    scope_hint: Option<&str>,
) -> Result<AuthServer, AppError> {
    let mut candidates: Vec<String> = metadata_hint
        .filter(|hint| secure(hint).is_some())
        .map(str::to_string)
        .into_iter()
        .collect();
    candidates.extend(protected_resource_candidates(endpoint));
    let mut issuers = Vec::new();
    let mut scopes = Vec::new();
    let mut resource = None;
    for candidate in candidates {
        if let Some(metadata) = get_json(&candidate).await {
            (issuers, scopes, resource) = parse_protected_resource(&metadata);
            break;
        }
    }
    // A server that publishes no resource metadata is its own authorization
    // server: the protocol's earlier revision, still common.
    if issuers.is_empty() {
        issuers.push(origin(endpoint));
    }
    for issuer in issuers {
        let Some(issuer_url) = secure(&issuer) else {
            continue;
        };
        for candidate in authorization_server_candidates(&issuer_url) {
            let Some(metadata) = get_json(&candidate).await else {
                continue;
            };
            let mut server = parse_auth_server(&metadata, &issuer)?;
            server.scopes = match scope_hint.filter(|scope| !scope.trim().is_empty()) {
                Some(scope) => scope.split_whitespace().map(str::to_string).collect(),
                None => scopes.clone(),
            };
            server.resource = Some(
                resource
                    .clone()
                    .filter(|resource| secure(resource).is_some())
                    .unwrap_or_else(|| canonical_resource(endpoint)),
            );
            return Ok(server);
        }
    }
    Err(error("connector_oauth_discovery"))
}

/// Registers the app as a public client (RFC 7591) and returns its id.
pub async fn register(server: &AuthServer, redirect_uri: &str) -> Result<String, AppError> {
    let Some(endpoint) = server.registration_endpoint.as_deref().and_then(secure) else {
        return Err(error("connector_oauth_registration"));
    };
    let body = serde_json::json!({
        "client_name": crate::carpe_diem::branding::PRODUCT_NAME,
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "application_type": "native",
    });
    let started = Instant::now();
    let response = client()
        .post(endpoint.clone())
        .json(&body)
        .send()
        .await
        .map_err(|_| error("connector_oauth_registration"))?;
    let status = response.status().as_u16();
    let bytes = read_bounded(response).await.unwrap_or_default();
    super::mcp::ledger(
        &endpoint,
        "POST",
        body.to_string().len(),
        bytes.len(),
        Some(status),
        started,
    );
    if !(200..300).contains(&status) {
        return Err(error("connector_oauth_registration"));
    }
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|value| {
            value
                .get("client_id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|id| !id.is_empty() && id.len() <= 512)
        .ok_or_else(|| error("connector_oauth_registration"))
}

pub struct AuthorizeRequest<'a> {
    pub authorization_endpoint: &'a str,
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
    pub challenge: &'a str,
    pub state: &'a str,
    pub scopes: &'a [String],
    pub resource: Option<&'a str>,
    /// Provider-specific parameters (Google's `access_type=offline`).
    pub extra: &'a [(&'a str, &'a str)],
}

pub fn authorize_url(request: &AuthorizeRequest<'_>) -> Result<String, AppError> {
    let mut url = reqwest::Url::parse(request.authorization_endpoint)
        .map_err(|_| error("connector_oauth_discovery"))?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", request.client_id)
            .append_pair("redirect_uri", request.redirect_uri)
            .append_pair("code_challenge", request.challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", request.state);
        if !request.scopes.is_empty() {
            query.append_pair("scope", &request.scopes.join(" "));
        }
        if let Some(resource) = request.resource {
            query.append_pair("resource", resource);
        }
        for (key, value) in request.extra {
            query.append_pair(key, value);
        }
    }
    Ok(url.to_string())
}

/// What the keychain holds for one connector. Plain strings here only because
/// this is the serialisation into the keychain; everything outside reads
/// [`Tokens`].
#[derive(Serialize, Deserialize)]
struct StoredTokens {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_at: Option<i64>,
    token_endpoint: String,
    client_id: String,
    #[serde(default)]
    resource: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Tokens {
    pub access_token: Redacted<String>,
    pub refresh_token: Option<Redacted<String>>,
    pub expires_at: Option<i64>,
    pub token_endpoint: String,
    pub client_id: String,
    pub resource: Option<String>,
    pub scope: Option<String>,
}

impl Tokens {
    /// Expired, or about to be within the minute a request may take.
    pub fn expiring(&self, now: i64) -> bool {
        self.expires_at.is_some_and(|at| at - 60 <= now)
    }
}

pub fn save_tokens(connector_id: &str, tokens: &Tokens) -> Result<(), AppError> {
    let stored = StoredTokens {
        access_token: tokens.access_token.expose_str().to_string(),
        refresh_token: tokens
            .refresh_token
            .as_ref()
            .map(|token| token.expose_str().to_string()),
        expires_at: tokens.expires_at,
        token_endpoint: tokens.token_endpoint.clone(),
        client_id: tokens.client_id.clone(),
        resource: tokens.resource.clone(),
        scope: tokens.scope.clone(),
    };
    let json = serde_json::to_string(&stored).map_err(|_| error("connector_keychain"))?;
    tokens::put(&tokens::tokens_slot(connector_id), &json)
}

pub fn load_tokens(connector_id: &str) -> Result<Option<Tokens>, AppError> {
    let Some(raw) = tokens::get(&tokens::tokens_slot(connector_id))? else {
        return Ok(None);
    };
    let Ok(stored) = serde_json::from_str::<StoredTokens>(raw.expose_str()) else {
        return Ok(None);
    };
    Ok(Some(Tokens {
        access_token: Redacted::new(stored.access_token),
        refresh_token: stored.refresh_token.map(Redacted::new),
        expires_at: stored.expires_at,
        token_endpoint: stored.token_endpoint,
        client_id: stored.client_id,
        resource: stored.resource,
        scope: stored.scope,
    }))
}

pub fn forget_tokens(connector_id: &str) -> Result<(), AppError> {
    tokens::remove(&tokens::tokens_slot(connector_id))
}

/// A token endpoint's answer as [`Tokens`]. A refresh that returns no new
/// refresh token keeps the old one (RFC 6749 §6).
pub fn parse_token_response(
    value: &Value,
    context: &TokenContext<'_>,
    previous_refresh: Option<&Redacted<String>>,
    now: i64,
) -> Result<Tokens, AppError> {
    let access = value
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| error("connector_oauth_failed"))?;
    if let Some(kind) = value.get("token_type").and_then(Value::as_str) {
        if !kind.eq_ignore_ascii_case("bearer") {
            return Err(error("connector_oauth_failed"));
        }
    }
    Ok(Tokens {
        access_token: Redacted::new(access.to_string()),
        refresh_token: value
            .get("refresh_token")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
            .map(|token| Redacted::new(token.to_string()))
            .or_else(|| previous_refresh.cloned()),
        expires_at: value
            .get("expires_in")
            .and_then(Value::as_i64)
            .filter(|seconds| *seconds > 0)
            .map(|seconds| now + seconds),
        token_endpoint: context.token_endpoint.to_string(),
        client_id: context.client_id.to_string(),
        resource: context.resource.map(str::to_string),
        scope: value
            .get("scope")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

pub struct TokenContext<'a> {
    pub token_endpoint: &'a str,
    pub client_id: &'a str,
    pub resource: Option<&'a str>,
}

async fn post_form(endpoint: &str, form: &[(&str, &str)]) -> Result<Value, AppError> {
    let url = secure(endpoint).ok_or_else(|| error("connector_oauth_failed"))?;
    let started = Instant::now();
    let response = client()
        .post(url.clone())
        .header(reqwest::header::ACCEPT, "application/json")
        .form(form)
        .send()
        .await
        .map_err(|_| error("connector_oauth_failed"))?;
    let status = response.status().as_u16();
    let bytes = read_bounded(response).await.unwrap_or_default();
    super::mcp::ledger(&url, "POST", 0, bytes.len(), Some(status), started);
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        // `invalid_grant` is a refresh token the server no longer honours:
        // the person signs in again. Anything else failed this once.
        let code = value.get("error").and_then(Value::as_str);
        return Err(if code == Some("invalid_grant") {
            error("connector_sign_in")
        } else {
            error("connector_oauth_failed")
        });
    }
    Ok(value)
}

/// The authorization code, traded for tokens with the verifier.
pub async fn exchange(flow: &PendingFlow, code: &str) -> Result<Tokens, AppError> {
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", flow.redirect_uri.as_str()),
        ("client_id", flow.client_id.as_str()),
        ("code_verifier", flow.verifier.as_str()),
    ];
    if let Some(resource) = flow.resource.as_deref() {
        form.push(("resource", resource));
    }
    let value = post_form(&flow.token_endpoint, &form).await?;
    parse_token_response(
        &value,
        &TokenContext {
            token_endpoint: &flow.token_endpoint,
            client_id: &flow.client_id,
            resource: flow.resource.as_deref(),
        },
        None,
        chrono::Utc::now().timestamp(),
    )
}

pub async fn refresh(tokens: &Tokens) -> Result<Tokens, AppError> {
    let Some(refresh_token) = tokens.refresh_token.as_ref() else {
        return Err(error("connector_sign_in"));
    };
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token.expose_str()),
        ("client_id", tokens.client_id.as_str()),
    ];
    if let Some(resource) = tokens.resource.as_deref() {
        form.push(("resource", resource));
    }
    let value = post_form(&tokens.token_endpoint, &form).await?;
    parse_token_response(
        &value,
        &TokenContext {
            token_endpoint: &tokens.token_endpoint,
            client_id: &tokens.client_id,
            resource: tokens.resource.as_deref(),
        },
        Some(refresh_token),
        chrono::Utc::now().timestamp(),
    )
}

/// A sign-in between opening the browser and its callback. Kept in the
/// keychain because it holds the verifier, and because a phone may lose the
/// process while the person is in the browser.
#[derive(Serialize, Deserialize)]
pub struct PendingFlow {
    pub connector_id: String,
    verifier: String,
    pub token_endpoint: String,
    pub client_id: String,
    pub redirect_uri: String,
    #[serde(default)]
    pub resource: Option<String>,
    pub created_at: i64,
}

/// Never prints the verifier.
impl std::fmt::Debug for PendingFlow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingFlow")
            .field("connector_id", &self.connector_id)
            .field("verifier", &"[redacted]")
            .field("token_endpoint", &self.token_endpoint)
            .field("created_at", &self.created_at)
            .finish_non_exhaustive()
    }
}

impl PendingFlow {
    pub fn new(
        connector_id: &str,
        verifier: &Redacted<String>,
        token_endpoint: &str,
        client_id: &str,
        redirect_uri: &str,
        resource: Option<&str>,
    ) -> Self {
        Self {
            connector_id: connector_id.to_string(),
            verifier: verifier.expose_str().to_string(),
            token_endpoint: token_endpoint.to_string(),
            client_id: client_id.to_string(),
            redirect_uri: redirect_uri.to_string(),
            resource: resource.map(str::to_string),
            created_at: chrono::Utc::now().timestamp(),
        }
    }
}

pub fn store_pending(state: &str, flow: &PendingFlow) -> Result<(), AppError> {
    let json = serde_json::to_string(flow).map_err(|_| error("connector_keychain"))?;
    tokens::put(&tokens::pending_slot(state), &json)
}

/// The flow a state names, once: it is removed as it is read, and refused
/// when it is older than the window.
pub fn take_pending(state: &str, now: i64) -> Result<PendingFlow, AppError> {
    if state.is_empty() || state.len() > 128 {
        return Err(error("connector_oauth_failed"));
    }
    let slot = tokens::pending_slot(state);
    let raw = tokens::get(&slot)?.ok_or_else(|| error("connector_oauth_failed"))?;
    let _ = tokens::remove(&slot);
    let flow: PendingFlow =
        serde_json::from_str(raw.expose_str()).map_err(|_| error("connector_oauth_failed"))?;
    if now - flow.created_at > PENDING_TTL_SECS {
        return Err(error("connector_oauth_expired"));
    }
    Ok(flow)
}

#[derive(Debug, PartialEq)]
pub enum CallbackOutcome {
    Code(Redacted<String>),
    Denied(String),
}

/// `state` and either `code` or `error` from a callback address.
pub fn parse_callback(url: &str) -> Option<(String, CallbackOutcome)> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let mut state = None;
    let mut code = None;
    let mut denied = None;
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "state" => state = Some(value.into_owned()),
            "code" => code = Some(Redacted::new(value.into_owned())),
            "error" => denied = Some(value.chars().take(80).collect::<String>()),
            _ => {}
        }
    }
    let state = state.filter(|state| !state.is_empty())?;
    match (code, denied) {
        (_, Some(reason)) => Some((state, CallbackOutcome::Denied(reason))),
        (Some(code), None) if !code.is_empty() => Some((state, CallbackOutcome::Code(code))),
        _ => None,
    }
}

/// Whether a callback came back where the flow said it would: same scheme,
/// host and path. A link to anywhere else is not this sign-in's.
pub fn redirect_matches(url: &str, redirect_uri: &str) -> bool {
    let (Ok(got), Ok(want)) = (reqwest::Url::parse(url), reqwest::Url::parse(redirect_uri)) else {
        return false;
    };
    got.scheme() == want.scheme()
        && got.host_str() == want.host_str()
        && got.path().trim_end_matches('/') == want.path().trim_end_matches('/')
}

/// Whether a deep link is shaped like a connector callback at all.
pub fn is_callback(url: &str) -> bool {
    url.starts_with(REDIRECT_URI)
        || super::builtin::extra_redirects()
            .iter()
            .any(|redirect| !redirect.is_empty() && url.starts_with(redirect.as_str()))
}
