//! A connector a browser tab cannot reach, run for it by one of the person's
//! own apps (ADR-0107).
//!
//! Several catalog servers refuse a web page's origin (Sentry, Stripe,
//! Zapier, monday.com, Cloudflare's documentation server), a custom server's
//! origin is one `/app`'s policy does not name, and the built-in Google,
//! Microsoft and GitHub sign-ins need the app's own client ids. The account
//! service will not proxy them: it would see tokens and results and act for a
//! closed tab (ADR-0049, ADR-0104). So the call travels the way a link
//! already does (ADR-0054): as an errand.
//!
//! - **The offer.** A device whose owner switched relaying on files one
//!   `connector_relays` row per connector it holds a credential for, with the
//!   tools it listed ([`publish`]). That is how a tab knows which of its
//!   devices can run what, and what each tool takes. Only presence travels,
//!   never a token.
//! - **The call.** The tab writes a `connector_errands` row addressed to that
//!   device: the tool, its arguments, and whether the person already approved
//!   it in the tab. This device picks it up after the next synchronisation
//!   ([`run_pending`], every few seconds while the app is open), applies its
//!   own rules again, makes the call, and writes the bounded result into the
//!   same row, which synchronises back.
//! - **The rules are this device's.** A tool denied here is declined; one
//!   that asks runs only when the person approved it where they asked, with
//!   an approval the asking browser signed over this very call
//!   (`relay_approval`), and otherwise the row says so and the tab shows the
//!   approval card. The
//!   switch is off until the owner turns it on, as for errands, and a device
//!   that has it off declines rather than leaving the tab waiting.
//! - **Short lived and single use.** A call is about a conversation that is
//!   happening now: one older than [`EXPIRY_SECS`] is declined instead of run
//!   late, and `connector_errand_runs` is written before the call leaves and
//!   never synchronised, so a row that comes back as `requested` after a
//!   conflict cannot act twice.

use std::collections::{BTreeMap, HashSet};
use std::sync::{LazyLock, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;

use super::mcp::ToolInfo;
use super::policy::{self, Rule};
use super::{builtin, Connector};
use crate::domain::types::AppError;

/// How old a call may be when this device first sees it. A tab waits
/// [`WAIT_SECS`] inside a turn; the margin covers a clock that is a little
/// off, not a call made long after the conversation moved on.
pub const EXPIRY_SECS: i64 = 120;
/// How long a tab waits for the answer inside a turn before it says the
/// device did not answer. Read by the web client from its export.
pub const WAIT_SECS: u64 = 60;
/// The largest arguments a call may carry.
pub const MAX_ARGUMENT_BYTES: usize = 32 * 1024;
/// The largest tool list one offer carries.
pub const MAX_TOOLS_BYTES: usize = 96 * 1024;
/// The largest structured result kept beside the text (a calendar's events).
pub const MAX_STRUCTURED_BYTES: usize = 16 * 1024;
/// A call made here for another device stops waiting after this long.
const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

/// What the row says when this device does not make the call. Each one value
/// so the web client reads the same words and translates them.
pub(crate) const NOT_ACCEPTING: &str = "This device does not run connectors for your other devices. Turn on \"Run connectors for my browser\" in Settings, Connectors.";
pub(crate) const TOO_LATE: &str = "This call waited too long and was not made.";
pub(crate) const NOT_SIGNED_IN: &str = "This connector is not signed in on this device any more.";
pub(crate) const NEEDS_APPROVAL: &str =
    "This action needs your approval before it runs. Approve it where you asked.";
pub(crate) const TOO_LARGE: &str = "This call carries more than another device can take.";
pub(crate) const CLOCK_AHEAD: &str =
    "This call is dated ahead of this device's clock, so it was not made. Check the date and time of the device that asked.";
pub(crate) const BAD_ARGUMENTS: &str =
    "This call's arguments are not ones a tool takes, so it was not made.";

/// What a tab tells the model when nothing answered in time. Only a tab
/// says it, so it is a template the web client fills (`{device}` is
/// `computer` or `phone`). Read by the web export only.
#[cfg(test)]
pub(crate) const NO_ANSWER: &str = "Your {device} did not answer in time. It runs {connector} for this page only while Sub Rosa is open on it.";

// --- Settings -----------------------------------------------------------------

/// Whether this device runs connectors for the account's other devices. Off
/// until said otherwise: a call spends this machine's sign-ins and acts in
/// the person's services while they are elsewhere.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct RelaySettings {
    pub enabled: bool,
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager as _;
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("connector_relay.json"))
}

pub fn settings(app: &AppHandle) -> RelaySettings {
    settings_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, value: &RelaySettings) -> Result<(), AppError> {
    let path = settings_path(app).ok_or_else(|| super::error("connector_failed"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| super::error("connector_failed"))?;
    }
    let body = serde_json::to_string_pretty(value).map_err(|_| super::error("connector_failed"))?;
    std::fs::write(&path, body).map_err(|_| super::error("connector_failed"))
}

// --- Identity -------------------------------------------------------------------

async fn this_device(pool: &SqlitePool) -> Option<String> {
    query("SELECT device_id FROM account_sync_control WHERE id=1")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .and_then(|row| row.get::<Option<String>, _>("device_id"))
        .filter(|id| !id.is_empty())
}

/// An offer's object id: a name-based UUID of its device and its connector.
pub fn offer_id(device_id: &str, connector_id: &str) -> String {
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_OID,
        format!("subrosa:connector-relay:{device_id}:{connector_id}").as_bytes(),
    )
    .to_string()
}

// --- The offer ------------------------------------------------------------------

/// The tools an offer carries, as the web client reads them (`ToolInfo` in
/// `connectors/mcp.ts`), each with the rule this device applies to it: the
/// offer is everything a tab knows of the connector, so the definition row
/// need not reach it. A denied tool is not offered. A schema too large for
/// a declaration is replaced by an empty one, as `agent::declaration` does,
/// and the list stops before it outgrows [`MAX_TOOLS_BYTES`].
pub fn offered_tools(tools: &[ToolInfo], tool_policy: &BTreeMap<String, String>) -> Value {
    let mut out = Vec::new();
    let mut size = 2;
    for tool in tools.iter() {
        if out.len() >= super::agent::MAX_OFFERED {
            break;
        }
        let rule = policy::effective(tool_policy, tool);
        if rule == Rule::Deny {
            continue;
        }
        let schema = if tool.input_schema.to_string().len() > super::agent::MAX_SCHEMA_BYTES {
            json!({"type": "object", "properties": {}})
        } else {
            tool.input_schema.clone()
        };
        let entry = json!({
            "name": tool.name,
            "title": tool.title,
            "description": tool.description,
            "inputSchema": schema,
            "readOnly": tool.read_only,
            "destructive": tool.destructive,
            "uiResource": null,
            "rule": rule.as_str(),
        });
        size += entry.to_string().len() + 1;
        if size > MAX_TOOLS_BYTES {
            break;
        }
        out.push(entry);
    }
    Value::Array(out)
}

fn tools_of(pool_tools: Vec<ToolInfo>, connector: &Connector) -> Vec<ToolInfo> {
    if connector.builtin() {
        builtin::tools_for(&connector.auth)
    } else {
        pool_tools
    }
}

/// Files what this device can run for the others, and withdraws what it no
/// longer can. Writes only what changed: an unchanged offer is not a new
/// revision every minute.
pub async fn publish(app: &AppHandle) {
    let Ok(pool) = super::pool(app).await else {
        return;
    };
    let enabled = settings(app).enabled;
    publish_with(&pool, enabled, super::has_credential).await;
}

pub(crate) async fn publish_with(
    pool: &SqlitePool,
    enabled: bool,
    signed_in: impl Fn(&Connector) -> bool,
) {
    let Some(device) = this_device(pool).await else {
        return;
    };
    let mut wanted: BTreeMap<String, (Connector, String)> = BTreeMap::new();
    if enabled {
        for connector in super::list(pool).await.unwrap_or_default() {
            if !connector.enabled || !signed_in(&connector) {
                continue;
            }
            let tools = tools_of(super::state(pool, &connector.id).await.tools, &connector);
            if tools.is_empty() {
                continue;
            }
            let offered = offered_tools(&tools, &connector.tool_policy).to_string();
            if offered == "[]" {
                continue;
            }
            wanted.insert(offer_id(&device, &connector.id), (connector, offered));
        }
    }
    let existing = query(
        "SELECT id, connector_name, tools, device_name FROM connector_relays WHERE device_id=?",
    )
    .bind(&device)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    let now = chrono::Utc::now().to_rfc3339();
    let name = crate::moments::daily_cards::device_kind();
    for row in &existing {
        let id: String = row.get("id");
        match wanted.get(&id) {
            None => {
                let _ = query("DELETE FROM connector_relays WHERE id=?")
                    .bind(&id)
                    .execute(pool)
                    .await;
            }
            Some((connector, tools)) => {
                let same = row.get::<String, _>("connector_name") == connector.name
                    && &row.get::<String, _>("tools") == tools
                    && row.get::<String, _>("device_name") == name;
                if !same {
                    let _ = query("UPDATE connector_relays SET connector_name=?, tools=?, device_name=?, updated_at=? WHERE id=?")
                        .bind(&connector.name)
                        .bind(tools)
                        .bind(name)
                        .bind(&now)
                        .bind(&id)
                        .execute(pool)
                        .await;
                }
            }
        }
    }
    let known: HashSet<String> = existing.iter().map(|row| row.get("id")).collect();
    for (id, (connector, tools)) in wanted {
        if known.contains(&id) {
            continue;
        }
        let _ = query("INSERT INTO connector_relays(id,device_id,device_name,connector_id,connector_name,tools,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
            .bind(&id)
            .bind(&device)
            .bind(name)
            .bind(&connector.id)
            .bind(&connector.name)
            .bind(tools)
            .bind(&now)
            .execute(pool)
            .await;
    }
}

// --- The call -------------------------------------------------------------------

/// One call another device asked this one to make.
#[derive(Debug, Clone, PartialEq)]
pub struct Errand {
    pub id: String,
    pub connector_id: String,
    pub tool: String,
    pub arguments: String,
    pub approved: bool,
    pub requested_at: String,
    /// The device the row says asked.
    pub requested_by: String,
    /// The asking browser's signed approval (`relay_approval`), carried in
    /// the row's `message` while it is `requested`.
    pub approval: Option<String>,
}

fn errand_of(row: &sqlx_sqlite::SqliteRow) -> Errand {
    Errand {
        id: row.get("id"),
        connector_id: row.get("connector_id"),
        tool: row.get("tool"),
        arguments: row.get("arguments"),
        approved: row.get::<i64, _>("approved") != 0,
        requested_at: row.get("requested_at"),
        requested_by: row.get("requested_by"),
        approval: row
            .get::<Option<String>, _>("message")
            .filter(|message| message.len() <= 4096),
    }
}

/// What this device does with one call.
#[derive(Debug, PartialEq)]
pub enum Decision {
    /// Make it, with these arguments.
    Run(Value),
    /// Ask the person first, where they asked.
    Ask,
    /// Do not make it, for this reason (one of the sentences above).
    Decline(String),
}

/// The rules this device applies to a call, before anything leaves. Pure:
/// the switch, the clock, the size, the connector and its sign-in, then the
/// person's rule for that tool, read here and never taken from the asker.
pub fn decide(
    errand: &Errand,
    accepting: bool,
    connector: Option<&Connector>,
    signed_in: bool,
    tools: &[ToolInfo],
    now: chrono::DateTime<chrono::Utc>,
) -> Decision {
    if !accepting {
        return Decision::Decline(NOT_ACCEPTING.into());
    }
    let Ok(at) = chrono::DateTime::parse_from_rfc3339(&errand.requested_at) else {
        return Decision::Decline(TOO_LATE.into());
    };
    let age = now.signed_duration_since(at.with_timezone(&chrono::Utc));
    // A call dated ahead of this clock would stay fresh for longer than its
    // lifetime: refused rather than trusted, past a minute of drift.
    if age < -chrono::Duration::seconds(super::relay_approval::CLOCK_SKEW_SECS) {
        return Decision::Decline(CLOCK_AHEAD.into());
    }
    if age > chrono::Duration::seconds(EXPIRY_SECS) {
        return Decision::Decline(TOO_LATE.into());
    }
    if errand.arguments.len() > MAX_ARGUMENT_BYTES {
        return Decision::Decline(TOO_LARGE.into());
    }
    let Some(connector) = connector else {
        return Decision::Decline(super::agent::REMOVED.into());
    };
    if !connector.enabled {
        return Decision::Decline(super::agent::TURNED_OFF.into());
    }
    if !signed_in {
        return Decision::Decline(NOT_SIGNED_IN.into());
    }
    // A tool takes an object; anything else is not quietly made into an
    // empty one, which would run the tool on its defaults.
    let arguments = match serde_json::from_str::<Value>(&errand.arguments) {
        Ok(value @ Value::Object(_)) => value,
        _ => return Decision::Decline(BAD_ARGUMENTS.into()),
    };
    // A tool this device never listed has no hint: it asks, like any tool
    // that does not say it only reads.
    let rule = tools
        .iter()
        .find(|tool| tool.name == errand.tool)
        .map(|tool| policy::effective(&connector.tool_policy, tool))
        .unwrap_or_else(|| {
            connector
                .tool_policy
                .get(&errand.tool)
                .and_then(|raw| Rule::parse(raw))
                .unwrap_or(Rule::Ask)
        });
    match rule {
        Rule::Deny => Decision::Decline(super::agent::TURNED_OFF.into()),
        Rule::Ask if !errand.approved => Decision::Ask,
        _ => Decision::Run(arguments),
    }
}

/// What a call's row keeps: the card's bounded text and links, and the
/// structured content when it is small (a calendar's events, for the brief).
pub fn kept_result(result: &Value) -> Value {
    let mut kept = super::calls::bounded(result);
    if let Some(structured) = result.get("structuredContent") {
        if structured.to_string().len() <= MAX_STRUCTURED_BYTES {
            kept["structured"] = structured.clone();
        }
    }
    kept
}

static ACTIVE: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

fn active() -> MutexGuard<'static, HashSet<String>> {
    ACTIVE.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// One call is handled once per process; the ledger covers restarts.
struct RunClaim(String);

impl RunClaim {
    fn take(id: &str) -> Option<Self> {
        active()
            .insert(id.to_string())
            .then(|| Self(id.to_string()))
    }
}

impl Drop for RunClaim {
    fn drop(&mut self) {
        active().remove(&self.0);
    }
}

async fn settle(
    pool: &SqlitePool,
    id: &str,
    state: &str,
    result: Option<&Value>,
    message: Option<&str>,
) {
    let _ = query("UPDATE connector_errands SET state=?,result=?,message=?,updated_at=? WHERE id=? AND state='requested'")
        .bind(state)
        .bind(result.map(Value::to_string))
        .bind(message)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(pool)
        .await;
}

/// Claims a call durably, before it leaves. False when it was claimed before.
pub(crate) async fn claim_once(pool: &SqlitePool, id: &str) -> bool {
    query("INSERT OR IGNORE INTO connector_errand_runs(errand_id,started_at) VALUES(?,?)")
        .bind(id)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(pool)
        .await
        .map(|done| done.rows_affected() == 1)
        .unwrap_or(false)
}

/// The calls addressed to this device that nothing has handled yet.
pub(crate) async fn pending(pool: &SqlitePool, device: &str) -> Vec<Errand> {
    query("SELECT * FROM connector_errands WHERE device_id=? AND state='requested' AND id NOT IN (SELECT errand_id FROM connector_errand_runs) ORDER BY requested_at LIMIT 5")
        .bind(device)
        .fetch_all(pool)
        .await
        .map(|rows| rows.iter().map(errand_of).collect())
        .unwrap_or_default()
}

/// Handles one call end to end: decide, claim, call, write the answer.
async fn handle(app: &AppHandle, pool: &SqlitePool, mut errand: Errand) {
    let Some(_claim) = RunClaim::take(&errand.id) else {
        return;
    };
    // An approval counts only when the asking browser signed it over this
    // call and the account service lists that browser as a live device.
    if errand.approved {
        errand.approved = approval_holds(app, &errand).await;
    }
    let connector = super::get(pool, &errand.connector_id).await.ok();
    let signed_in = connector.as_ref().is_some_and(super::has_credential);
    let tools = match &connector {
        Some(connector) => tools_of(super::state(pool, &connector.id).await.tools, connector),
        None => Vec::new(),
    };
    let decision = decide(
        &errand,
        settings(app).enabled,
        connector.as_ref(),
        signed_in,
        &tools,
        chrono::Utc::now(),
    );
    // Durable before the call leaves, and for a refusal too: a row that comes
    // back as requested is never looked at again by this machine.
    if !claim_once(pool, &errand.id).await {
        return;
    }
    match (decision, connector) {
        (Decision::Decline(reason), _) => {
            settle(pool, &errand.id, "declined", None, Some(&reason)).await
        }
        (Decision::Ask, _) => settle(pool, &errand.id, "ask", None, Some(NEEDS_APPROVAL)).await,
        (Decision::Run(arguments), Some(connector)) => {
            let _background = crate::ios_background::BackgroundTask::begin("connector-relay");
            let outcome = tokio::time::timeout(
                CALL_TIMEOUT,
                super::runtime::call_tool(pool, &connector, &errand.tool, &arguments),
            )
            .await;
            match outcome {
                Ok(Ok(value)) => {
                    settle(pool, &errand.id, "done", Some(&kept_result(&value)), None).await
                }
                Ok(Err(failure)) => {
                    settle(pool, &errand.id, "failed", None, Some(&failure.message)).await
                }
                Err(_) => {
                    settle(
                        pool,
                        &errand.id,
                        "failed",
                        None,
                        Some("The connector did not answer in time."),
                    )
                    .await
                }
            }
        }
        (Decision::Run(_), None) => {
            settle(
                pool,
                &errand.id,
                "declined",
                None,
                Some(super::agent::REMOVED),
            )
            .await
        }
    }
    // The answer leaves now rather than at the next tick: somebody is
    // waiting for it in a tab.
    let _ = crate::account::sync::run(app).await;
}

async fn approval_holds(app: &AppHandle, errand: &Errand) -> bool {
    if errand.approval.is_none() {
        return false;
    }
    match crate::account::account_devices(app.clone()).await {
        Ok(devices) => super::relay_approval::holds(
            errand,
            &super::relay_approval::browser_keys(&devices),
            chrono::Utc::now(),
        ),
        Err(error) => {
            tracing::warn!(code = %error.code, "a relayed approval could not be checked");
            false
        }
    }
}

/// Picks up the calls addressed to this device. Called after every
/// synchronisation while the app is open, and from the sweep. Each call runs
/// on its own task, so a slow server never holds the synchronisation loop.
pub async fn run_pending(app: &AppHandle) {
    let Ok(pool) = super::pool(app).await else {
        return;
    };
    let Some(device) = this_device(&pool).await else {
        return;
    };
    for errand in pending(&pool, &device).await {
        let app = app.clone();
        let pool = pool.clone();
        tauri::async_runtime::spawn(async move {
            handle(&app, &pool, errand).await;
        });
    }
}

// --- Commands -------------------------------------------------------------------

#[tauri::command]
pub async fn connector_relay_settings(app: AppHandle) -> Result<RelaySettings, AppError> {
    Ok(settings(&app))
}

#[tauri::command]
pub async fn connector_relay_set_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<RelaySettings, AppError> {
    let value = RelaySettings { enabled };
    save_settings(&app, &value)?;
    // The offer follows the switch at once, on or off.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        publish(&handle).await;
        let _ = crate::account::sync::run(&handle).await;
    });
    Ok(value)
}

#[cfg(test)]
#[path = "relay_tests.rs"]
mod tests;
