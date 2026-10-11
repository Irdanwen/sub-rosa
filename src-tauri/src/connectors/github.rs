//! GitHub as a built-in connector (ADR-0092, addendum of 2026-10-08).
//!
//! GitHub's remote MCP server does not register clients by itself: it names
//! `https://github.com/login/oauth` as its authorization server, which serves
//! only clients registered by hand. So Sub Rosa signs in with its own GitHub
//! OAuth app, through the device flow, which needs a client id and no secret
//! (a secret in a shipped binary is no secret): the app asks GitHub for a
//! code, the person types it on github.com in their browser, and the app
//! collects the token while they do. The token is then the `Bearer` of
//! GitHub's own remote MCP server, whose protected resource metadata names
//! that same authorization server, so every tool there is offered with the
//! usual rules.
//!
//! The client id comes from the build (`SUBROSA_GITHUB_CLIENT_ID`); a build
//! without one lists GitHub as not available in this build. Waiting for the
//! code is in-process and bounded by the code's own lifetime (fifteen
//! minutes): a sign-in the phone froze in the middle of is started again,
//! never resumed from a row.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use super::oauth::{self, Tokens};
use crate::domain::types::AppError;
use crate::redacted::Redacted;

pub const ID: &str = "github";
pub const NAME: &str = "GitHub";
/// Read on https://github.com/github/github-mcp-server (remote server).
pub const MCP_URL: &str = "https://api.githubcopilot.com/mcp/";
/// What the remote server's tools need: repositories, organisations and
/// the person's profile.
const SCOPES: &str = "repo read:org read:user";
/// GitHub never waits less than this between two polls.
const MIN_INTERVAL_SECS: u64 = 1;
const MAX_WAIT_SECS: i64 = 15 * 60;

/// Where the device flow happens. A struct so the tests can point it at a
/// server of their own.
#[derive(Debug, Clone, Copy)]
pub struct Endpoints<'a> {
    pub device_code: &'a str,
    pub token: &'a str,
}

pub const GITHUB: Endpoints<'static> = Endpoints {
    device_code: "https://github.com/login/device/code",
    token: "https://github.com/login/oauth/access_token",
};

pub fn client_id() -> Option<&'static str> {
    super::build_clients::configured(option_env!("SUBROSA_GITHUB_CLIENT_ID"))
}

pub fn available() -> bool {
    client_id().is_some()
}

/// What the person needs to finish: the code to type and where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: i64,
}

/// The device code is the secret half: it never leaves Rust.
pub struct DeviceCode {
    pub start: DeviceStart,
    pub device_code: Redacted<String>,
    pub interval: u64,
}

fn failed() -> AppError {
    AppError::new(
        "connector_oauth_failed",
        "The sign-in could not be completed. Try again.",
    )
}

/// GitHub's answer to the code request.
pub fn parse_device_code(value: &Value) -> Result<DeviceCode, AppError> {
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty() && text.len() <= 512)
            .map(str::to_string)
    };
    let verification_uri = text("verification_uri")
        .filter(|uri| uri.starts_with("https://"))
        .ok_or_else(failed)?;
    Ok(DeviceCode {
        start: DeviceStart {
            user_code: text("user_code").ok_or_else(failed)?,
            verification_uri,
            expires_in: value
                .get("expires_in")
                .and_then(Value::as_i64)
                .unwrap_or(900)
                .clamp(1, MAX_WAIT_SECS),
        },
        device_code: Redacted::new(text("device_code").ok_or_else(failed)?),
        interval: value
            .get("interval")
            .and_then(Value::as_u64)
            .unwrap_or(5)
            .max(MIN_INTERVAL_SECS),
    })
}

/// One poll of the token endpoint, read.
#[derive(Debug)]
pub enum Poll {
    Done(Tokens),
    /// The person has not typed the code yet.
    Pending,
    /// Polling too fast: wait five seconds more each time.
    SlowDown,
    Expired,
    Denied,
    Failed,
}

/// GitHub answers `200` with an `error` while it waits (RFC 8628 §3.5).
pub fn parse_poll(value: &Value, endpoints: &Endpoints<'_>, client_id: &str, now: i64) -> Poll {
    match value.get("error").and_then(Value::as_str) {
        Some("authorization_pending") => return Poll::Pending,
        Some("slow_down") => return Poll::SlowDown,
        Some("expired_token") => return Poll::Expired,
        Some("access_denied") => return Poll::Denied,
        Some(_) => return Poll::Failed,
        None => {}
    }
    match oauth::parse_token_response(
        value,
        &oauth::TokenContext {
            token_endpoint: endpoints.token,
            client_id,
            resource: None,
        },
        None,
        now,
    ) {
        Ok(tokens) => Poll::Done(tokens),
        Err(_) => Poll::Failed,
    }
}

fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        crate::http_client::build(
            crate::http_client::credentialed(Duration::from_secs(20)),
            "connector sign-in",
        )
    })
}

async fn post(url: &str, form: &[(&str, &str)]) -> Option<Value> {
    let parsed = super::mcp::validate_endpoint(url).ok()?;
    let started = Instant::now();
    let response = client()
        .post(parsed.clone())
        .header(reqwest::header::ACCEPT, "application/json")
        .form(form)
        .send()
        .await
        .ok()?;
    let status = response.status().as_u16();
    let body = response.bytes().await.ok()?;
    super::mcp::ledger(&parsed, "POST", 0, body.len(), Some(status), started);
    if body.len() > 64 * 1024 {
        return None;
    }
    serde_json::from_slice(&body).ok()
}

/// Asks GitHub for a code the person will type.
pub async fn request_code(
    endpoints: &Endpoints<'_>,
    client_id: &str,
) -> Result<DeviceCode, AppError> {
    let value = post(
        endpoints.device_code,
        &[("client_id", client_id), ("scope", SCOPES)],
    )
    .await
    .ok_or_else(failed)?;
    parse_device_code(&value)
}

/// Polls until the person typed the code, refused, or the code expired.
pub async fn wait_for_token(
    endpoints: &Endpoints<'_>,
    client_id: &str,
    code: &DeviceCode,
) -> Result<Tokens, AppError> {
    let deadline = Instant::now() + Duration::from_secs(code.start.expires_in as u64);
    let mut interval = code.interval;
    loop {
        tokio::time::sleep(Duration::from_secs(interval)).await;
        if Instant::now() >= deadline {
            return Err(expired());
        }
        let value = post(
            endpoints.token,
            &[
                ("client_id", client_id),
                ("device_code", code.device_code.expose_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ],
        )
        .await;
        let Some(value) = value else {
            // A network blip: try again at the next interval.
            continue;
        };
        match parse_poll(&value, endpoints, client_id, chrono::Utc::now().timestamp()) {
            Poll::Done(tokens) => return Ok(tokens),
            Poll::Pending => {}
            Poll::SlowDown => interval += 5,
            Poll::Expired => return Err(expired()),
            Poll::Denied => {
                return Err(AppError::new(
                    "connector_oauth_denied",
                    "The sign-in was cancelled.",
                ))
            }
            Poll::Failed => return Err(failed()),
        }
    }
}

fn expired() -> AppError {
    AppError::new(
        "connector_oauth_expired",
        "That sign-in took too long. Start it again.",
    )
}

/// The sign-in in progress per connector. A second start replaces the first:
/// only the latest code may finish.
static WAITING: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(Default::default);

pub fn claim_wait(connector_id: &str) -> u64 {
    let mut waiting = WAITING.lock().unwrap_or_else(|poison| poison.into_inner());
    let next = waiting.get(connector_id).copied().unwrap_or(0) + 1;
    waiting.insert(connector_id.to_string(), next);
    next
}

/// Whether `generation` is still the latest sign-in for this connector.
pub fn is_current(connector_id: &str, generation: u64) -> bool {
    WAITING
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .get(connector_id)
        .copied()
        == Some(generation)
}
