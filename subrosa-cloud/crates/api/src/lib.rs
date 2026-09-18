//! Same-origin account API. Cookies never authenticate a native bearer request.
use axum::{
    Json, Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{net::SocketAddr, sync::Arc};
use subrosa_domain::{Error, Operation, Session};
use subrosa_services::{Service, hash};
use subtle::ConstantTimeEq;
use uuid::Uuid;

#[derive(Serialize)]
pub struct ApiResponse<T> {
    pub data: T,
}
fn ok<T: Serialize>(data: T) -> Json<ApiResponse<T>> {
    Json(ApiResponse { data })
}
struct ApiError(Error);
impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        Self(e)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = match self.0 {
            Error::Unauthorized => (401, "unauthorized"),
            Error::Forbidden => (403, "forbidden"),
            Error::NotFound => (404, "not_found"),
            Error::Invalid => (400, "invalid_request"),
            Error::Conflict => (409, "conflict"),
            Error::AccountMismatch => (409, "account_mismatch"),
            Error::Quota => (413, "quota_exceeded"),
            Error::RateLimited => (429, "slow_down"),
            Error::Pending => (428, "authorization_pending"),
            Error::RecentAuth => (403, "recent_auth_required"),
            Error::Unavailable => (503, "unavailable"),
        };
        let mut response = (
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(json!({"error":{"code":code,"message":self.0.to_string()}})),
        )
            .into_response();
        if status == 429 {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("5"));
        }
        response
    }
}
type Result<T> = std::result::Result<T, ApiError>;
mod pairing;

pub fn router(service: Service) -> Router {
    let state = Arc::new(service);
    let api = Router::new()
        .merge(pairing::routes())
        .route("/api/v1/me", get(me).delete(delete_me))
        .route("/api/v1/session/refresh", post(refresh_session))
        .route("/api/v1/devices", get(devices))
        .route("/api/v1/devices/{id}", axum::routing::delete(revoke_device))
        .route(
            "/api/v1/devices/{id}/name",
            axum::routing::post(rename_device),
        )
        .route("/api/v1/device-login", post(start_device))
        .route("/api/v1/device-login/approve", post(approve))
        .route("/api/v1/device-login/exchange", post(exchange_device))
        .route("/api/v1/sync", get(changes).post(append))
        .route("/api/v1/vault", get(vault).put(save_vault))
        .layer(DefaultBodyLimit::max(5 * 1024 * 1024));
    Router::new()
        .merge(api)
        .route(
            "/api/v1/blobs/{id}",
            get(blob)
                .put(upload_blob)
                .layer(DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        .route("/auth/login", get(login))
        .route("/auth/callback", get(callback))
        .route("/auth/logout", post(logout))
        .route("/livez", get(|| async { ok(json!({"status":"ok"})) }))
        .route("/readyz", get(ready))
        .fallback(|| async { ApiError(Error::NotFound) })
        .layer(tower_http::timeout::TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            std::time::Duration::from_secs(30),
        ))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}
static REQUEST_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(16);

async fn guard(State(s): State<Arc<Service>>, request: Request, next: Next) -> Response {
    let Ok(_slot) = REQUEST_SLOTS.try_acquire() else {
        return ApiError(Error::RateLimited).into_response();
    };
    let path = request.uri().path().to_owned();
    if path != "/livez" && path != "/readyz" {
        let peer = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map_or_else(|| "local-test".to_string(), |c| c.0.ip().to_string());
        let limit = if path.starts_with("/auth/") || path == "/api/v1/device-login" {
            30
        } else {
            600
        };
        // Do not trust forwarding headers from the public Internet. The ingress applies real client IP limits.
        if let Err(e) = s
            .repository
            .rate_limit(
                &hash(format!(
                    "{peer}:{}",
                    if limit == 30 { "auth" } else { "api" }
                )),
                limit,
            )
            .await
        {
            return ApiError(e).into_response();
        }
    }
    let mut response = next.run(request).await;
    if response.status().is_client_error()
        && !response
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|v| v.as_bytes().starts_with(b"application/json"))
    {
        response = ApiError(if response.status() == StatusCode::PAYLOAD_TOO_LARGE {
            Error::Quota
        } else {
            Error::Invalid
        })
        .into_response();
    }
    let h = response.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    if !s.config.development {
        h.insert(
            "strict-transport-security",
            HeaderValue::from_static("max-age=31536000"),
        );
    }
    response
}
fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut found = None;
    for header in headers.get_all(header::COOKIE) {
        for pair in header.to_str().ok()?.split(';') {
            let (key, value) = pair.trim().split_once('=')?;
            if key == name {
                if found.is_some() {
                    return None;
                }
                found = Some(value);
            }
        }
    }
    found
}
fn csrf_for(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(hash(format!("{token}:subrosa-csrf-v1")))
}
async fn session(s: &Service, h: &HeaderMap, mutating: bool) -> Result<Session> {
    if let Some(auth) = h.get(header::AUTHORIZATION) {
        let token = auth
            .to_str()
            .ok()
            .and_then(|a| a.strip_prefix("Bearer "))
            .ok_or(Error::Unauthorized)?;
        return assert_account(h, s.authenticate(token, false).await?);
    }
    let token = cookie(h, s.config.session_cookie()).ok_or(Error::Unauthorized)?;
    if mutating {
        if h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(s.config.public_url.as_str())
        {
            return Err(Error::Forbidden.into());
        }
        let csrf = h
            .get("x-csrf-token")
            .and_then(|v| v.to_str().ok())
            .ok_or(Error::Forbidden)?;
        let expected = csrf_for(token);
        if !bool::from(expected.as_bytes().ct_eq(csrf.as_bytes()))
            || cookie(h, "subrosa_csrf") != Some(csrf)
        {
            return Err(Error::Forbidden.into());
        }
    }
    assert_account(h, s.authenticate(token, true).await?)
}
// The asserted account is a client-side context guard, never an authorization source.
// In particular, an unlocked tab must not encrypt with A's key after another tab
// replaces the shared browser session cookie with account B's session.
fn assert_account(headers: &HeaderMap, session: Session) -> Result<Session> {
    let mut values = headers.get_all("x-subrosa-account-id").iter();
    if let Some(value) = values.next() {
        let expected = value
            .to_str()
            .ok()
            .and_then(|value| Uuid::parse_str(value).ok());
        if values.next().is_some() || expected != Some(session.account.id) {
            return Err(Error::AccountMismatch.into());
        }
    }
    Ok(session)
}

fn set_cookie(
    response: &mut Response,
    s: &Service,
    name: &str,
    value: &str,
    http_only: bool,
    max_age: i64,
) -> Result<()> {
    let value = format!(
        "{name}={value}; Path=/; SameSite=Lax; Max-Age={max_age}{}{}",
        if http_only { "; HttpOnly" } else { "" },
        if s.config.development { "" } else { "; Secure" }
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&value).map_err(|_| Error::Unavailable)?,
    );
    Ok(())
}
#[derive(Deserialize)]
struct LoginQuery {
    #[serde(default = "account_path")]
    return_to: String,
    #[serde(default)]
    intent: Option<String>,
}
fn account_path() -> String {
    "/account".into()
}
async fn login(State(s): State<Arc<Service>>, Query(q): Query<LoginQuery>) -> Result<Response> {
    if q.intent
        .as_ref()
        .is_some_and(|i| i != "signin" && i != "signup")
    {
        return Err(Error::Invalid.into());
    }
    let register = q.intent.as_deref() == Some("signup");
    let (url, browser) = s.login(&q.return_to, register).await?;
    let mut r = Redirect::to(&url).into_response();
    set_cookie(
        &mut r,
        &s,
        s.config.flow_cookie(),
        browser.expose(),
        true,
        600,
    )?;
    Ok(r)
}
#[derive(Deserialize)]
struct CallbackQuery {
    state: String,
    code: String,
}
async fn callback(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Query(q): Query<CallbackQuery>,
) -> Result<Response> {
    let browser = cookie(&h, s.config.flow_cookie()).ok_or(Error::Unauthorized)?;
    let (return_to, token) = s.callback(&q.state, browser, &q.code).await?;
    let mut r = Redirect::to(&return_to).into_response();
    set_cookie(
        &mut r,
        &s,
        s.config.session_cookie(),
        token.expose(),
        true,
        43200,
    )?;
    set_cookie(
        &mut r,
        &s,
        "subrosa_csrf",
        &csrf_for(token.expose()),
        false,
        43200,
    )?;
    set_cookie(&mut r, &s, s.config.flow_cookie(), "", true, 0)?;
    Ok(r)
}
async fn logout(State(s): State<Arc<Service>>, h: HeaderMap) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    s.repository.logout(&a.token_hash).await?;
    let mut r = ok(json!({"signed_out":true})).into_response();
    set_cookie(&mut r, &s, s.config.session_cookie(), "", true, 0)?;
    set_cookie(&mut r, &s, "subrosa_csrf", "", false, 0)?;
    Ok(r)
}
async fn me(State(s): State<Arc<Service>>, h: HeaderMap) -> Result<Response> {
    Ok(ok(session(&s, &h, false).await?.account).into_response())
}
async fn delete_me(State(s): State<Arc<Service>>, h: HeaderMap) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    s.delete_account(&a).await?;
    let mut r = ok(json!({"deleted":true})).into_response();
    set_cookie(&mut r, &s, s.config.session_cookie(), "", true, 0)?;
    set_cookie(&mut r, &s, "subrosa_csrf", "", false, 0)?;
    Ok(r)
}
async fn devices(State(s): State<Arc<Service>>, h: HeaderMap) -> Result<Response> {
    let a = session(&s, &h, false).await?;
    Ok(ok(s.repository.devices(a.account.id).await?).into_response())
}
async fn revoke_device(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    Service::recent(&a)?;
    s.repository.revoke_device(a.account.id, id).await?;
    Ok(ok(json!({"revoked":true})).into_response())
}
#[derive(Deserialize)]
struct DeviceName {
    name: String,
}
/// Renaming is a label change on a device you already own, so it asks for a
/// browser session but not the step-up that revoking does: nothing it can do
/// changes, and a name you cannot correct is how the list became unreadable.
async fn rename_device(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<DeviceName>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(Error::Invalid.into());
    }
    s.repository.rename_device(a.account.id, id, name).await?;
    Ok(ok(json!({"name": name})).into_response())
}
#[derive(Deserialize)]
struct DeviceStart {
    challenge: String,
    device_name: String,
}
async fn start_device(
    State(s): State<Arc<Service>>,
    Json(b): Json<DeviceStart>,
) -> Result<Response> {
    Ok(ok(s.start_device(&b.challenge, &b.device_name).await?).into_response())
}
#[derive(Deserialize)]
struct Approve {
    user_code: String,
}
async fn approve(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Json(b): Json<Approve>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    s.approve(&a, &b.user_code).await?;
    Ok(ok(json!({"approved":true})).into_response())
}
#[derive(Deserialize)]
struct Exchange {
    request_id: Uuid,
    verifier: String,
}
async fn exchange_device(
    State(s): State<Arc<Service>>,
    Json(b): Json<Exchange>,
) -> Result<Response> {
    Ok(ok(s.exchange_device(b.request_id, &b.verifier).await?).into_response())
}
#[derive(Deserialize)]
struct Cursor {
    #[serde(default)]
    after: i64,
    #[serde(default = "page_size")]
    limit: i64,
    kind: Option<String>,
}
fn page_size() -> i64 {
    100
}
async fn changes(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Query(q): Query<Cursor>,
) -> Result<Response> {
    let a = session(&s, &h, false).await?;
    if q.after < 0 || !(1..=500).contains(&q.limit) {
        return Err(Error::Invalid.into());
    }
    Ok(ok(s.changes(&a, q.after, q.limit, q.kind.as_deref()).await?).into_response())
}
#[derive(Deserialize)]
struct Push {
    operations: Vec<Operation>,
}
async fn append(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Json(b): Json<Push>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    Ok(ok(json!({"results":s.append(&a,b.operations).await?})).into_response())
}
async fn vault(State(s): State<Arc<Service>>, h: HeaderMap) -> Result<Response> {
    let a = session(&s, &h, false).await?;
    Ok(ok(s.repository.vault(a.account.id).await?).into_response())
}
#[derive(Deserialize)]
struct VaultWrite {
    expected_version: i64,
    envelope: Value,
}
async fn save_vault(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Json(b): Json<VaultWrite>,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    Ok(
        ok(json!({"version":s.save_vault(&a,b.expected_version,&b.envelope).await?}))
            .into_response(),
    )
}
async fn blob(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response> {
    let a = session(&s, &h, false).await?;
    let bytes = s.blob(&a, id).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CONTENT_DISPOSITION, "attachment"),
        ],
        bytes,
    )
        .into_response())
}
async fn upload_blob(
    State(s): State<Arc<Service>>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    body: Bytes,
) -> Result<Response> {
    let a = session(&s, &h, true).await?;
    if h.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()) != Some("application/octet-stream")
    {
        return Err(Error::Invalid.into());
    }
    let bytes = s.upload_blob(&a, id, body.to_vec()).await?;
    Ok(ok(json!({"id":id,"bytes":bytes})).into_response())
}
async fn ready(State(s): State<Arc<Service>>) -> Result<Response> {
    s.repository.healthy().await?;
    Ok(ok(json!({"status":"ready"})).into_response())
}

#[derive(Deserialize)]
struct Refresh {
    refresh_token: subrosa_domain::Secret,
}
async fn refresh_session(
    State(s): State<Arc<Service>>,
    Json(b): Json<Refresh>,
) -> Result<Response> {
    Ok(ok(s.refresh_session(b.refresh_token.expose()).await?).into_response())
}
