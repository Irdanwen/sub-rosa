//! Connectors: other services the assistant may read and act in (ADR-0092).
//!
//! A connector is a remote MCP server or one of two built-in providers
//! (Google, Microsoft). Its definition is a row that synchronises with the
//! account's settings, so a connector added on the computer is offered on the
//! phone; its tokens are this device's alone, in the keychain
//! ([`tokens`]), and never leave it.
//!
//! - [`mcp`]: the Streamable HTTP client;
//! - [`oauth`]: discovery, registration, PKCE, the `subrosa://` callback;
//! - [`catalog`]: the one-tap list; [`builtin`]: Google and Microsoft;
//! - [`runtime`]: a token that is fresh, a session, a call;
//! - [`policy`] and [`calls`]: allow, ask or deny, and the durable proposal
//!   behind an "ask";
//! - [`agent`]: what agent-lite offers and dispatches; [`apps`]: interactive
//!   views in a sandboxed frame; [`triggers`]: events that start assignment
//!   runs; [`research`]: connector sources in deep research; [`relay`]:
//!   the calls a browser tab asks one of the person's apps to make.
//!
//! On the computer the general assistant runs on Hermes, which reaches the
//! same connectors through the app ([`hermes`]): one sign-in per device, one
//! set of rules, and nothing of a connector left in the runtime once it is
//! removed.

use serde::{Deserialize, Serialize};
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::SqlitePool;
use tauri::{AppHandle, Emitter};

use crate::domain::types::AppError;

pub mod agent;
pub mod apps;
pub mod builtin;
pub mod calls;
pub mod catalog;
pub mod github;
#[cfg(desktop)]
pub mod hermes;
pub mod mcp;
pub mod oauth;
pub mod policy;
pub mod relay;
pub mod research;
pub mod runtime;
pub mod tokens;
pub mod triggers;

#[cfg(test)]
mod tests;

pub const CHANGED_EVENT: &str = "connectors://changed";

/// The errors this module raises, each a literal the i18n extractor reads
/// (ADR-0047): a message picked by a `match` on the code is invisible to it.
pub(crate) fn error(code: &str) -> AppError {
    match code {
        "connector_not_found" => {
            AppError::new("connector_not_found", "This connector no longer exists.")
        }
        "connector_url_invalid" => AppError::new(
            "connector_url_invalid",
            "Use the connector's full https address.",
        ),
        "connector_duplicate" => {
            AppError::new("connector_duplicate", "This connector is already added.")
        }
        "connector_unavailable" => AppError::new(
            "connector_unavailable",
            "This connector is not available in this build.",
        ),
        "connector_requires_verification" => AppError::new(
            "connector_requires_verification",
            "Full Gmail access needs a security review Google has not completed for Sub Rosa yet.",
        ),
        "connector_token_missing" => AppError::new(
            "connector_token_missing",
            "Paste the access token the service gave you.",
        ),
        "connector_policy_invalid" => {
            AppError::new("connector_policy_invalid", "Choose allow, ask or deny.")
        }
        _ => AppError::new(
            "connector_failed",
            "The connector could not be updated. Try again.",
        ),
    }
}

pub(crate) async fn pool(app: &AppHandle) -> Result<SqlitePool, AppError> {
    Ok(crate::commands::repositories(app).await?.pool)
}

pub(crate) fn emit_changed(app: &AppHandle) {
    let _ = app.emit(CHANGED_EVENT, ());
    // The computer's agent runtime reads the rules from its guard ledger.
    #[cfg(desktop)]
    crate::hermes_bridge::guard::publish_detached(app);
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// One connector, as its row says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    pub id: String,
    pub name: String,
    pub url: String,
    pub catalog_id: String,
    /// `oauth`, `none`, `token` (developer mode), `google`, `microsoft` or
    /// `github` (the device flow, then GitHub's remote MCP server).
    pub auth: String,
    pub enabled: bool,
    pub tool_policy: std::collections::BTreeMap<String, String>,
}

impl Connector {
    pub fn builtin(&self) -> bool {
        matches!(self.auth.as_str(), "google" | "microsoft")
    }

    /// The prefix its tools carry in a conversation: `<slug>__<tool>`.
    pub fn slug(&self) -> String {
        if self.builtin() {
            return self.auth.clone();
        }
        slug(&self.id)
    }
}

/// Lowercase letters, digits and single underscores, at most twenty.
pub fn slug(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('_') && !out.is_empty() {
            out.push('_');
        }
        if out.len() >= 20 {
            break;
        }
    }
    let out = out.trim_end_matches('_').to_string();
    if out.is_empty() {
        "connector".into()
    } else {
        out
    }
}

fn connector_of(row: &sqlx_sqlite::SqliteRow) -> Connector {
    Connector {
        id: row.get("id"),
        name: row.get("name"),
        url: row.get("url"),
        catalog_id: row.get("catalog_id"),
        auth: row.get("auth"),
        enabled: row.get::<i64, _>("enabled") != 0,
        tool_policy: policy::parse_policy(&row.get::<String, _>("tool_policy")),
    }
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<Connector>, AppError> {
    Ok(query("SELECT * FROM connectors ORDER BY created_at")
        .fetch_all(pool)
        .await?
        .iter()
        .map(connector_of)
        .collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Connector, AppError> {
    query("SELECT * FROM connectors WHERE id=?")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .map(|row| connector_of(&row))
        .ok_or_else(|| error("connector_not_found"))
}

/// The id a connector's definition travels under. The account service only
/// knows UUID objects, and a catalog connector's id is its catalog name
/// (`sentry`), so the object is a name-based UUID of the id: every device and
/// the browser derive the same one, and the row keeps the id its tokens,
/// tools and triggers are filed under. Kept in a local column that never
/// travels (`075_connector_object_ids.sql`).
pub fn object_id(id: &str) -> String {
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!("subrosa:connector:{id}").as_bytes(),
    )
    .hyphenated()
    .to_string()
}

/// Names the object of every connector written before its row had one, and
/// says how many it named: those never reached the service and have to be
/// queued again.
pub(crate) async fn assign_object_ids(pool: &SqlitePool) -> Result<usize, sqlx::Error> {
    let ids: Vec<String> = query("SELECT id FROM connectors WHERE object_id IS NULL")
        .fetch_all(pool)
        .await?
        .iter()
        .map(|row| row.get("id"))
        .collect();
    for id in &ids {
        query("UPDATE connectors SET object_id=? WHERE id=? AND object_id IS NULL")
            .bind(object_id(id))
            .bind(id)
            .execute(pool)
            .await?;
    }
    Ok(ids.len())
}

pub async fn insert(pool: &SqlitePool, connector: &Connector) -> Result<(), AppError> {
    let now = now();
    query("INSERT INTO connectors(id,object_id,name,url,catalog_id,auth,enabled,tool_policy,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .bind(&connector.id)
        .bind(object_id(&connector.id))
        .bind(&connector.name)
        .bind(&connector.url)
        .bind(&connector.catalog_id)
        .bind(&connector.auth)
        .bind(i64::from(connector.enabled))
        .bind(serde_json::to_string(&connector.tool_policy).unwrap_or_else(|_| "{}".into()))
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await?;
    Ok(())
}

/// What this device remembers about a connector, never synchronised.
#[derive(Debug, Clone, Default)]
pub struct LocalState {
    pub oauth_client: Option<serde_json::Value>,
    pub tools: Vec<mcp::ToolInfo>,
    pub tools_fetched_at: Option<String>,
    /// `idle`, `connected`, `needs_sign_in`, `error`.
    pub status: String,
    pub last_error: Option<String>,
}

pub async fn state(pool: &SqlitePool, id: &str) -> LocalState {
    let Ok(Some(row)) = query("SELECT * FROM connector_state WHERE connector_id=?")
        .bind(id)
        .fetch_optional(pool)
        .await
    else {
        return LocalState {
            status: "idle".into(),
            ..LocalState::default()
        };
    };
    LocalState {
        oauth_client: row
            .get::<Option<String>, _>("oauth_client")
            .and_then(|raw| serde_json::from_str(&raw).ok()),
        tools: serde_json::from_str(&row.get::<String, _>("tools")).unwrap_or_default(),
        tools_fetched_at: row.get("tools_fetched_at"),
        status: row.get("status"),
        last_error: row.get("last_error"),
    }
}

pub(crate) async fn set_status(pool: &SqlitePool, id: &str, status: &str, error: Option<&str>) {
    let _ = query("INSERT INTO connector_state(connector_id,status,last_error,updated_at) VALUES(?,?,?,?) ON CONFLICT(connector_id) DO UPDATE SET status=excluded.status,last_error=excluded.last_error,updated_at=excluded.updated_at")
        .bind(id)
        .bind(status)
        .bind(error)
        .bind(now())
        .execute(pool)
        .await;
}

pub(crate) async fn set_tools(pool: &SqlitePool, id: &str, tools: &[mcp::ToolInfo]) {
    let now = now();
    let _ = query("INSERT INTO connector_state(connector_id,tools,tools_fetched_at,status,updated_at) VALUES(?,?,?,'connected',?) ON CONFLICT(connector_id) DO UPDATE SET tools=excluded.tools,tools_fetched_at=excluded.tools_fetched_at,status='connected',last_error=NULL,updated_at=excluded.updated_at")
        .bind(id)
        .bind(serde_json::to_string(tools).unwrap_or_else(|_| "[]".into()))
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await;
}

pub(crate) async fn set_oauth_client(pool: &SqlitePool, id: &str, client: &serde_json::Value) {
    let _ = query("INSERT INTO connector_state(connector_id,oauth_client,updated_at) VALUES(?,?,?) ON CONFLICT(connector_id) DO UPDATE SET oauth_client=excluded.oauth_client,updated_at=excluded.updated_at")
        .bind(id)
        .bind(client.to_string())
        .bind(now())
        .execute(pool)
        .await;
}

// --- What the screens read ---------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDto {
    pub name: String,
    pub title: Option<String>,
    pub description: String,
    pub read_only: bool,
    /// The rule in force: the person's, or the default.
    pub rule: &'static str,
    /// Whether the person chose it, rather than the default.
    pub chosen: bool,
    pub interactive: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDto {
    #[serde(flatten)]
    pub connector: Connector,
    /// `idle`, `connected`, `needs_sign_in`, `error`.
    pub status: String,
    pub last_error: Option<String>,
    /// Whether this device holds a credential for it. Only presence crosses
    /// to the webview, never the value.
    pub signed_in: bool,
    pub tools: Vec<ToolDto>,
    pub tools_fetched_at: Option<String>,
}

pub(crate) fn has_credential(connector: &Connector) -> bool {
    match connector.auth.as_str() {
        "none" => true,
        "token" => tokens::get(&tokens::tokens_slot(&connector.id))
            .ok()
            .flatten()
            .is_some(),
        _ => oauth::load_tokens(&connector.id).ok().flatten().is_some(),
    }
}

pub async fn dto(pool: &SqlitePool, connector: Connector) -> ConnectorDto {
    let local = state(pool, &connector.id).await;
    let tools = if connector.builtin() {
        builtin::tools_for(&connector.auth)
    } else {
        local.tools.clone()
    };
    let tools = tools
        .iter()
        .map(|tool| ToolDto {
            name: tool.name.clone(),
            title: tool.title.clone(),
            description: tool.description.clone(),
            read_only: tool.read_only,
            rule: policy::effective(&connector.tool_policy, tool).as_str(),
            chosen: connector.tool_policy.contains_key(&tool.name),
            interactive: tool.ui_resource.is_some(),
        })
        .collect();
    ConnectorDto {
        signed_in: has_credential(&connector),
        status: local.status,
        last_error: local.last_error,
        tools,
        tools_fetched_at: local.tools_fetched_at,
        connector,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinDto {
    pub id: &'static str,
    pub name: &'static str,
    /// Whether this build carries the app's client id for it.
    pub available: bool,
    pub description: &'static str,
    /// Parts that exist in the code but wait on an outside review.
    pub gated: Vec<GatedDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatedDto {
    pub id: &'static str,
    pub name: &'static str,
    /// `requires_verification`.
    pub state: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDto {
    pub servers: Vec<catalog::CatalogEntry>,
    pub builtins: Vec<BuiltinDto>,
}

/// The built-in providers this build offers. GitHub is listed only when the
/// build carries its client id: without one there is nothing to offer.
pub fn builtins() -> Vec<BuiltinDto> {
    let mut builtins = builtin::catalog();
    if github::available() {
        builtins.push(BuiltinDto {
            id: github::ID,
            name: github::NAME,
            available: true,
            description: "Repositories, issues and pull requests",
            gated: Vec::new(),
        });
    }
    builtins
}

#[tauri::command]
pub async fn connector_catalog() -> Result<CatalogDto, AppError> {
    Ok(CatalogDto {
        servers: catalog::CATALOG.to_vec(),
        builtins: builtins(),
    })
}

#[tauri::command]
pub async fn connector_list(app: AppHandle) -> Result<Vec<ConnectorDto>, AppError> {
    let pool = pool(&app).await?;
    let mut out = Vec::new();
    for connector in list(&pool).await? {
        out.push(dto(&pool, connector).await);
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorAddRequest {
    /// A catalog entry, or `google` / `microsoft`.
    pub catalog_id: Option<String>,
    /// A custom connector (developer mode): its name and address.
    pub name: Option<String>,
    pub url: Option<String>,
    /// For a custom connector: `oauth` (default), `none` or `token`.
    pub auth: Option<String>,
}

/// The row an add request describes, before it touches the database.
pub fn connector_for(request: &ConnectorAddRequest) -> Result<Connector, AppError> {
    let blank = Connector {
        id: String::new(),
        name: String::new(),
        url: String::new(),
        catalog_id: String::new(),
        auth: "oauth".into(),
        enabled: true,
        tool_policy: Default::default(),
    };
    if let Some(id) = request.catalog_id.as_deref().filter(|id| !id.is_empty()) {
        if id == github::ID {
            if !github::available() {
                return Err(error("connector_unavailable"));
            }
            return Ok(Connector {
                id: github::ID.to_string(),
                name: github::NAME.to_string(),
                url: github::MCP_URL.to_string(),
                catalog_id: github::ID.to_string(),
                auth: github::ID.to_string(),
                ..blank
            });
        }
        if let Some(provider) = builtin::provider(id) {
            if !provider.available() {
                return Err(error("connector_unavailable"));
            }
            return Ok(Connector {
                id: id.to_string(),
                name: provider.name.to_string(),
                catalog_id: id.to_string(),
                auth: id.to_string(),
                ..blank
            });
        }
        let entry = catalog::find(id).ok_or_else(|| error("connector_not_found"))?;
        return Ok(Connector {
            id: entry.id.to_string(),
            name: entry.name.to_string(),
            url: entry.url.to_string(),
            catalog_id: entry.id.to_string(),
            auth: entry.auth.to_string(),
            ..blank
        });
    }
    let url = mcp::validate_endpoint(request.url.as_deref().unwrap_or_default())?;
    let name: String = request
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| url.host_str().unwrap_or("Connector"))
        .chars()
        .take(60)
        .collect();
    let auth = match request.auth.as_deref() {
        Some("none") => "none",
        Some("token") => "token",
        _ => "oauth",
    };
    Ok(Connector {
        id: format!(
            "{}-{}",
            slug(&name),
            &uuid::Uuid::new_v4().simple().to_string()[..6]
        ),
        name,
        url: url.to_string(),
        auth: auth.into(),
        ..blank
    })
}

#[tauri::command]
pub async fn connector_add(
    app: AppHandle,
    request: ConnectorAddRequest,
) -> Result<ConnectorDto, AppError> {
    let pool = pool(&app).await?;
    let connector = connector_for(&request)?;
    if get(&pool, &connector.id).await.is_ok() {
        return Err(error("connector_duplicate"));
    }
    insert(&pool, &connector).await?;
    emit_changed(&app);
    Ok(dto(&pool, connector).await)
}

/// Everything this device keeps about a connector: its access, its state,
/// its triggers and its row. The runtime's tools and rules follow from the
/// rows ([`hermes`]), so nothing else needs undoing.
pub async fn remove_rows(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    let _ = oauth::forget_tokens(id);
    let _ = tokens::remove(&tokens::tokens_slot(id));
    query("DELETE FROM connector_state WHERE connector_id=?")
        .bind(id)
        .execute(pool)
        .await?;
    query("DELETE FROM connector_triggers WHERE connector_id=?")
        .bind(id)
        .execute(pool)
        .await?;
    query("DELETE FROM connectors WHERE id=?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn connector_remove(app: AppHandle, id: String) -> Result<(), AppError> {
    let pool = pool(&app).await?;
    remove_rows(&pool, &id).await?;
    emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn connector_set_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<ConnectorDto, AppError> {
    let pool = pool(&app).await?;
    query("UPDATE connectors SET enabled=?,updated_at=? WHERE id=?")
        .bind(i64::from(enabled))
        .bind(now())
        .bind(&id)
        .execute(&pool)
        .await?;
    emit_changed(&app);
    Ok(dto(&pool, get(&pool, &id).await?).await)
}

#[tauri::command]
pub async fn connector_set_tool_policy(
    app: AppHandle,
    id: String,
    tool: String,
    rule: Option<String>,
) -> Result<ConnectorDto, AppError> {
    let pool = pool(&app).await?;
    let mut connector = get(&pool, &id).await?;
    match rule.as_deref() {
        None | Some("") => {
            connector.tool_policy.remove(&tool);
        }
        Some(raw) => {
            let rule = policy::Rule::parse(raw).ok_or_else(|| error("connector_policy_invalid"))?;
            if tool.is_empty() || tool.len() > 128 {
                return Err(error("connector_policy_invalid"));
            }
            connector
                .tool_policy
                .insert(tool.clone(), rule.as_str().to_string());
        }
    }
    query("UPDATE connectors SET tool_policy=?,updated_at=? WHERE id=?")
        .bind(serde_json::to_string(&connector.tool_policy).unwrap_or_else(|_| "{}".into()))
        .bind(now())
        .bind(&id)
        .execute(&pool)
        .await?;
    emit_changed(&app);
    Ok(dto(&pool, connector).await)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInDto {
    /// The page the browser was sent to, for an "open it again" link. It
    /// carries no secret: the verifier stays in the keychain.
    pub auth_url: Option<String>,
    /// Connected without a sign-in (the server asked for none).
    pub connected: bool,
    /// A device sign-in (GitHub): the code to type, and where.
    pub device: Option<github::DeviceStart>,
}

#[tauri::command]
pub async fn connector_sign_in(app: AppHandle, id: String) -> Result<SignInDto, AppError> {
    let pool = pool(&app).await?;
    let connector = get(&pool, &id).await?;
    if connector.auth == github::ID {
        return github_sign_in(app, pool, connector).await;
    }
    let outcome = runtime::begin_sign_in(&pool, &connector).await;
    match outcome {
        Ok(runtime::SignIn::Connected) => {
            let _ = runtime::refresh_tools(&pool, &connector).await;
            emit_changed(&app);
            Ok(SignInDto {
                auth_url: None,
                connected: true,
                device: None,
            })
        }
        Ok(runtime::SignIn::Browser(url)) => {
            // The page opens outside the app; the deep link brings it back.
            let _ = crate::open_url::open_external_url(app.clone(), url.clone()).await;
            Ok(SignInDto {
                auth_url: Some(url),
                connected: false,
                device: None,
            })
        }
        Err(failure) => {
            set_status(&pool, &id, "error", Some(&failure.message)).await;
            emit_changed(&app);
            Err(failure)
        }
    }
}

/// GitHub's device flow: a code for the person to type on github.com,
/// opened for them, and the token collected in the background while they do.
async fn github_sign_in(
    app: AppHandle,
    pool: SqlitePool,
    connector: Connector,
) -> Result<SignInDto, AppError> {
    let client_id = github::client_id().ok_or_else(|| error("connector_unavailable"))?;
    let code = github::request_code(&github::GITHUB, client_id).await?;
    let start = code.start.clone();
    let generation = github::claim_wait(&connector.id);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = github::wait_for_token(&github::GITHUB, client_id, &code).await;
        if !github::is_current(&connector.id, generation) {
            return;
        }
        match outcome.and_then(|tokens| oauth::save_tokens(&connector.id, &tokens)) {
            Ok(()) => {
                set_status(&pool, &connector.id, "connected", None).await;
                let _ = runtime::refresh_tools(&pool, &connector).await;
            }
            Err(failure) => {
                set_status(
                    &pool,
                    &connector.id,
                    "needs_sign_in",
                    Some(&failure.message),
                )
                .await;
            }
        }
        emit_changed(&handle);
    });
    let _ = crate::open_url::open_external_url(app, start.verification_uri.clone()).await;
    Ok(SignInDto {
        auth_url: Some(start.verification_uri.clone()),
        connected: false,
        device: Some(start),
    })
}

#[tauri::command]
pub async fn connector_sign_out(app: AppHandle, id: String) -> Result<ConnectorDto, AppError> {
    let pool = pool(&app).await?;
    oauth::forget_tokens(&id)?;
    tokens::remove(&tokens::tokens_slot(&id))?;
    set_status(&pool, &id, "idle", None).await;
    emit_changed(&app);
    Ok(dto(&pool, get(&pool, &id).await?).await)
}

/// A token pasted by hand, for a custom connector in developer mode. Written
/// to the keychain and never echoed back.
#[tauri::command]
pub async fn connector_set_token(
    app: AppHandle,
    id: String,
    token: String,
) -> Result<ConnectorDto, AppError> {
    let pool = pool(&app).await?;
    let connector = get(&pool, &id).await?;
    let token = token.trim();
    if connector.auth != "token" || token.is_empty() || token.len() > 4096 {
        return Err(error("connector_token_missing"));
    }
    tokens::put(&tokens::tokens_slot(&id), token)?;
    let _ = runtime::refresh_tools(&pool, &connector).await;
    emit_changed(&app);
    Ok(dto(&pool, connector).await)
}

#[tauri::command]
pub async fn connector_refresh_tools(app: AppHandle, id: String) -> Result<ConnectorDto, AppError> {
    let pool = pool(&app).await?;
    let connector = get(&pool, &id).await?;
    let result = runtime::refresh_tools(&pool, &connector).await;
    emit_changed(&app);
    result?;
    Ok(dto(&pool, connector).await)
}

/// A sign-in coming back through `subrosa://connector/callback` (or the
/// provider redirect a build configured). Anything else is left alone.
pub fn on_deep_link(app: &AppHandle, url: &str) {
    if !oauth::is_callback(url) {
        return;
    }
    let Some((state, outcome)) = oauth::parse_callback(url) else {
        return;
    };
    let app = app.clone();
    let url = url.to_string();
    tauri::async_runtime::spawn(async move {
        let Ok(pool) = pool(&app).await else {
            return;
        };
        let flow = match oauth::take_pending(&state, chrono::Utc::now().timestamp()) {
            Ok(flow) => flow,
            Err(failure) => {
                tracing::warn!(code = %failure.code, "connector callback without its sign-in");
                return;
            }
        };
        if !oauth::redirect_matches(&url, &flow.redirect_uri) {
            tracing::warn!("connector callback came back to the wrong address");
            return;
        }
        let code = match outcome {
            oauth::CallbackOutcome::Code(code) => code,
            oauth::CallbackOutcome::Denied(_) => {
                set_status(
                    &pool,
                    &flow.connector_id,
                    "needs_sign_in",
                    Some(&crate::tr!("The sign-in was cancelled.")),
                )
                .await;
                emit_changed(&app);
                return;
            }
        };
        match oauth::exchange(&flow, code.expose_str()).await {
            Ok(tokens) => {
                if let Err(failure) = oauth::save_tokens(&flow.connector_id, &tokens) {
                    set_status(&pool, &flow.connector_id, "error", Some(&failure.message)).await;
                } else if let Ok(connector) = get(&pool, &flow.connector_id).await {
                    set_status(&pool, &flow.connector_id, "connected", None).await;
                    let _ = runtime::refresh_tools(&pool, &connector).await;
                }
            }
            Err(failure) => {
                set_status(&pool, &flow.connector_id, "error", Some(&failure.message)).await;
            }
        }
        emit_changed(&app);
    });
}

/// Hears the sign-ins that come back, and starts the trigger clock.
pub fn setup(app: &AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            on_deep_link(app, url.as_str());
        }
    }
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            on_deep_link(&handle, url.as_str());
        }
    });
    triggers::start_clock(app);
    // Rules that arrive from another device reach the runtime's ledger too.
    #[cfg(desktop)]
    {
        use tauri::Listener as _;
        let handle = app.clone();
        app.listen("subrosa://sync-updated", move |_| {
            crate::hermes_bridge::guard::publish_detached(&handle);
        });
    }
}
