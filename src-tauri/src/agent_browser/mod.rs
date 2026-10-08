//! The agent browser (ADR-0094), desktop only: the desktop agent drives a Chromium-family
//! browser the person already has, in a profile of its own, one site at a
//! time with their consent.
//!
//! - **The app drives it, not the agent runtime.** The `june_browser` MCP
//!   server only relays a named action to the provider proxy
//!   (`/v1/browser/request`), which lands in [`dispatch`]. The browser is
//!   started by the app process, outside the Seatbelt jail (ADR-0006), and
//!   the runtime never sees its port.
//! - **Consent is per site, asked before the first request.** A site is a
//!   registrable domain (`site.rs`). A new one raises a card in the chat:
//!   always, only this time, or no. "Always" lands in Settings, where the
//!   person can take it back. A link that leads to a new site is asked about
//!   the same way, and refused by going back.
//! - **Some fields are the person's.** Password, payment and one-time-code
//!   fields are refused before they are focused, and so are CAPTCHAs
//!   (`snapshot.rs`). The agent is told to hand over, not to work around.
//! - **Visible and stoppable.** Every action is a journal entry the chat's
//!   indicator shows, with a Stop that closes the browser. After a Stop the
//!   agent cannot reopen it without the person saying yes again.
//! - **Egress.** The browser goes where the person's task needs, bounded by
//!   the allow list; each opened page is one row in the egress ledger
//!   (ADR-0043): the host and when, nothing of the page.

pub mod browser;
pub mod cdp;
pub mod launch;
pub mod site;
pub mod snapshot;
pub mod ws;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::domain::types::AppError;
use browser::{ConsentAnswer, ConsentAsker};
use cdp::agent_error;

const SETTINGS_FILE: &str = "agent-browser.json";
/// The status, pushed to every window after each change.
pub const STATE_EVENT: &str = "agent-browser://state";
/// A question for the person: `{ id, site }`, `site` null for "may the agent
/// use the browser again" after a Stop.
pub const CONSENT_EVENT: &str = "agent-browser://consent";
/// How long a consent card waits for an answer before the tool call gives up
/// and tells the agent to ask in words.
const CONSENT_WAIT: Duration = Duration::from_secs(180);
const JOURNAL_LIMIT: usize = 40;

/// What the person set in Settings › Agent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentBrowserSettings {
    pub enabled: bool,
    pub allowed_sites: Vec<String>,
    /// An `InstalledBrowser` id; the first one found when unset.
    pub browser: Option<String>,
}

impl Default for AgentBrowserSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            allowed_sites: Vec::new(),
            browser: None,
        }
    }
}

impl AgentBrowserSettings {
    /// Lowercased, deduplicated, sorted sites; anything that is not a site
    /// dropped.
    pub fn normalised(mut self) -> Self {
        let mut sites: Vec<String> = self
            .allowed_sites
            .iter()
            .filter_map(|entry| site::normalise_entry(entry))
            .collect();
        sites.sort();
        sites.dedup();
        self.allowed_sites = sites;
        self.browser = self.browser.filter(|id| !id.trim().is_empty());
        self
    }
}

/// One line of the journal the indicator shows. Structured, so the webview
/// words it in the person's language.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub at: String,
    /// `open`, `snapshot`, `click`, `type`, `select`, `scroll`, `back`,
    /// `wait`, `read`, `screenshot`, `refused`, `stopped`, `closed`.
    pub action: String,
    /// The site, or the control's name. Never what was typed.
    pub target: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingConsent {
    pub id: String,
    /// None asks whether the browser may be used again after a Stop.
    pub site: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserStatus {
    pub active: bool,
    pub stopped: bool,
    pub browser_name: Option<String>,
    pub site: Option<String>,
    pub journal: Vec<JournalEntry>,
    pub pending: Vec<PendingConsent>,
}

/// The live browser. Actions are serialised through `live`; Stop does not
/// take that lock (an action may be waiting minutes for a consent answer),
/// it reaches the process and the socket through their own slots.
struct Hub {
    live: tokio::sync::Mutex<Option<Live>>,
    child: Mutex<Option<tokio::process::Child>>,
    cdp: Mutex<Option<cdp::CdpClient>>,
    journal: Mutex<VecDeque<JournalEntry>>,
    pending: Mutex<HashMap<String, Waiting>>,
    stopped: AtomicBool,
    browser_name: Mutex<Option<String>>,
    site: Mutex<Option<String>>,
}

/// A consent card on screen: its site, and where the answer goes.
type Waiting = (Option<String>, oneshot::Sender<ConsentAnswer>);

struct Live {
    tab: browser::Tab,
    consent: browser::Consent,
}

fn hub() -> &'static Hub {
    static HUB: OnceLock<Hub> = OnceLock::new();
    HUB.get_or_init(|| Hub {
        live: tokio::sync::Mutex::new(None),
        child: Mutex::new(None),
        cdp: Mutex::new(None),
        journal: Mutex::new(VecDeque::new()),
        pending: Mutex::new(HashMap::new()),
        stopped: AtomicBool::new(false),
        browser_name: Mutex::new(None),
        site: Mutex::new(None),
    })
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(SETTINGS_FILE))
}

pub fn load_settings(app: &AppHandle) -> AgentBrowserSettings {
    settings_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<AgentBrowserSettings>(&raw).ok())
        .unwrap_or_default()
        .normalised()
}

fn save_settings(app: &AppHandle, settings: &AgentBrowserSettings) -> Result<(), AppError> {
    let path = settings_path(app).ok_or_else(|| {
        AppError::new(
            "agent_browser_settings_failed",
            "Could not find where to save the agent browser settings.",
        )
    })?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| AppError::new("agent_browser_settings_failed", error.to_string()))?;
    }
    let serialized = serde_json::to_string_pretty(settings)
        .map_err(|error| AppError::new("agent_browser_settings_failed", error.to_string()))?;
    std::fs::write(path, serialized)
        .map_err(|error| AppError::new("agent_browser_settings_failed", error.to_string()))
}

fn remember_site(app: &AppHandle, site: &str) {
    let mut settings = load_settings(app);
    settings.allowed_sites.push(site.to_string());
    if let Err(error) = save_settings(app, &settings.normalised()) {
        tracing::warn!(code = %error.code, "could not remember an allowed site");
    }
}

fn journal(action: &str, target: &str) {
    if let Ok(mut journal) = hub().journal.lock() {
        journal.push_back(JournalEntry {
            at: chrono::Utc::now().to_rfc3339(),
            action: action.to_string(),
            target: target.chars().take(120).collect(),
        });
        while journal.len() > JOURNAL_LIMIT {
            journal.pop_front();
        }
    }
}

pub fn status() -> AgentBrowserStatus {
    let hub = hub();
    let active = hub
        .cdp
        .lock()
        .ok()
        .and_then(|client| client.as_ref().map(cdp::CdpClient::is_open))
        .unwrap_or(false);
    AgentBrowserStatus {
        active,
        stopped: hub.stopped.load(Ordering::SeqCst),
        browser_name: hub.browser_name.lock().ok().and_then(|name| name.clone()),
        site: hub.site.lock().ok().and_then(|site| site.clone()),
        journal: hub
            .journal
            .lock()
            .map(|journal| journal.iter().cloned().collect())
            .unwrap_or_default(),
        pending: hub
            .pending
            .lock()
            .map(|pending| {
                pending
                    .iter()
                    .map(|(id, (site, _))| PendingConsent {
                        id: id.clone(),
                        site: site.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn publish(app: &AppHandle) {
    let _ = app.emit(STATE_EVENT, status());
}

/// Asks through a card in the app's windows.
struct WindowAsker {
    app: AppHandle,
}

impl WindowAsker {
    async fn question(&self, site: Option<&str>) -> ConsentAnswer {
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        if let Ok(mut pending) = hub().pending.lock() {
            pending.insert(id.clone(), (site.map(str::to_string), sender));
        }
        let _ = self.app.emit(
            CONSENT_EVENT,
            PendingConsent {
                id: id.clone(),
                site: site.map(str::to_string),
            },
        );
        publish(&self.app);
        let answer = match tokio::time::timeout(CONSENT_WAIT, receiver).await {
            Ok(Ok(answer)) => answer,
            _ => ConsentAnswer::Unanswered,
        };
        if let Ok(mut pending) = hub().pending.lock() {
            pending.remove(&id);
        }
        publish(&self.app);
        answer
    }
}

impl ConsentAsker for WindowAsker {
    fn ask<'a>(
        &'a self,
        site: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ConsentAnswer> + Send + 'a>> {
        Box::pin(self.question(Some(site)))
    }
}

/// One action from the `june_browser` MCP server.
pub async fn dispatch(app: AppHandle, action: &str, params: Value) -> Result<Value, AppError> {
    let settings = load_settings(&app);
    if !settings.enabled {
        return Err(agent_error(
            "browser_disabled",
            "The person turned the agent browser off in Settings. Use web_fetch instead, or ask them to turn it on.",
        ));
    }
    let asker = WindowAsker { app: app.clone() };
    if hub().stopped.load(Ordering::SeqCst) {
        match asker.question(None).await {
            ConsentAnswer::Always | ConsentAnswer::Once => {
                hub().stopped.store(false, Ordering::SeqCst);
            }
            _ => {
                return Err(agent_error(
                    "browser_stopped",
                    "The person stopped the browser. Do not use it again unless they ask you to.",
                ))
            }
        }
    }
    let outcome = run(&app, &asker, &settings, action, &params).await;
    if let Err(error) = &outcome {
        if matches!(
            error.code.as_str(),
            "browser_field_refused" | "browser_captcha_refused" | "browser_site_refused"
        ) {
            journal("refused", error.code.trim_start_matches("browser_"));
        }
    }
    publish(&app);
    outcome
}

async fn run(
    app: &AppHandle,
    asker: &WindowAsker,
    settings: &AgentBrowserSettings,
    action: &str,
    params: &Value,
) -> Result<Value, AppError> {
    let mut guard = hub().live.lock().await;
    if action == "close" {
        close_live(&mut guard).await;
        journal("closed", "");
        return Ok(json!({ "closed": true }));
    }
    let alive = guard.as_ref().is_some_and(|live| live.tab.cdp.is_open());
    if !alive {
        if action != "open_url" {
            return Err(agent_error(
                "browser_not_open",
                "No page is open. Call open_url first.",
            ));
        }
        *guard = Some(start(app, settings).await?);
    }
    let Some(live) = guard.as_mut() else {
        return Err(agent_error("browser_not_open", "No page is open."));
    };
    // The durable list may have changed in Settings since the last call.
    live.consent.allowed = settings.allowed_sites.clone();
    let text = |key: &str| {
        params
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };

    if action == "open_url" {
        let url = text("url");
        let started = std::time::Instant::now();
        let (location, remembered, loaded) = live.tab.open(&url, &mut live.consent, asker).await?;
        if let Some(site) = remembered {
            remember_site(app, &site);
        }
        record_visit(&location, started.elapsed());
        let site = location.site().unwrap_or_default();
        set_site(Some(site.clone()));
        journal("open", &site);
        return Ok(json!({
            "url": location.url,
            "title": location.title,
            "loaded": loaded,
            "next": "Call snapshot to read the page and get element refs.",
        }));
    }

    // Every other action works on whatever page the tab is on, which a click
    // may have moved to another site since the last check.
    admit_current(app, live, asker).await?;
    let reference = text("ref");
    let result = match action {
        "snapshot" => {
            let (snapshot, captcha) = live.tab.snapshot().await?;
            let location = live.tab.location().await?;
            journal("snapshot", &location.site().unwrap_or_default());
            let mut value = json!({
                "url": location.url,
                "title": location.title,
                "snapshot": snapshot.text,
                "truncated": snapshot.truncated,
                "captcha": captcha,
            });
            if captcha {
                value["note"] = json!("A CAPTCHA is on this page. Do not try to solve it: ask the person to complete it in the browser window, then call wait_for.");
            }
            if params.get("screenshot").and_then(Value::as_bool) == Some(true) {
                value["screenshot"] = json!({
                    "base64": live.tab.screenshot().await?,
                    "mimeType": "image/jpeg",
                });
            }
            value
        }
        "click" => {
            let target = live.tab.click(&reference).await?;
            journal("click", &target.name);
            tokio::time::sleep(Duration::from_millis(500)).await;
            live.tab.settle().await;
            live.tab.refs.clear();
            follow_up(app, live, asker).await?
        }
        "type" => {
            let submit = params.get("submit").and_then(Value::as_bool) == Some(true);
            let target = live
                .tab
                .type_text(&reference, &text("text"), submit)
                .await?;
            journal("type", &target.name);
            if submit {
                tokio::time::sleep(Duration::from_millis(500)).await;
                live.tab.settle().await;
                live.tab.refs.clear();
                follow_up(app, live, asker).await?
            } else {
                json!({ "typed": true })
            }
        }
        "select" => {
            let selected = live.tab.select(&reference, &text("value")).await?;
            journal("select", &selected);
            json!({ "selected": selected })
        }
        "scroll" => {
            let down = text("direction") != "up";
            journal("scroll", if down { "down" } else { "up" });
            live.tab.scroll(down).await?
        }
        "back" => {
            live.tab.back().await?;
            journal("back", "");
            follow_up(app, live, asker).await?
        }
        "wait_for" => {
            let seconds = params.get("seconds").and_then(Value::as_u64).unwrap_or(5);
            let wanted = text("text");
            journal("wait", "");
            let found = live
                .tab
                .wait_for(
                    Some(wanted.as_str()).filter(|text| !text.is_empty()),
                    seconds,
                )
                .await?;
            json!({ "found": found })
        }
        "extract_text" => {
            let (body, truncated) = live.tab.extract_text().await?;
            let location = live.tab.location().await?;
            journal("read", &location.site().unwrap_or_default());
            json!({ "url": location.url, "title": location.title, "text": body, "truncated": truncated })
        }
        "screenshot" => {
            journal("screenshot", "");
            json!({ "screenshot": { "base64": live.tab.screenshot().await?, "mimeType": "image/jpeg" } })
        }
        other => {
            return Err(agent_error(
                "browser_unknown_action",
                format!("Unknown browser action: {other}."),
            ))
        }
    };
    Ok(result)
}

/// After something that may navigate: the new page's site must be allowed
/// too, or the tab goes back to where it was.
async fn follow_up(
    app: &AppHandle,
    live: &mut Live,
    asker: &WindowAsker,
) -> Result<Value, AppError> {
    if let Err(error) = admit_current(app, live, asker).await {
        let _ = live.tab.back().await;
        return Err(error);
    }
    let location = live.tab.location().await?;
    Ok(
        json!({ "url": location.url, "title": location.title, "next": "Take a new snapshot: refs from the last one may no longer be valid." }),
    )
}

async fn admit_current(
    app: &AppHandle,
    live: &mut Live,
    asker: &WindowAsker,
) -> Result<(), AppError> {
    let location = live.tab.location().await?;
    let Some(site) = location.site() else {
        // about:blank and friends belong to no site.
        return Ok(());
    };
    if let Some(remembered) = live.consent.admit(&site, asker).await? {
        remember_site(app, &remembered);
    }
    set_site(Some(site));
    Ok(())
}

fn set_site(site: Option<String>) {
    if let Ok(mut current) = hub().site.lock() {
        *current = site;
    }
}

/// One ledger row per opened page: the host, when, how long. The browser's
/// own traffic is its own; this is the person-readable trace that the agent
/// went there.
fn record_visit(location: &browser::Location, elapsed: Duration) {
    let Some(host) = site::host_of(&location.url) else {
        return;
    };
    crate::egress_ledger::record(crate::egress_ledger::EgressEntry {
        at: chrono::Utc::now().to_rfc3339(),
        host,
        purpose: "browser".to_string(),
        method: "GET".to_string(),
        request_bytes: 0,
        response_bytes: 0,
        status: None,
        duration_ms: elapsed.as_millis().min(u128::from(u64::MAX)) as u64,
        model: None,
        note_id: None,
    });
}

async fn start(app: &AppHandle, settings: &AgentBrowserSettings) -> Result<Live, AppError> {
    let chosen = launch::pick(settings.browser.as_deref()).ok_or_else(|| {
        agent_error(
            "browser_not_installed",
            "No Chromium-family browser (Chrome, Edge, Brave, Arc or Chromium) is installed. Tell the person the agent browser needs one, or use web_fetch.",
        )
    })?;
    let profile_dir = crate::app_paths::app_data_dir(app)
        .map_err(|error| agent_error("browser_profile_failed", error.to_string()))?
        .join("agent-browser-profile");
    let launched = launch::launch(&chosen.executable, &profile_dir).await?;
    let client = cdp::CdpClient::connect(launched.port, &launched.path).await?;
    let session_id = cdp::attach_to_page(&client).await?;
    if let Ok(mut slot) = hub().child.lock() {
        *slot = launched.child;
    }
    if let Ok(mut slot) = hub().cdp.lock() {
        *slot = Some(client.clone());
    }
    if let Ok(mut name) = hub().browser_name.lock() {
        *name = Some(chosen.name.clone());
    }
    Ok(Live {
        tab: browser::Tab::new(client, session_id),
        consent: browser::Consent {
            allowed: settings.allowed_sites.clone(),
            this_session: Vec::new(),
        },
    })
}

async fn close_live(guard: &mut Option<Live>) {
    if let Some(live) = guard.take() {
        let _ = live.tab.cdp.call("Browser.close", json!({}), None).await;
        live.tab.cdp.close().await;
    }
    shut_down_process().await;
}

/// Closes the browser whoever holds the action lock.
async fn shut_down_process() {
    let client = hub().cdp.lock().ok().and_then(|mut slot| slot.take());
    if let Some(client) = client {
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            client.call("Browser.close", json!({}), None),
        )
        .await;
    }
    let child = hub().child.lock().ok().and_then(|mut slot| slot.take());
    if let Some(mut child) = child {
        let _ = child.start_kill();
    }
    set_site(None);
}

#[tauri::command]
pub fn agent_browser_status() -> AgentBrowserStatus {
    status()
}

/// The settings with the browsers this machine has, for the picker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserSettingsResponse {
    pub settings: AgentBrowserSettings,
    pub browsers: Vec<InstalledBrowserDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledBrowserDto {
    pub id: String,
    pub name: String,
}

fn installed_dtos() -> Vec<InstalledBrowserDto> {
    launch::installed()
        .into_iter()
        .map(|browser| InstalledBrowserDto {
            id: browser.id,
            name: browser.name,
        })
        .collect()
}

#[tauri::command]
pub fn agent_browser_settings(app: AppHandle) -> AgentBrowserSettingsResponse {
    AgentBrowserSettingsResponse {
        settings: load_settings(&app),
        browsers: installed_dtos(),
    }
}

#[tauri::command]
pub async fn agent_browser_save_settings(
    app: AppHandle,
    settings: AgentBrowserSettings,
) -> Result<AgentBrowserSettingsResponse, AppError> {
    let settings = settings.normalised();
    save_settings(&app, &settings)?;
    if !settings.enabled {
        stop_now(&app).await;
    }
    Ok(AgentBrowserSettingsResponse {
        settings,
        browsers: installed_dtos(),
    })
}

/// `answer`: `always`, `once` or `deny`.
#[tauri::command]
pub fn agent_browser_answer_consent(app: AppHandle, id: String, answer: String) {
    let parsed = match answer.as_str() {
        "always" => ConsentAnswer::Always,
        "once" => ConsentAnswer::Once,
        _ => ConsentAnswer::Deny,
    };
    let sender = hub()
        .pending
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(&id));
    if let Some((_, sender)) = sender {
        let _ = sender.send(parsed);
    }
    publish(&app);
}

async fn stop_now(app: &AppHandle) {
    hub().stopped.store(true, Ordering::SeqCst);
    let waiting: Vec<_> = hub()
        .pending
        .lock()
        .map(|mut pending| pending.drain().map(|(_, (_, sender))| sender).collect())
        .unwrap_or_default();
    for sender in waiting {
        let _ = sender.send(ConsentAnswer::Deny);
    }
    shut_down_process().await;
    journal("stopped", "");
    publish(app);
}

/// The indicator's Stop: closes the browser now, and the agent has to be
/// let back in before it opens another.
#[tauri::command]
pub async fn agent_browser_stop(app: AppHandle) {
    stop_now(&app).await;
}
