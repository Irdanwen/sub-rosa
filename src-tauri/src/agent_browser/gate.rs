//! The consent gate (ADR-0094): no page of a site the person has not allowed
//! is ever requested, however the tab gets there.
//!
//! `open_url` asks before it navigates, but a click, a submitted form, a
//! redirect or a script can move the tab too. So every page target is held
//! by the DevTools `Fetch` domain, paused on its document requests before
//! they leave:
//!
//! - the agent's tab is held from the moment it is attached, and every tab
//!   the browser opens later (a popup, a link in a new tab) is attached
//!   automatically, *paused before it runs* (`waitForDebuggerOnStart`), held
//!   the same way, and only then let go;
//! - a paused request for a page's own document (its main frame) is let
//!   through when the site is allowed, asked about when it is new, and failed
//!   (`BlockedByClient`) when the person says no or does not answer in time.
//!   A redirect is a new request, so each hop is decided on its own. A
//!   document inside a frame of an allowed page goes on: the page the person
//!   allowed is the one that put it there;
//! - each document let through is one row in the egress ledger.
//!
//! The gate runs on its own task, fed by the client's event channel. It
//! never takes the action lock (an action may be the very click that is
//! waiting for this answer), only the consent it shares with the actions.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::{Mutex, Notify};

use super::browser::{Consent, ConsentAsker, Location, Tab};
use super::cdp::{agent_error, Attached, CdpClient};
use super::site;
use crate::domain::types::AppError;

/// How long a paused page waits for the person before it is refused.
pub const DECISION_WAIT: Duration = Duration::from_secs(120);

/// What the gate tells the app. The tests count the calls.
pub trait GateSink: Send + Sync {
    /// A page of `host` was let through: one egress ledger row.
    fn visited(&self, host: &str);
    /// The person answered "always" for `site`: it goes to Settings.
    fn remembered(&self, site: &str);
}

struct Inner {
    client: CdpClient,
    consent: Arc<Mutex<Consent>>,
    asker: Arc<dyn ConsentAsker>,
    sink: Arc<dyn GateSink>,
    /// The page sessions under guard, each with its target id, which is also
    /// the id of its main frame.
    pages: std::sync::Mutex<HashMap<String, String>>,
    /// Decisions in progress, and a wake-up when one ends.
    deciding: AtomicUsize,
    decided: Notify,
    /// The last refusal, for the action that caused it to report.
    refusal: std::sync::Mutex<Option<AppError>>,
}

#[derive(Clone)]
pub struct Gate {
    inner: Arc<Inner>,
}

/// Counts one decision while it runs.
struct Deciding<'a>(&'a Inner);

impl<'a> Deciding<'a> {
    fn begin(inner: &'a Inner) -> Self {
        inner.deciding.fetch_add(1, Ordering::SeqCst);
        Self(inner)
    }
}

impl Drop for Deciding<'_> {
    fn drop(&mut self) {
        self.0.deciding.fetch_sub(1, Ordering::SeqCst);
        self.0.decided.notify_waiters();
    }
}

/// Pauses every document request at the request stage, before it leaves.
fn fetch_patterns() -> Value {
    json!({ "patterns": [{ "urlPattern": "*", "resourceType": "Document", "requestStage": "Request" }] })
}

impl Gate {
    /// Starts listening to `client`'s events. Nothing is held until
    /// [`Gate::arm`].
    pub fn spawn(
        client: CdpClient,
        events: UnboundedReceiver<Value>,
        consent: Arc<Mutex<Consent>>,
        asker: Arc<dyn ConsentAsker>,
        sink: Arc<dyn GateSink>,
    ) -> Self {
        let gate = Self {
            inner: Arc::new(Inner {
                client,
                consent,
                asker,
                sink,
                pages: std::sync::Mutex::new(HashMap::new()),
                deciding: AtomicUsize::new(0),
                decided: Notify::new(),
                refusal: std::sync::Mutex::new(None),
            }),
        };
        let listening = gate.clone();
        tokio::spawn(async move { listening.listen(events).await });
        gate
    }

    /// Holds the agent's tab, then has the browser attach (paused) every tab
    /// it opens from now on. Fails, and the browser is not used, when the
    /// tab cannot be held.
    pub async fn arm(&self, tab: &Attached) -> Result<(), AppError> {
        self.guard_page(&tab.session_id, &tab.target_id).await?;
        self.inner
            .client
            .call(
                "Target.setAutoAttach",
                json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true }),
                None,
            )
            .await?;
        Ok(())
    }

    async fn guard_page(&self, session_id: &str, target_id: &str) -> Result<(), AppError> {
        // Known before the browser can pause anything on it.
        if let Ok(mut pages) = self.inner.pages.lock() {
            pages.insert(session_id.to_string(), target_id.to_string());
        }
        let enabled = self
            .inner
            .client
            .call("Fetch.enable", fetch_patterns(), Some(session_id))
            .await;
        if enabled.is_err() {
            if let Ok(mut pages) = self.inner.pages.lock() {
                pages.remove(session_id);
            }
        }
        enabled.map(|_| ())
    }

    fn guards_target(&self, target_id: &str) -> bool {
        self.inner
            .pages
            .lock()
            .map(|pages| pages.values().any(|held| held == target_id))
            .unwrap_or(false)
    }

    fn main_frame_of(&self, session_id: &str) -> Option<String> {
        self.inner
            .pages
            .lock()
            .ok()
            .and_then(|pages| pages.get(session_id).cloned())
    }

    async fn listen(self, mut events: UnboundedReceiver<Value>) {
        while let Some(event) = events.recv().await {
            // Each on its own task: one page waiting for an answer never
            // holds up another tab's attach or request.
            let gate = self.clone();
            tokio::spawn(async move { gate.on_event(event).await });
        }
    }

    async fn on_event(&self, event: Value) {
        let params = &event["params"];
        match event["method"].as_str() {
            Some("Target.attachedToTarget") => self.on_attached(params).await,
            Some("Target.detachedFromTarget") => {
                if let (Some(session), Ok(mut pages)) =
                    (params["sessionId"].as_str(), self.inner.pages.lock())
                {
                    pages.remove(session);
                }
            }
            Some("Fetch.requestPaused") => {
                if let Some(session) = event["sessionId"].as_str() {
                    self.on_paused(session, params).await;
                }
            }
            _ => {}
        }
    }

    /// A target the browser attached on its own: a page is held before it is
    /// let run; anything else (a worker) is simply let run.
    async fn on_attached(&self, params: &Value) {
        let Some(session) = params["sessionId"].as_str() else {
            return;
        };
        let info = &params["targetInfo"];
        let target = info["targetId"].as_str().unwrap_or_default();
        if info["type"].as_str() == Some("page")
            && !self.guards_target(target)
            && self.guard_page(session, target).await.is_err()
        {
            // A page the gate cannot hold is closed rather than let load.
            let _ = self
                .inner
                .client
                .call("Target.closeTarget", json!({ "targetId": target }), None)
                .await;
            return;
        }
        if params["waitingForDebugger"].as_bool() == Some(true) {
            let _ = self
                .inner
                .client
                .call("Runtime.runIfWaitingForDebugger", json!({}), Some(session))
                .await;
        }
    }

    async fn on_paused(&self, session: &str, params: &Value) {
        let Some(request_id) = params["requestId"].as_str() else {
            return;
        };
        // A session the gate does not know is decided as a page's own
        // document: unsure is the strict side.
        let main_frame = params["resourceType"].as_str() == Some("Document")
            && match self.main_frame_of(session) {
                Some(frame) => Some(frame.as_str()) == params["frameId"].as_str(),
                None => true,
            };
        let client = &self.inner.client;
        if !main_frame {
            let _ = client
                .call(
                    "Fetch.continueRequest",
                    json!({ "requestId": request_id }),
                    Some(session),
                )
                .await;
            return;
        }
        // Counted until the outcome is recorded, so an action waiting for
        // the gate to settle reads this one's refusal.
        let _deciding = Deciding::begin(&self.inner);
        let url = params["request"]["url"].as_str().unwrap_or_default();
        match self.decide(url).await {
            Ok(()) => {
                let continued = client
                    .call(
                        "Fetch.continueRequest",
                        json!({ "requestId": request_id }),
                        Some(session),
                    )
                    .await;
                if continued.is_ok() {
                    if let Some(host) = site::host_of(url) {
                        self.inner.sink.visited(&host);
                    }
                }
            }
            Err(refusal) => {
                if let Ok(mut slot) = self.inner.refusal.lock() {
                    *slot = Some(refusal);
                }
                let _ = client
                    .call(
                        "Fetch.failRequest",
                        json!({ "requestId": request_id, "errorReason": "BlockedByClient" }),
                        Some(session),
                    )
                    .await;
            }
        }
    }

    /// Whether a page of `url` may load, asking the person when its site is
    /// new. Only web addresses load at all.
    async fn decide(&self, url: &str) -> Result<(), AppError> {
        if !site::openable(url) {
            return Err(agent_error(
                "browser_url_refused",
                "Only http and https addresses can be opened.",
            ));
        }
        let site = site::site_of(url)
            .ok_or_else(|| agent_error("browser_url_refused", "That address has no site."))?;
        let mut consent = self.inner.consent.lock().await;
        match tokio::time::timeout(DECISION_WAIT, consent.admit(&site, &*self.inner.asker)).await {
            Ok(Ok(Some(remembered))) => {
                self.inner.sink.remembered(&remembered);
                Ok(())
            }
            Ok(Ok(None)) => Ok(()),
            Ok(Err(refusal)) => Err(refusal),
            Err(_) => Err(super::browser::unanswered(&site)),
        }
    }

    /// Waits, up to `limit`, until no decision is in progress.
    pub async fn settled(&self, limit: Duration) {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let notified = self.inner.decided.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.inner.deciding.load(Ordering::SeqCst) == 0 {
                return;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return;
            }
        }
    }

    /// The refusal since the last call, if any.
    pub fn take_refusal(&self) -> Option<AppError> {
        self.inner
            .refusal
            .lock()
            .ok()
            .and_then(|mut slot| slot.take())
    }
}

/// After an action that may have navigated: the gate's answer first. A page
/// it refused never loaded, so the refusal is the action's result and the
/// tab is not sent back anywhere. Otherwise the page the tab is on is checked
/// again (a backstop: the gate already held it), and only a page that fails
/// that check is left by going back. Returns where the tab is and the site
/// the person said "always" to, if any.
pub async fn after_action(
    tab: &mut Tab,
    gate: &Gate,
    consent: &Mutex<Consent>,
    asker: &dyn ConsentAsker,
) -> Result<(Location, Option<String>), AppError> {
    gate.settled(DECISION_WAIT + Duration::from_secs(5)).await;
    if let Some(refusal) = gate.take_refusal() {
        tab.refs.clear();
        return Err(refusal);
    }
    let location = tab.location().await?;
    let Some(site) = location.site() else {
        // about:blank and friends belong to no site.
        return Ok((location, None));
    };
    let admitted = consent.lock().await.admit(&site, asker).await;
    match admitted {
        Ok(remembered) => Ok((location, remembered)),
        Err(refusal) => {
            let _ = tab.back().await;
            Err(refusal)
        }
    }
}
