//! PAT-authenticated request layer for the Videomaker API.
//!
//! Money safety lives here:
//! - every costly POST carries an `Idempotency-Key` (retries replay the
//!   stored response server-side instead of double-spending);
//! - a 401 self-heals once by re-minting the PAT with the stored wallet;
//! - every Videomaker status code maps to a stable `AppError` code the UI can
//!   switch on (the 409 confirmation handshake and the 423 final-review lock
//!   are flows, not failures — callers catch those codes).

use crate::domain::types::AppError;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("videomaker http client")
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Patch,
    Put,
    Delete,
}

pub struct Request {
    pub method: Method,
    /// Path under the API root, starting with `/` (e.g. `/projects`).
    pub path: String,
    pub body: Option<Value>,
    /// Set on costly POSTs. `Some(key)` lets a caller retry with the same key.
    pub idempotency_key: Option<String>,
}

impl Request {
    pub fn get(path: impl Into<String>) -> Self {
        Self {
            method: Method::Get,
            path: path.into(),
            body: None,
            idempotency_key: None,
        }
    }

    pub fn post(path: impl Into<String>, body: Value) -> Self {
        Self {
            method: Method::Post,
            path: path.into(),
            body: Some(body),
            idempotency_key: None,
        }
    }

    /// A costly POST: gets a fresh idempotency key.
    pub fn costly_post(path: impl Into<String>, body: Value) -> Self {
        Self {
            method: Method::Post,
            path: path.into(),
            body: Some(body),
            idempotency_key: Some(uuid::Uuid::new_v4().to_string()),
        }
    }

    pub fn patch(path: impl Into<String>, body: Value) -> Self {
        Self {
            method: Method::Patch,
            path: path.into(),
            body: Some(body),
            idempotency_key: None,
        }
    }

    pub fn put(path: impl Into<String>, body: Value) -> Self {
        Self {
            method: Method::Put,
            path: path.into(),
            body: Some(body),
            idempotency_key: None,
        }
    }

    pub fn delete(path: impl Into<String>) -> Self {
        Self {
            method: Method::Delete,
            path: path.into(),
            body: None,
            idempotency_key: None,
        }
    }
}

/// Send an authenticated request; success (2xx) returns the parsed JSON body
/// (`Null` when empty), anything else maps through [`error_for_status`].
/// One transparent retry on 401 after re-minting the PAT.
pub async fn send(app: &tauri::AppHandle, request: Request) -> Result<Value, AppError> {
    let Some(token) = super::stored_token() else {
        return Err(AppError::new(
            "videomaker_not_activated",
            "Film production is not activated yet. Activate it in Settings > Film studio.",
        ));
    };
    let first = dispatch(&request, &token).await?;
    if first.status().as_u16() != 401 {
        return finish(first).await;
    }
    // 401 self-heal: the wallet is durable, only the PAT died. Re-mint once
    // and replay (same idempotency key, so a costly POST can't double-run).
    let token = super::auth::mint_and_store_token(app).await?;
    let second = dispatch(&request, &token).await?;
    finish(second).await
}

/// Multipart image upload (`POST /projects/{slug}/refs`). Same auth and
/// one-shot 401 self-heal as [`send`]; a multipart body cannot be replayed
/// from a builder, so the form is rebuilt per attempt.
pub async fn upload(
    app: &tauri::AppHandle,
    path: &str,
    file_name: &str,
    mime: &str,
    bytes: Vec<u8>,
) -> Result<Value, AppError> {
    let Some(token) = super::stored_token() else {
        return Err(AppError::new(
            "videomaker_not_activated",
            "Film production is not activated yet. Activate it in Settings > Film studio.",
        ));
    };
    let first = dispatch_upload(path, file_name, mime, bytes.clone(), &token).await?;
    if first.status().as_u16() != 401 {
        return finish(first).await;
    }
    let token = super::auth::mint_and_store_token(app).await?;
    let second = dispatch_upload(path, file_name, mime, bytes, &token).await?;
    finish(second).await
}

async fn dispatch_upload(
    path: &str,
    file_name: &str,
    mime: &str,
    bytes: Vec<u8>,
    token: &str,
) -> Result<reqwest::Response, AppError> {
    let url = format!("{}{}", super::api_root(), path);
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name.to_string())
        .mime_str(mime)
        .map_err(|error| AppError::new("videomaker_invalid", error.to_string()))?;
    let form = reqwest::multipart::Form::new().part("file", part);
    http_client()
        .post(&url)
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|error| {
            let base = super::base_url();
            if error.is_timeout() {
                AppError::new("videomaker_unreachable", format!("{base} timed out."))
            } else {
                AppError::new("videomaker_unreachable", format!("Couldn't reach {base}."))
            }
        })
}

async fn dispatch(request: &Request, token: &str) -> Result<reqwest::Response, AppError> {
    let url = format!("{}{}", super::api_root(), request.path);
    let client = http_client();
    let mut builder = match request.method {
        Method::Get => client.get(&url),
        Method::Post => client.post(&url),
        Method::Patch => client.patch(&url),
        Method::Put => client.put(&url),
        Method::Delete => client.delete(&url),
    };
    builder = builder.bearer_auth(token);
    if let Some(key) = &request.idempotency_key {
        builder = builder.header("Idempotency-Key", key);
    }
    if let Some(body) = &request.body {
        builder = builder.json(body);
    }
    builder.send().await.map_err(|error| {
        let base = super::base_url();
        if error.is_timeout() {
            AppError::new("videomaker_unreachable", format!("{base} timed out."))
        } else {
            AppError::new("videomaker_unreachable", format!("Couldn't reach {base}."))
        }
    })
}

async fn finish(response: reqwest::Response) -> Result<Value, AppError> {
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(body);
    }
    Err(error_for_status(status.as_u16(), body))
}

/// The Videomaker error taxonomy → stable `AppError` codes. The raw body is
/// attached as `details` so flows (409 quote, 423 final review) can read it.
pub fn error_for_status(status: u16, body: Value) -> AppError {
    let detail = body
        .get("error")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| body.get("detail").and_then(detail_message));
    let (code, fallback) = match status {
        400 | 422 => (
            "videomaker_invalid",
            "Videomaker rejected the request. Check the project inputs.",
        ),
        401 => (
            "videomaker_auth",
            "Videomaker sign-in expired and could not be renewed.",
        ),
        402 => (
            "videomaker_payment",
            "Your DIEM balance is exhausted. Top up your Carpe Diem key to keep producing.",
        ),
        403 => (
            "videomaker_forbidden",
            "Videomaker refused this action for this account.",
        ),
        404 => (
            "videomaker_not_found",
            "This film project was not found (idle projects are purged after 7 days).",
        ),
        409 => (
            "videomaker_confirm",
            "Videomaker needs a cost confirmation before starting.",
        ),
        423 => (
            "videomaker_locked",
            "The film is awaiting final review. Approve the final gate to export it.",
        ),
        429 => (
            "videomaker_rate_limited",
            "Videomaker is at a limit right now (one production at a time). Try again shortly.",
        ),
        500..=599 => (
            "videomaker_upstream",
            "Videomaker hit a server error. Try again.",
        ),
        _ => (
            "videomaker_error",
            "Videomaker returned an unexpected error.",
        ),
    };
    let mut error = AppError::new(code, detail.unwrap_or_else(|| fallback.to_string()));
    if !body.is_null() {
        error.details = Some(body);
    }
    error
}

/// A readable sentence out of FastAPI's `detail`, which is a string for plain
/// refusals, an object for the structured flows (the produce quote, the model
/// validation errors) and an array for schema validation. Without this, every
/// structured refusal degraded to the generic per-status fallback and the
/// studio's actual reason ("autonomous mode requires a positive
/// budget_ceiling_diem") never reached the user.
fn detail_message(detail: &Value) -> Option<String> {
    match detail {
        Value::String(message) => Some(message.clone()),
        Value::Object(fields) => fields
            .get("message")
            .or_else(|| fields.get("error"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                fields
                    .get("errors")
                    .and_then(Value::as_array)
                    .map(|errors| join_messages(errors))
                    .filter(|joined| !joined.is_empty())
            }),
        Value::Array(entries) => {
            let joined = join_messages(entries);
            (!joined.is_empty()).then_some(joined)
        }
        _ => None,
    }
}

fn join_messages(entries: &[Value]) -> String {
    entries
        .iter()
        .filter_map(|entry| match entry {
            Value::String(message) => Some(message.clone()),
            // Pydantic validation entries: `{"loc": [...], "msg": "..."}`.
            Value::Object(fields) => fields
                .get("msg")
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn error_codes_are_stable_per_status() {
        assert_eq!(
            error_for_status(402, Value::Null).code,
            "videomaker_payment"
        );
        assert_eq!(
            error_for_status(409, Value::Null).code,
            "videomaker_confirm"
        );
        assert_eq!(error_for_status(423, Value::Null).code, "videomaker_locked");
        assert_eq!(
            error_for_status(429, Value::Null).code,
            "videomaker_rate_limited"
        );
        assert_eq!(
            error_for_status(404, Value::Null).code,
            "videomaker_not_found"
        );
        assert_eq!(
            error_for_status(422, Value::Null).code,
            "videomaker_invalid"
        );
        assert_eq!(
            error_for_status(502, Value::Null).code,
            "videomaker_upstream"
        );
    }

    #[test]
    fn error_keeps_the_body_as_details_and_prefers_its_message() {
        let body = json!({ "error": "budget ceiling exceeded", "needs_confirmation": true });
        let error = error_for_status(409, body.clone());
        assert_eq!(error.message, "budget ceiling exceeded");
        assert_eq!(error.details, Some(body));
    }

    #[test]
    fn reads_the_studios_structured_refusals() {
        // Plain-string detail (the common refusal).
        let error = error_for_status(400, json!({ "detail": "set your CarpeDIEM key first" }));
        assert_eq!(error.message, "set your CarpeDIEM key first");
        // Structured flow payload (the produce quote).
        let error = error_for_status(
            409,
            json!({ "detail": { "needs_confirmation": true, "message": "Confirm to start." } }),
        );
        assert_eq!(error.message, "Confirm to start.");
        // Model validation (`{"detail": {"errors": [...]}}`).
        let error = error_for_status(
            400,
            json!({ "detail": { "errors": ["bad llm", "bad tts"] } }),
        );
        assert_eq!(error.message, "bad llm; bad tts");
        // Schema validation array.
        let error = error_for_status(
            422,
            json!({ "detail": [{ "loc": ["body", "prefs"], "msg": "Field required" }] }),
        );
        assert_eq!(error.message, "Field required");
    }

    #[test]
    fn costly_post_gets_an_idempotency_key() {
        let request = Request::costly_post("/projects/x/produce", json!({ "confirm": true }));
        assert!(request.idempotency_key.is_some());
        assert!(Request::get("/projects").idempotency_key.is_none());
    }
}
