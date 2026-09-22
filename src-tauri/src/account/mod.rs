//! Optional account service. Identity tokens and decryption keys never cross
//! the webview boundary. Signing out leaves local work intact.
pub mod conversations;
pub mod crypto;
mod files;
pub mod login;
pub mod pairing;
pub mod shares;
pub(crate) mod studio;
mod summaries;
pub mod sync;
use crate::{domain::types::AppError, redacted::Redacted};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{query::query, row::Row};
use sqlx_sqlite::SqlitePool;
use std::{
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::AppHandle;
use zeroize::Zeroizing;

#[cfg(debug_assertions)]
const SERVICE: &str = "xyz.carpediem.subrosa-dev.accounts";
#[cfg(not(debug_assertions))]
const SERVICE: &str = "xyz.carpediem.subrosa.accounts";
/// The proof that lets this device mint a session again without a browser. It
/// is not rotated: a lost rotation response would strand the device for good
/// (ADR 0056).
const DEVICE: &str = "device";
static LOGIN: OnceLock<Mutex<Option<PendingLogin>>> = OnceLock::new();
static SESSION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
struct PendingLogin {
    base: String,
    request_id: String,
    verifier: Redacted<String>,
    started: Instant,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub email: String,
    pub created_at: String,
}
#[derive(Serialize)]
pub struct AccountStatus {
    pub default_server_url: &'static str,
    pub server_url: Option<String>,
    pub account: Option<Account>,
    pub device_id: Option<String>,
    /// "none", "connected" or "renewable". "renewable" is the state that did
    /// not exist before: no live session, but this device holds a secret that
    /// mints one without a browser, so the panel keeps working.
    pub connection: &'static str,
    pub device_authorized: bool,
    pub login_pending: bool,
    pub pairing_pending: bool,
    pub vault_unlocked: bool,
    pub vault_exists: Option<bool>,
    pub recovery_confirmed: bool,
    pub recovery_available: bool,
    pub sync_enabled: bool,
    pub pending_changes: i64,
    pub conflicts: i64,
    pub last_synced_at: Option<String>,
    pub last_sync_error: Option<String>,
}
#[derive(Serialize, Deserialize)]
pub struct DeviceLogin {
    pub request_id: String,
    pub verification_uri: String,
    pub user_code: String,
    pub expires_at: String,
    pub interval_seconds: u64,
}
#[derive(Serialize)]
pub struct RecoveryKit {
    pub recovery_key: String,
}
pub(super) struct Session {
    pub base: String,
    pub account: Account,
    pub token: Redacted<String>,
}
pub(super) async fn pool(app: &AppHandle) -> Result<SqlitePool, AppError> {
    Ok(crate::commands::repositories(app).await?.pool.clone())
}
fn error(code: &str) -> AppError {
    AppError::new(
        code,
        match code {
            "account_not_connected" => "Connect your account to continue.",
            "account_offline" => {
                "Your account service could not be reached. Your work is safe and will sync later."
            }
            "account_revoked" => {
                "This device was signed out from your account. Sign in again to reconnect it."
            }
            "account_network" => {
                "Your account service could not be reached. Your local work is safe."
            }
            "account_keychain" => "Your system credential store is unavailable.",
            "account_bound" => "This local library is linked to another account or server.",
            "vault_locked" => "Unlock your encrypted vault with your recovery kit.",
            "recovery_unconfirmed" => {
                "Save and confirm your recovery kit before enabling synchronization."
            }
            "authorization_pending" => "Approve this device in your browser.",
            "share_window_invalid" => "Choose how long the link should work.",
            "share_too_large" => "This is too large to share as a link.",
            "share_failed" => "The link could not be created.",
            _ => "The account operation could not be completed.",
        },
    )
}
fn slot(base: &str, id: &str, kind: &str) -> String {
    format!(
        "{}:{id}:{kind}",
        crypto::encode(&Sha256::digest(base.as_bytes()))
    )
}
fn put_secret(base: &str, id: &str, kind: &str, value: &str) -> Result<(), AppError> {
    keyring::Entry::new(SERVICE, &slot(base, id, kind))
        .and_then(|e| e.set_password(value))
        .map_err(|_| error("account_keychain"))
}
fn get_secret(base: &str, id: &str, kind: &str) -> Result<Option<Redacted<String>>, AppError> {
    match keyring::Entry::new(SERVICE, &slot(base, id, kind)).and_then(|e| e.get_password()) {
        Ok(s) => Ok(Some(Redacted::new(s))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(error("account_keychain")),
    }
}
fn remove_secret(base: &str, id: &str, kind: &str) -> Result<(), AppError> {
    match keyring::Entry::new(SERVICE, &slot(base, id, kind)).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(error("account_keychain")),
    }
}
/// Used only after the person chooses account sign-in. Local-only startup does
/// not configure this origin, create an account, or contact the service.
const DEFAULT_ACCOUNT_SERVER: &str = "https://subrosa.furetier.com";

pub fn validate_server(value: &str) -> Result<String, AppError> {
    let url = reqwest::Url::parse(value.trim()).map_err(|_| error("account_server_invalid"))?;
    let loopback = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if (url.scheme() != "https" && !(cfg!(debug_assertions) && loopback && url.scheme() == "http"))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(error("account_server_invalid"));
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}
/// The account site this library belongs to: the origin it is bound to, or
/// the default one. Read-only, unlike `login_server`, which binds it.
pub(crate) async fn site_origin(app: &AppHandle) -> String {
    let bound = match pool(app).await {
        Ok(pool) => query("SELECT server_url FROM account_sync_control WHERE id=1")
            .fetch_optional(&pool)
            .await
            .ok()
            .flatten()
            .and_then(|row| row.get::<Option<String>, _>("server_url")),
        Err(_) => None,
    };
    bound
        .and_then(|base| validate_server(&base).ok())
        .unwrap_or_else(|| DEFAULT_ACCOUNT_SERVER.to_string())
}
pub(super) async fn session(pool: &SqlitePool) -> Result<Session, AppError> {
    let _refresh_guard = REFRESH_LOCK.lock().await;
    let row =
        query("SELECT server_url,account_json,device_id FROM account_sync_control WHERE id=1")
            .fetch_one(pool)
            .await?;
    let base: String = row
        .get::<Option<String>, _>("server_url")
        .ok_or_else(|| error("account_not_connected"))?;
    let account: Account = serde_json::from_str(
        &row.get::<Option<String>, _>("account_json")
            .ok_or_else(|| error("account_not_connected"))?,
    )
    .map_err(|_| error("account_not_connected"))?;
    let device: Option<String> = row.get("device_id");
    // Every path that used to end in "sign in again in a browser" now tries the
    // device secret first. That is the whole of ADR 0056 from this side.
    let Some(stored) = get_secret(&base, &account.id, "session")? else {
        return renew(pool, &base, account, device.as_deref()).await;
    };
    // Pre-refresh builds stored just an access token. They remain usable until
    // server expiry, then fall through to a renewal or a fresh sign-in.
    let Ok(mut bundle) = serde_json::from_str::<Value>(stored.expose_str()) else {
        return Ok(Session {
            base,
            account,
            token: stored,
        });
    };
    if bundle["refresh_in_flight"] == true {
        remove_secret(&base, &account.id, "session")?;
        return renew(pool, &base, account, device.as_deref()).await;
    }
    if refresh_due(&bundle)? {
        let refresh = Redacted::new(
            bundle["refresh_token"]
                .as_str()
                .ok_or_else(|| error("account_not_connected"))?
                .to_string(),
        );
        // A durable marker distinguishes a normal retry from a refresh whose
        // response was lost when the process was killed or its future timed out.
        bundle["refresh_in_flight"] = json!(true);
        put_secret(
            &base,
            &account.id,
            "session",
            &Zeroizing::new(bundle.to_string()),
        )?;
        let next = request(
            &base,
            None,
            reqwest::Method::POST,
            "/api/v1/session/refresh",
            Some(json!({"refresh_token":refresh.expose_str()})),
        )
        .await;
        let Ok(next) = next else {
            // A lost response may have consumed this refresh token. Retrying it
            // would revoke the family, so the family is abandoned and the device
            // secret mints a new one instead.
            remove_secret(&base, &account.id, "session")?;
            return renew(pool, &base, account, device.as_deref()).await;
        };
        if next["account"]["id"] != account.id || next["device_id"].as_str() != device.as_deref() {
            remove_secret(&base, &account.id, "session")?;
            return Err(error("account_response_invalid"));
        }
        validate_session_bundle(&next)?;
        let encoded = Zeroizing::new(next.to_string());
        if let Err(failure) = put_secret(&base, &account.id, "session", &encoded) {
            let _ = remove_secret(&base, &account.id, "session");
            return Err(failure);
        }
        bundle = next;
    }
    let token = Redacted::new(
        bundle["access_token"]
            .as_str()
            .ok_or_else(|| error("account_not_connected"))?
            .to_string(),
    );
    Ok(Session {
        base,
        account,
        token,
    })
}
/// A session again, from the device secret, with no browser anywhere. Three
/// outcomes worth telling apart: there is no secret to use, the service cannot
/// be reached, or the service refused the proof.
async fn renew(
    pool: &SqlitePool,
    base: &str,
    account: Account,
    device: Option<&str>,
) -> Result<Session, AppError> {
    let (Some(device), Some(secret)) = (device, get_secret(base, &account.id, DEVICE)?) else {
        return Err(error("account_not_connected"));
    };
    // A restart loop must not become a request loop. The stamp is written
    // before the attempt and cleared when one succeeds, so only consecutive
    // failures are held back.
    let last: Option<String> =
        query("SELECT renew_attempted_at FROM account_sync_control WHERE id=1")
            .fetch_one(pool)
            .await?
            .get("renew_attempted_at");
    let now = chrono::Utc::now();
    if last
        .as_deref()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .is_some_and(|at| now.signed_duration_since(at).num_seconds() < 30)
    {
        return Err(error("account_offline"));
    }
    query("UPDATE account_sync_control SET renew_attempted_at=? WHERE id=1")
        .bind(now.to_rfc3339())
        .execute(pool)
        .await?;
    let next = request(
        base,
        None,
        reqwest::Method::POST,
        "/api/v1/session/renew",
        Some(json!({"device_id":device,"device_secret":secret.expose_str()})),
    )
    .await;
    let next = match next {
        Ok(next) => next,
        Err(failure) if failure.code == "account_network" => return Err(error("account_offline")),
        Err(_) => {
            // The proof was refused: this device was signed out or revoked from
            // somewhere else. Access goes, the vault key stays where it is.
            let _ = remove_secret(base, &account.id, DEVICE);
            let _ = remove_secret(base, &account.id, "session");
            return Err(error("account_revoked"));
        }
    };
    if next["account"]["id"] != account.id || next["device_id"].as_str() != Some(device) {
        return Err(error("account_response_invalid"));
    }
    validate_session_bundle(&next)?;
    put_secret(
        base,
        &account.id,
        "session",
        &Zeroizing::new(next.to_string()),
    )?;
    query("UPDATE account_sync_control SET renew_attempted_at=NULL WHERE id=1")
        .execute(pool)
        .await?;
    let token = Redacted::new(
        next["access_token"]
            .as_str()
            .ok_or_else(|| error("account_response_invalid"))?
            .to_string(),
    );
    Ok(Session {
        base: base.to_string(),
        account,
        token,
    })
}
/// Writes everything an exchange just earned: the token bundle, the device
/// secret that makes this the last browser visit, and the account binding.
/// Shared by the native sign-in and the code flow so they cannot drift.
pub(super) async fn install_session(
    pool: &SqlitePool,
    base: &str,
    bound: &Option<String>,
    result: &Value,
) -> Result<(), AppError> {
    let account: Account = serde_json::from_value(result["account"].clone())
        .map_err(|_| error("account_response_invalid"))?;
    if bound.as_ref().is_some_and(|id| *id != account.id) {
        return Err(error("account_bound"));
    }
    validate_session_bundle(result)?;
    let device = result["device_id"]
        .as_str()
        .ok_or_else(|| error("account_response_invalid"))?;
    // One home for the device secret. It is stripped from the session bundle so
    // a rotated session never quietly carries a second copy of it.
    let mut bundle = result.clone();
    let secret = bundle
        .as_object_mut()
        .and_then(|b| b.remove("device_secret"));
    put_secret(
        base,
        &account.id,
        "session",
        &Zeroizing::new(bundle.to_string()),
    )?;
    if let Some(secret) = secret.as_ref().and_then(Value::as_str) {
        crypto::decode_key(secret).map_err(|_| error("account_response_invalid"))?;
        put_secret(
            base,
            &account.id,
            DEVICE,
            &Zeroizing::new(secret.to_string()),
        )?;
    }
    query("UPDATE account_sync_control SET account_id=?,account_json=?,device_id=?,renew_attempted_at=NULL WHERE id=1")
        .bind(&account.id)
        .bind(serde_json::to_string(&account).map_err(|_| error("account_response_invalid"))?)
        .bind(device)
        .execute(pool)
        .await?;
    Ok(())
}
/// Asks whether this account has a vault yet, so the panel offers "open" or
/// "create" rather than guessing. Best effort on purpose: a sign-in that
/// already stored its credentials must not be reported as failed because one
/// extra probe did not answer. Both ways in call it, so neither drifts.
pub(super) async fn note_vault_presence(pool: &SqlitePool) {
    let Ok(s) = session(pool).await else {
        return;
    };
    let exists = match call(&s, reqwest::Method::GET, "/api/v1/vault", None).await {
        Ok(_) => Some(true),
        Err(e) if e.code == "vault_not_found" => Some(false),
        Err(_) => return,
    };
    let _ = query("UPDATE account_sync_control SET vault_exists=? WHERE id=1")
        .bind(exists)
        .execute(pool)
        .await;
}
/// Keeps a connected account reachable even while synchronisation is paused.
/// Pausing stops data moving, not the identity: the explicit act ADR 0049 asks
/// for was signing in, and it already happened.
pub(crate) async fn keep_alive(app: &AppHandle) {
    let Ok(pool) = pool(app).await else {
        return;
    };
    let Ok(row) = query("SELECT account_id FROM account_sync_control WHERE id=1")
        .fetch_one(&pool)
        .await
    else {
        return;
    };
    if row.get::<Option<String>, _>("account_id").is_some() {
        let _ = session(&pool).await;
    }
}
fn validate_session_bundle(bundle: &Value) -> Result<(), AppError> {
    for field in [
        "access_token",
        "refresh_token",
        "expires_at",
        "refresh_expires_at",
    ] {
        if bundle[field]
            .as_str()
            .map_or(true, |s| s.is_empty() || s.len() > 8192)
        {
            return Err(error("account_response_invalid"));
        }
    }
    Ok(())
}
fn refresh_due(bundle: &Value) -> Result<bool, AppError> {
    validate_session_bundle(bundle)?;
    let expires = chrono::DateTime::parse_from_rfc3339(
        bundle["expires_at"]
            .as_str()
            .ok_or_else(|| error("account_response_invalid"))?,
    )
    .map_err(|_| error("account_response_invalid"))?;
    Ok(expires
        .signed_duration_since(chrono::Utc::now())
        .num_seconds()
        <= 120)
}

pub(super) fn vault_key(session: &Session) -> Result<Zeroizing<[u8; 32]>, AppError> {
    vault_key_for(&session.base, &session.account.id)
}
/// Whether the vault is open is a question about this device's keyring, not
/// about whether a session happens to be alive right now. Tying the two
/// together is what made a signed-out app claim a locked vault and send people
/// looking for a recovery key they never needed.
fn vault_key_for(base: &str, account_id: &str) -> Result<Zeroizing<[u8; 32]>, AppError> {
    let value = get_secret(base, account_id, "vault")?.ok_or_else(|| error("vault_locked"))?;
    crypto::decode_key(value.expose_str())
}
/// What the screen should say about reaching the service. "renewable" is the
/// state that used to be indistinguishable from a locked vault: there is no
/// live session, but this device can get one back on its own.
fn connection_state(bound: bool, connected: bool, device: bool) -> &'static str {
    match (bound, connected, device) {
        // The library keeps its account binding after signing out, on purpose,
        // so a binding with no credential left is not a signed-in device: it is
        // the state that shows the sign-in card.
        (false, _, _) | (true, false, false) => "none",
        (true, true, _) => "connected",
        (true, false, true) => "renewable",
    }
}
/// True while the stored bundle still has usable time on it. A pre-refresh
/// bare token cannot say, and is taken at its word until the service disagrees.
fn session_live(stored: &Redacted<String>) -> bool {
    match serde_json::from_str::<Value>(stored.expose_str()) {
        Ok(bundle) => {
            bundle["refresh_in_flight"] != true
                && bundle["expires_at"]
                    .as_str()
                    .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
                    .is_some_and(|at| at > chrono::Utc::now())
        }
        Err(_) => true,
    }
}
pub(super) async fn request(
    base: &str,
    token: Option<&Redacted<String>>,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, AppError> {
    let client = crate::http_client::credentialed(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| error("account_network"))?;
    let started = Instant::now();
    let method_name = method.as_str().to_string();
    let request_bytes = body.as_ref().map_or(0, |v| v.to_string().len() as u64);
    let mut req = client.request(method, format!("{base}{path}"));
    if let Some(token) = token {
        req = req.bearer_auth(token.expose_str());
    }
    if let Some(body) = body {
        req = req.json(&body);
    }
    let mut response = req.send().await.map_err(|_| error("account_network"))?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|n| n > 16 * 1024 * 1024)
    {
        return Err(error("account_response_invalid"));
    }
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| error("account_network"))?
    {
        if bytes.len() + chunk.len() > 16 * 1024 * 1024 {
            return Err(error("account_response_invalid"));
        }
        bytes.extend_from_slice(&chunk);
    }
    crate::egress_ledger::record(crate::egress_ledger::EgressEntry {
        at: chrono::Utc::now().to_rfc3339(),
        host: reqwest::Url::parse(base)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default(),
        purpose: "account synchronization".into(),
        method: method_name,
        request_bytes,
        response_bytes: bytes.len() as u64,
        status: Some(status.as_u16()),
        duration_ms: started.elapsed().as_millis() as u64,
        model: None,
        note_id: None,
    });
    if status == reqwest::StatusCode::NO_CONTENT {
        return Ok(Value::Null);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| error("account_response_invalid"))?;
    if !status.is_success() {
        let code = value
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or("account_request_failed");
        return Err(error(match code {
            "authorization_pending" | "slow_down" => "authorization_pending",
            "recent_auth_required" | "reauthentication_required" => "recent_auth_required",
            "not_found" | "vault_not_found" => "vault_not_found",
            _ if status.as_u16() == 404 => "vault_not_found",
            _ if status.as_u16() == 401 => "account_not_connected",
            _ if status.as_u16() == 409 => "account_conflict",
            _ => "account_request_failed",
        }));
    }
    value
        .get("data")
        .cloned()
        .ok_or_else(|| error("account_response_invalid"))
}
async fn call(
    s: &Session,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, AppError> {
    request(&s.base, Some(&s.token), method, path, body).await
}
#[tauri::command]
pub async fn account_status(app: AppHandle) -> Result<AccountStatus, AppError> {
    let pool = pool(&app).await?;
    let row = query("SELECT * FROM account_sync_control WHERE id=1")
        .fetch_one(&pool)
        .await?;
    // Observing status never refreshes and never contacts the network. Identity
    // comes from the database; whether there is a way back to the service, and
    // whether the vault is open, are two separate keyring questions.
    let base: Option<String> = row.get("server_url");
    let account = row
        .get::<Option<String>, _>("account_json")
        .and_then(|raw| serde_json::from_str::<Account>(&raw).ok());
    let identity = base.clone().zip(account.clone());
    let device_authorized = identity.as_ref().is_some_and(|(base, account)| {
        get_secret(base, &account.id, DEVICE)
            .ok()
            .flatten()
            .is_some()
    });
    let connected = identity.as_ref().is_some_and(|(base, account)| {
        get_secret(base, &account.id, "session")
            .ok()
            .flatten()
            .is_some_and(|stored| session_live(&stored))
    });
    let connection = connection_state(identity.is_some(), connected, device_authorized);
    // Whether there is a credential decides what the panel shows. Whether the
    // vault is open is asked separately, of the keyring, and stays true across
    // a session this device can get back on its own.
    let signed_in = connection != "none";
    Ok(AccountStatus {
        default_server_url: DEFAULT_ACCOUNT_SERVER,
        server_url: row.get("server_url"),
        device_id: if signed_in { row.get("device_id") } else { None },
        connection,
        device_authorized,
        login_pending: base.as_deref().is_some_and(login::has_pending),
        pairing_pending: identity
            .as_ref()
            .is_some_and(|(base, account)| pairing::has_pending(base, &account.id)),
        vault_unlocked: identity
            .as_ref()
            .is_some_and(|(base, account)| vault_key_for(base, &account.id).is_ok()),
        vault_exists: row.get::<Option<i64>, _>("vault_exists").map(|x| x != 0),
        recovery_confirmed: row.get::<i64, _>("recovery_confirmed") != 0,
        recovery_available: identity.as_ref().is_some_and(|(base, account)| {
            ["recovery", "pending-recovery"]
                .iter()
                .any(|kind| get_secret(base, &account.id, kind).ok().flatten().is_some())
        }),
        account: if signed_in { account } else { None },
        sync_enabled: row.get::<i64, _>("enabled") != 0,
        pending_changes: files::pending_transfers(&pool).await?
            + query("SELECT (SELECT count(*) FROM account_sync_outbox)+(SELECT count(*) FROM account_sync_inbox WHERE applied=0) AS n")
                .fetch_one(&pool)
                .await?
                .get::<i64, _>("n"),
        conflicts: query("SELECT count(*) AS n FROM account_sync_conflicts WHERE resolved=0")
            .fetch_one(&pool)
            .await?
            .get("n"),
        last_synced_at: row.get("last_synced_at"),
        last_sync_error: row.get("last_sync_error"),
    })
}
#[tauri::command]
pub async fn account_configure(
    app: AppHandle,
    server_url: String,
) -> Result<AccountStatus, AppError> {
    let _guard = SESSION_LOCK.lock().await;
    let base = validate_server(&server_url)?;
    let pool = pool(&app).await?;
    let row = query("SELECT server_url,account_id FROM account_sync_control WHERE id=1")
        .fetch_one(&pool)
        .await?;
    if row.get::<Option<String>, _>("account_id").is_some()
        && row.get::<Option<String>, _>("server_url").as_deref() != Some(&base)
    {
        return Err(error("account_bound"));
    }
    query("UPDATE account_sync_control SET server_url=? WHERE id=1")
        .bind(base)
        .execute(&pool)
        .await?;
    account_status(app).await
}
#[tauri::command]
pub async fn account_login_start(
    app: AppHandle,
    device_name: String,
) -> Result<DeviceLogin, AppError> {
    let _guard = SESSION_LOCK.lock().await;
    let pool = pool(&app).await?;
    if device_name.trim().is_empty() || device_name.len() > 100 {
        return Err(error("account_device_name_invalid"));
    }
    let base = login_server(&pool).await?;
    let verifier = crypto::encode(&*crypto::random_key());
    let challenge = crypto::encode(&Sha256::digest(verifier.as_bytes()));
    let result = request(
        &base,
        None,
        reqwest::Method::POST,
        "/api/v1/device-login",
        Some(json!({"device_name":device_name,"challenge":challenge})),
    )
    .await?;
    let login: DeviceLogin =
        serde_json::from_value(result).map_err(|_| error("account_response_invalid"))?;
    let verification = reqwest::Url::parse(&login.verification_uri)
        .map_err(|_| error("account_response_invalid"))?;
    let origin = reqwest::Url::parse(&base).map_err(|_| error("account_response_invalid"))?;
    if verification.origin() != origin.origin() {
        return Err(error("account_response_invalid"));
    }
    *LOGIN
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| error("account_busy"))? = Some(PendingLogin {
        base: base.clone(),
        request_id: login.request_id.clone(),
        verifier: Redacted::new(verifier),
        started: Instant::now(),
    });
    Ok(login)
}

async fn login_server(pool: &SqlitePool) -> Result<String, AppError> {
    // Preserve a configured or previously account-bound library's exact origin.
    // This helper is called under SESSION_LOCK, only for explicit sign-in.
    let base: String = query(
        "UPDATE account_sync_control SET server_url=coalesce(server_url,?) WHERE id=1 RETURNING server_url",
    )
    .bind(DEFAULT_ACCOUNT_SERVER)
    .fetch_one(pool)
    .await?
    .get("server_url");
    validate_server(&base)
}
#[tauri::command]
pub async fn account_login_exchange(
    app: AppHandle,
    request_id: String,
) -> Result<AccountStatus, AppError> {
    let _guard = SESSION_LOCK.lock().await;
    let (verifier, login_base) = {
        let guard = LOGIN
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| error("account_busy"))?;
        let pending = guard
            .as_ref()
            .ok_or_else(|| error("account_login_expired"))?;
        if pending.request_id != request_id || pending.started.elapsed() > Duration::from_secs(900)
        {
            return Err(error("account_login_expired"));
        }
        (pending.verifier.clone(), pending.base.clone())
    };
    let pool = pool(&app).await?;
    let row = query("SELECT server_url,account_id FROM account_sync_control WHERE id=1")
        .fetch_one(&pool)
        .await?;
    let base: String = row
        .get::<Option<String>, _>("server_url")
        .ok_or_else(|| error("account_not_connected"))?;
    if base != login_base {
        return Err(error("account_login_expired"));
    }
    let result = request(
        &base,
        None,
        reqwest::Method::POST,
        "/api/v1/device-login/exchange",
        Some(json!({"request_id":request_id,"verifier":verifier.expose_str()})),
    )
    .await?;
    install_session(
        &pool,
        &base,
        &row.get::<Option<String>, _>("account_id"),
        &result,
    )
    .await?;
    *LOGIN
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| error("account_busy"))? = None;
    note_vault_presence(&pool).await;
    account_status(app).await
}
#[tauri::command]
pub async fn account_devices(app: AppHandle) -> Result<Value, AppError> {
    let s = session(&pool(&app).await?).await?;
    call(&s, reqwest::Method::GET, "/api/v1/devices", None).await
}
#[tauri::command]
pub async fn account_revoke_device(app: AppHandle, device_id: String) -> Result<(), AppError> {
    let _guard = SESSION_LOCK.lock().await;
    uuid::Uuid::parse_str(&device_id).map_err(|_| error("account_device_invalid"))?;
    let pool = pool(&app).await?;
    let s = session(&pool).await?;
    call(
        &s,
        reqwest::Method::DELETE,
        &format!("/api/v1/devices/{device_id}"),
        None,
    )
    .await?;
    let current: Option<String> = query("SELECT device_id FROM account_sync_control WHERE id=1")
        .fetch_one(&pool)
        .await?
        .get("device_id");
    if current.as_deref() == Some(&device_id) {
        query("UPDATE account_sync_control SET enabled=0 WHERE id=1")
            .execute(&pool)
            .await?;
        let _refresh_guard = REFRESH_LOCK.lock().await;
        clear_all_secrets(|kind| remove_secret(&s.base, &s.account.id, kind))?;
    }
    Ok(())
}
#[tauri::command]
pub async fn account_logout(app: AppHandle) -> Result<AccountStatus, AppError> {
    let _guard = SESSION_LOCK.lock().await;
    let refresh_guard = REFRESH_LOCK.lock().await;
    let pool = pool(&app).await?;
    query("UPDATE account_sync_control SET enabled=0 WHERE id=1")
        .execute(&pool)
        .await?;
    let row = query("SELECT server_url,account_id,device_id FROM account_sync_control WHERE id=1")
        .fetch_one(&pool)
        .await?;
    if let (Some(base), Some(id)) = (
        row.get::<Option<String>, _>("server_url"),
        row.get::<Option<String>, _>("account_id"),
    ) {
        // Logout is local even offline or after an interrupted refresh. It must
        // never depend on refreshing the very session being deleted.
        let token = get_secret(&base, &id, "session")
            .ok()
            .flatten()
            .and_then(
                |stored| match serde_json::from_str::<Value>(stored.expose_str()) {
                    Ok(bundle) => bundle["access_token"]
                        .as_str()
                        .map(|v| Redacted::new(v.to_string())),
                    Err(_) => Some(stored),
                },
            );
        // Read the device proof before the slots go: signing out on the device
        // itself needs no step-up, which is what makes it actually work. The
        // old path asked the service to revoke by bearer, and that route wants
        // an authentication under five minutes old, so signing out later in the
        // day silently left the device listed as live.
        let device = row.get::<Option<String>, _>("device_id");
        let proof = device
            .as_deref()
            .and_then(|_| get_secret(&base, &id, DEVICE).ok().flatten());
        let cleanup = clear_all_secrets(|kind| remove_secret(&base, &id, kind));
        login::forget_pending(&base);
        match (device.as_deref(), proof.as_ref(), token.as_ref()) {
            (Some(device), Some(proof), _) => {
                let _ = request(
                    &base,
                    None,
                    reqwest::Method::POST,
                    "/api/v1/session/renounce",
                    Some(json!({"device_id":device,"device_secret":proof.expose_str()})),
                )
                .await;
            }
            (Some(device), None, Some(token)) => {
                let _ = request(
                    &base,
                    Some(token),
                    reqwest::Method::DELETE,
                    &format!("/api/v1/devices/{device}"),
                    None,
                )
                .await;
            }
            _ => {}
        }
        cleanup?;
    }
    drop(refresh_guard);
    account_status(app).await
}
fn clear_all_secrets(mut remove: impl FnMut(&str) -> Result<(), AppError>) -> Result<(), AppError> {
    let mut first = None;
    for kind in [
        "session",
        "vault",
        "recovery",
        "pending-recovery",
        "pending-vault",
        DEVICE,
        "pairing-request",
    ] {
        if let Err(failure) = remove(kind) {
            if first.is_none() {
                first = Some(failure);
            }
        }
    }
    first.map_or(Ok(()), Err)
}

#[tauri::command]
pub async fn account_delete(app: AppHandle) -> Result<(), AppError> {
    let _guard = SESSION_LOCK.lock().await;
    let pool = pool(&app).await?;
    let s = session(&pool).await?;
    call(&s, reqwest::Method::DELETE, "/api/v1/me", None).await?;
    query("UPDATE account_sync_control SET enabled=0 WHERE id=1")
        .execute(&pool)
        .await?;
    let _refresh_guard = REFRESH_LOCK.lock().await;
    clear_all_secrets(|kind| remove_secret(&s.base, &s.account.id, kind))?;
    Ok(())
}
#[tauri::command]
pub async fn account_vault_create(app: AppHandle) -> Result<RecoveryKit, AppError> {
    let _guard = SESSION_LOCK.lock().await;
    let pool = pool(&app).await?;
    let s = session(&pool).await?;
    let recovery = match get_secret(&s.base, &s.account.id, "pending-recovery")? {
        Some(value) => crypto::decode_key(value.expose_str())?,
        None => crypto::random_key(),
    };
    let key = match get_secret(&s.base, &s.account.id, "pending-vault")? {
        Some(value) => crypto::decode_key(value.expose_str())?,
        None => crypto::random_key(),
    };
    let aad = format!("subrosa:vault:v1:{}", s.account.id);
    let envelope = crypto::seal(
        &recovery,
        &aad,
        serde_json::to_string(&json!({"v":1,"key":crypto::encode(&*key)}))
            .map_err(|_| error("vault_invalid"))?
            .as_bytes(),
    )?;
    // Persist both halves before the request. A retry after response loss must
    // recover the accepted vault, never replace its pending recovery material.
    put_secret(
        &s.base,
        &s.account.id,
        "pending-recovery",
        &crypto::encode(&*recovery),
    )?;
    put_secret(
        &s.base,
        &s.account.id,
        "pending-vault",
        &crypto::encode(&*key),
    )?;
    if let Err(failure) = call(
        &s,
        reqwest::Method::PUT,
        "/api/v1/vault",
        Some(json!({"expected_version":0,"envelope":envelope})),
    )
    .await
    {
        if failure.code != "account_conflict" {
            return Err(failure);
        }
        let existing = call(&s, reqwest::Method::GET, "/api/v1/vault", None).await?;
        let bytes = match crypto::open(
            &recovery,
            &aad,
            existing["envelope"]
                .as_str()
                .ok_or_else(|| error("vault_invalid"))?,
        ) {
            Ok(bytes) => bytes,
            Err(_) => {
                let _ = remove_secret(&s.base, &s.account.id, "pending-recovery");
                let _ = remove_secret(&s.base, &s.account.id, "pending-vault");
                query("UPDATE account_sync_control SET vault_exists=1 WHERE id=1")
                    .execute(&pool)
                    .await?;
                return Err(error("account_conflict"));
            }
        };
        let clear: Value = serde_json::from_slice(&bytes).map_err(|_| error("vault_invalid"))?;
        if clear["key"] != crypto::encode(&*key) {
            return Err(error("account_conflict"));
        }
    }
    put_secret(&s.base, &s.account.id, "vault", &crypto::encode(&*key))?;
    put_secret(
        &s.base,
        &s.account.id,
        "recovery",
        &crypto::encode(&*recovery),
    )?;
    remove_secret(&s.base, &s.account.id, "pending-recovery")?;
    remove_secret(&s.base, &s.account.id, "pending-vault")?;
    query("UPDATE account_sync_control SET vault_exists=1,recovery_confirmed=0 WHERE id=1")
        .execute(&pool)
        .await?;
    Ok(RecoveryKit {
        recovery_key: crypto::encode(&*recovery),
    })
}
#[tauri::command]
pub async fn account_vault_unlock(
    app: AppHandle,
    recovery_key: String,
) -> Result<AccountStatus, AppError> {
    let _guard = SESSION_LOCK.lock().await;
    let recovery = Zeroizing::new(recovery_key);
    let recovery = crypto::decode_key(&recovery)?;
    let pool = pool(&app).await?;
    let s = session(&pool).await?;
    let result = call(&s, reqwest::Method::GET, "/api/v1/vault", None).await?;
    let encrypted = result["envelope"]
        .as_str()
        .ok_or_else(|| error("vault_invalid"))?;
    let clear = crypto::open(
        &recovery,
        &format!("subrosa:vault:v1:{}", s.account.id),
        encrypted,
    )?;
    let body: Value = serde_json::from_slice(&clear).map_err(|_| error("vault_invalid"))?;
    if body["v"] != 1 {
        return Err(error("vault_invalid"));
    }
    let key = crypto::decode_key(body["key"].as_str().ok_or_else(|| error("vault_invalid"))?)?;
    put_secret(&s.base, &s.account.id, "vault", &crypto::encode(&*key))?;
    put_secret(
        &s.base,
        &s.account.id,
        "recovery",
        &crypto::encode(&*recovery),
    )?;
    query("UPDATE account_sync_control SET vault_exists=1,recovery_confirmed=1 WHERE id=1")
        .execute(&pool)
        .await?;
    account_status(app).await
}
#[tauri::command]
pub async fn account_vault_recovery_kit(app: AppHandle) -> Result<RecoveryKit, AppError> {
    let s = session(&pool(&app).await?).await?;
    let key = get_secret(&s.base, &s.account.id, "recovery")?
        .or(get_secret(&s.base, &s.account.id, "pending-recovery")?)
        .ok_or_else(|| error("vault_locked"))?;
    Ok(RecoveryKit {
        recovery_key: key.into_inner(),
    })
}
#[tauri::command]
pub async fn account_vault_confirm_recovery(
    app: AppHandle,
    recovery_key: String,
) -> Result<AccountStatus, AppError> {
    account_vault_unlock(app, recovery_key).await
}
#[tauri::command]
pub async fn account_sync_set_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<AccountStatus, AppError> {
    let _guard = SESSION_LOCK.lock().await;
    let pool = pool(&app).await?;
    if enabled {
        let s = session(&pool).await?;
        let _key = vault_key(&s)?;
        let confirmed: i64 =
            query("SELECT recovery_confirmed FROM account_sync_control WHERE id=1")
                .fetch_one(&pool)
                .await?
                .get("recovery_confirmed");
        if confirmed == 0 {
            return Err(error("recovery_unconfirmed"));
        }
    }
    sync::set_enabled(&pool, enabled).await?;
    drop(_guard);
    if enabled {
        sync::resume(&app).await;
    }
    account_status(app).await
}
#[tauri::command]
pub async fn account_sync_now(app: AppHandle) -> Result<AccountStatus, AppError> {
    sync::run(&app).await?;
    account_status(app).await
}
#[tauri::command]
pub async fn account_sync_conflicts(app: AppHandle) -> Result<Vec<Value>, AppError> {
    let rows=query("SELECT id,kind,object_id,created_at,deleted FROM account_sync_conflicts WHERE resolved=0 ORDER BY created_at DESC").fetch_all(&pool(&app).await?).await?;
    Ok(rows.into_iter().map(|r|json!({"id":r.get::<String,_>("id"),"kind":r.get::<String,_>("kind"),"object_id":r.get::<String,_>("object_id"),"created_at":r.get::<String,_>("created_at"),"deleted":r.get::<bool,_>("deleted"),"label":null})).collect())
}
#[tauri::command]
pub async fn account_sync_restore_conflict(
    app: AppHandle,
    conflict_id: String,
) -> Result<AccountStatus, AppError> {
    sync::restore_conflict(&app, &conflict_id).await?;
    account_status(app).await
}
#[tauri::command]
pub async fn account_share_note(
    app: AppHandle,
    note_id: String,
    window_hours: i64,
) -> Result<shares::ShareLink, AppError> {
    shares::create_note_share(&app, &note_id, window_hours).await
}
#[tauri::command]
pub async fn account_shares(app: AppHandle) -> Result<Vec<shares::ShareSummary>, AppError> {
    shares::list_shares(&app).await
}
#[tauri::command]
pub async fn account_revoke_share(app: AppHandle, share_id: String) -> Result<(), AppError> {
    shares::revoke_share(&app, &share_id).await
}
#[tauri::command]
pub async fn account_vault_share_carpe_diem(app: AppHandle) -> Result<AccountStatus, AppError> {
    sync::share_credential(&app).await?;
    account_status(app).await
}
#[tauri::command]
pub async fn account_vault_restore_carpe_diem(app: AppHandle) -> Result<AccountStatus, AppError> {
    sync::restore_credential(&app).await?;
    account_status(app).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn explicit_login_defaults_once_and_preserves_custom_server() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        query("CREATE TABLE account_sync_control (id INTEGER PRIMARY KEY, server_url TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        query("INSERT INTO account_sync_control (id) VALUES (1)")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(login_server(&pool).await.unwrap(), DEFAULT_ACCOUNT_SERVER);
        query("UPDATE account_sync_control SET server_url='https://custom.example.com'")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            login_server(&pool).await.unwrap(),
            "https://custom.example.com"
        );
    }
    #[test]
    fn a_renewable_device_is_still_a_signed_in_one() {
        // What this replaced: any device whose session had lapsed read as
        // signed out, so an expired access token sent a perfectly authorised
        // device back through a browser instead of letting it renew itself.
        assert_eq!(connection_state(true, false, true), "renewable");
        assert_eq!(connection_state(true, true, false), "connected");
        // And the states that must keep showing the sign-in card: no binding,
        // and a binding whose credentials were cleared by signing out.
        assert_eq!(connection_state(false, false, false), "none");
        assert_eq!(connection_state(true, false, false), "none");
        // Holding a device secret never claims a live session on its own.
        assert_eq!(connection_state(true, true, true), "connected");
    }

    #[test]
    fn a_session_counts_as_live_only_while_it_has_time_left() {
        let bundle = |expires: &str, in_flight: bool| {
            Redacted::new(
                json!({"access_token":"a","refresh_token":"r","expires_at":expires,
                       "refresh_expires_at":expires,"refresh_in_flight":in_flight})
                .to_string(),
            )
        };
        let future = (chrono::Utc::now() + chrono::Duration::minutes(10)).to_rfc3339();
        let past = (chrono::Utc::now() - chrono::Duration::minutes(10)).to_rfc3339();
        assert!(session_live(&bundle(&future, false)));
        assert!(!session_live(&bundle(&past, false)));
        // A refresh whose answer never came is not something to report as live.
        assert!(!session_live(&bundle(&future, true)));
        // A pre-refresh build stored a bare token and cannot say; it is taken
        // at its word until the service disagrees.
        assert!(session_live(&Redacted::new("legacy-access-token".into())));
    }

    #[test]
    fn logout_attempts_every_secret_even_when_first_delete_fails() {
        let mut calls = Vec::new();
        let result = clear_all_secrets(|kind| {
            calls.push(kind.to_string());
            if kind == "session" {
                Err(error("account_keychain"))
            } else {
                Ok(())
            }
        });
        assert!(result.is_err());
        assert_eq!(
            calls,
            vec![
                "session",
                "vault",
                "recovery",
                "pending-recovery",
                "pending-vault",
                // Signing out has to take the device secret too, or the next
                // launch would quietly let this device back in.
                "device",
                "pairing-request"
            ]
        );
    }
    #[test]
    fn server_rejects_credential_leak_destinations() {
        for value in [
            "http://remote.example",
            "https://user:pass@example.com",
            "https://example.com/path",
            "https://example.com/?key=x",
            "file:///tmp/a",
        ] {
            assert!(validate_server(value).is_err());
        }
        assert_eq!(
            validate_server("https://example.com/").unwrap(),
            "https://example.com"
        );
    }
    #[test]
    fn credential_slots_are_origin_and_account_scoped() {
        assert_ne!(slot("a", "b", "session"), slot("c", "b", "session"));
        assert_ne!(slot("a", "b", "session"), slot("a", "c", "session"));
    }
}

/// The timer merely re-drives durable rows. Launch/resume/background sweeps
/// independently recover the same rows if iOS suspends this timer.
pub fn setup(app: &AppHandle) {
    // A sign-in that finished in the browser arrives here: at cold launch as
    // the URL that started the app, and afterwards through the single-instance
    // handoff the plugin order in `lib.rs` exists to preserve. Both reach the
    // same handler, and neither is gated to desktop: the phone shells are where
    // this matters most.
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        if let Ok(Some(urls)) = app.deep_link().get_current() {
            for url in urls {
                login::on_deep_link(app, url.as_str());
            }
        }
        let handle = app.clone();
        app.deep_link().on_open_url(move |event| {
            for url in event.urls() {
                login::on_deep_link(&handle, url.as_str());
            }
        });
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Before anything is asked of it: a connected account whose
        // synchronisation is paused still deserves a live session, so the
        // screen tells the truth without waiting for the first action.
        keep_alive(&app).await;
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            sync::resume(&app).await;
        }
    });
}

#[tauri::command]
pub async fn account_sync_resolve_conflict(
    app: AppHandle,
    conflict_id: String,
    resolution: String,
) -> Result<AccountStatus, AppError> {
    sync::resolve_conflict(&app, &conflict_id, &resolution).await?;
    account_status(app).await
}

#[tauri::command]
pub async fn account_sync_conflict_preview(
    app: AppHandle,
    conflict_id: String,
) -> Result<Value, AppError> {
    sync::conflict_preview(&app, &conflict_id).await
}

#[cfg(test)]
mod live_tests;
