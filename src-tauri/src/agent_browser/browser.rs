//! The agent's actions on one tab, in DevTools commands.
//!
//! Nothing here knows about Tauri: the tab is a [`CdpClient`] and a session
//! id, and consent is a [`ConsentAsker`]. That is what lets the tests drive
//! every action against a scripted socket, and what keeps the rules (no
//! password, no card number, no CAPTCHA, no site the person has not allowed)
//! in one place the app and the tests both go through.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde_json::{json, Value};

use super::cdp::{agent_error, CdpClient};
use super::site::{self, Decision};
use super::snapshot::{self, RefTarget, Snapshot};
use crate::domain::types::AppError;

/// How long a page may take to finish loading before the agent is told it is
/// still loading and gets on with it.
const LOAD_WAIT: Duration = Duration::from_secs(12);
const POLL: Duration = Duration::from_millis(250);
/// The longest `wait_for` the agent may ask for.
pub const MAX_WAIT_SECONDS: u64 = 30;
const MAX_EXTRACT_CHARS: usize = 20_000;

/// The person's answer to "may the agent use this site?".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsentAnswer {
    /// Allowed now and remembered in Settings.
    Always,
    /// Allowed until the browser closes.
    Once,
    Deny,
    /// Nobody answered in time.
    Unanswered,
}

/// Asks the person. The app shows a card in the chat; the tests answer from
/// a script. Shared between the actions and the gate (`gate.rs`), which asks
/// on its own task.
pub trait ConsentAsker: Send + Sync {
    fn ask<'a>(&'a self, site: &'a str)
        -> Pin<Box<dyn Future<Output = ConsentAnswer> + Send + 'a>>;
}

/// The consent state for one browser session.
#[derive(Debug, Clone, Default)]
pub struct Consent {
    /// The durable allow list, from Settings.
    pub allowed: Vec<String>,
    /// "Only this time" answers.
    pub this_session: Vec<String>,
}

impl Consent {
    /// Lets `site` through, asking the person when it is new. Returns the
    /// site to add to the durable list when the answer was "always".
    pub async fn admit(
        &mut self,
        site: &str,
        asker: &dyn ConsentAsker,
    ) -> Result<Option<String>, AppError> {
        if site::decide(site, &self.allowed, &self.this_session) == Decision::Allowed {
            return Ok(None);
        }
        match asker.ask(site).await {
            ConsentAnswer::Always => {
                self.allowed.push(site.to_string());
                Ok(Some(site.to_string()))
            }
            ConsentAnswer::Once => {
                self.this_session.push(site.to_string());
                Ok(None)
            }
            ConsentAnswer::Deny => Err(agent_error(
                "browser_site_refused",
                format!("The person did not allow the browser on {site}. Do not try this site again unless they ask."),
            )),
            ConsentAnswer::Unanswered => Err(unanswered(site)),
        }
    }
}

/// Nobody answered whether the browser may use `site`.
pub fn unanswered(site: &str) -> AppError {
    agent_error(
        "browser_site_unanswered",
        format!("The person has not answered whether the browser may use {site}. Ask them in the chat, and try again once they agree."),
    )
}

/// One driven tab.
pub struct Tab {
    pub cdp: CdpClient,
    pub session_id: String,
    pub refs: HashMap<String, RefTarget>,
}

/// Where the tab is.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Location {
    pub url: String,
    pub title: String,
}

impl Location {
    pub fn site(&self) -> Option<String> {
        site::site_of(&self.url)
    }
}

impl Tab {
    pub fn new(cdp: CdpClient, session_id: String) -> Self {
        Self {
            cdp,
            session_id,
            refs: HashMap::new(),
        }
    }

    async fn page(&self, method: &str, params: Value) -> Result<Value, AppError> {
        self.cdp.call(method, params, Some(&self.session_id)).await
    }

    /// Evaluates `expression` in the page and returns its JSON value.
    pub async fn evaluate(&self, expression: &str) -> Result<Value, AppError> {
        let result = self
            .page(
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
            )
            .await?;
        if let Some(details) = result.get("exceptionDetails") {
            let text = details
                .get("exception")
                .and_then(|exception| exception.get("description"))
                .and_then(Value::as_str)
                .or_else(|| details.get("text").and_then(Value::as_str))
                .unwrap_or("The page raised an error.");
            return Err(agent_error("browser_script_failed", text.to_string()));
        }
        Ok(result
            .get("result")
            .and_then(|result| result.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    pub async fn location(&self) -> Result<Location, AppError> {
        let value = self
            .evaluate("({ url: location.href, title: document.title })")
            .await?;
        Ok(Location {
            url: value
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            title: value
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
    }

    /// Waits for the document to finish loading, up to [`LOAD_WAIT`].
    /// Returns false when it was still loading at the deadline.
    pub async fn settle(&self) -> bool {
        let deadline = tokio::time::Instant::now() + LOAD_WAIT;
        loop {
            if let Ok(Value::String(state)) = self.evaluate("document.readyState").await {
                if state == "complete" {
                    return true;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(POLL).await;
        }
    }

    /// Opens `url` after asking. Never navigates when the site is refused: the
    /// refusal is decided before the first byte is requested. The gate
    /// (`gate.rs`) holds the navigation itself too, and every redirect it
    /// takes; asking here first is what lets the agent hear a refusal as the
    /// answer to `open_url`. The consent is let go before navigating, since
    /// the gate needs it to let the page through.
    pub async fn open(
        &mut self,
        url: &str,
        consent: &tokio::sync::Mutex<Consent>,
        asker: &dyn ConsentAsker,
    ) -> Result<(Location, Option<String>, bool), AppError> {
        if !site::openable(url) {
            return Err(agent_error(
                "browser_url_refused",
                "Only http and https addresses can be opened.",
            ));
        }
        let site = site::site_of(url)
            .ok_or_else(|| agent_error("browser_url_refused", "That address has no site."))?;
        let remembered = consent.lock().await.admit(&site, asker).await?;
        let navigated = self.page("Page.navigate", json!({ "url": url })).await?;
        if let Some(error) = navigated.get("errorText").and_then(Value::as_str) {
            if !error.is_empty() {
                return Err(agent_error(
                    "browser_navigation_failed",
                    format!("The page could not be opened: {error}."),
                ));
            }
        }
        self.refs.clear();
        let loaded = self.settle().await;
        Ok((self.location().await?, remembered, loaded))
    }

    /// The accessibility snapshot, refs renewed.
    pub async fn snapshot(&mut self) -> Result<(Snapshot, bool), AppError> {
        let tree = self.page("Accessibility.getFullAXTree", json!({})).await?;
        let snapshot = snapshot::from_ax_tree(&tree);
        self.refs = snapshot.refs.clone();
        let captcha = matches!(
            self.evaluate(snapshot::CAPTCHA_PROBE).await,
            Ok(Value::Bool(true))
        );
        Ok((snapshot, captcha))
    }

    fn target(&self, reference: &str) -> Result<RefTarget, AppError> {
        self.refs.get(reference.trim()).cloned().ok_or_else(|| {
            agent_error(
                "browser_unknown_ref",
                format!("There is no element {reference} on the last snapshot. Take a new snapshot and use one of its refs."),
            )
        })
    }

    pub async fn click(&self, reference: &str) -> Result<RefTarget, AppError> {
        let target = self.target(reference)?;
        if snapshot::is_captcha_control(&target.name) {
            return Err(captcha_refusal());
        }
        let backend = target.backend_node_id;
        let _ = self
            .page(
                "DOM.scrollIntoViewIfNeeded",
                json!({ "backendNodeId": backend }),
            )
            .await;
        let model = self
            .page("DOM.getBoxModel", json!({ "backendNodeId": backend }))
            .await?;
        let (x, y) = center_of(&model).ok_or_else(|| {
            agent_error(
                "browser_not_clickable",
                "That element is not on screen. Scroll, take a new snapshot, and try again.",
            )
        })?;
        for (kind, extra) in [
            ("mouseMoved", json!({})),
            ("mousePressed", json!({ "button": "left", "clickCount": 1 })),
            (
                "mouseReleased",
                json!({ "button": "left", "clickCount": 1 }),
            ),
        ] {
            let mut params = json!({ "type": kind, "x": x, "y": y });
            if let (Some(params), Some(extra)) = (params.as_object_mut(), extra.as_object()) {
                params.extend(extra.clone());
            }
            self.page("Input.dispatchMouseEvent", params).await?;
        }
        Ok(target)
    }

    /// Refuses before focusing: a refused field is never touched.
    async fn guard_field(&self, target: &RefTarget) -> Result<(), AppError> {
        if snapshot::is_captcha_control(&target.name) {
            return Err(captcha_refusal());
        }
        let described = self
            .page(
                "DOM.describeNode",
                json!({ "backendNodeId": target.backend_node_id }),
            )
            .await?;
        let node = described.get("node").cloned().unwrap_or(Value::Null);
        let node_name = node
            .get("nodeName")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let attributes: Vec<String> = node
            .get("attributes")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        if let Some(kind) = snapshot::sensitive_field(node_name, &attributes, &target.name) {
            return Err(agent_error("browser_field_refused", kind.refusal()));
        }
        Ok(())
    }

    async fn object_id(&self, backend_node_id: i64) -> Result<String, AppError> {
        self.page(
            "DOM.resolveNode",
            json!({ "backendNodeId": backend_node_id }),
        )
        .await?
        .get("object")
        .and_then(|object| object.get("objectId"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            agent_error(
                "browser_stale_ref",
                "That element is gone. Take a new snapshot.",
            )
        })
    }

    pub async fn type_text(
        &self,
        reference: &str,
        text: &str,
        submit: bool,
    ) -> Result<RefTarget, AppError> {
        let target = self.target(reference)?;
        self.guard_field(&target).await?;
        let backend = target.backend_node_id;
        self.page("DOM.focus", json!({ "backendNodeId": backend }))
            .await?;
        let object_id = self.object_id(backend).await?;
        // Replace, not append: the agent says what the field should hold.
        self.page(
            "Runtime.callFunctionOn",
            json!({
                "objectId": object_id,
                "functionDeclaration": "function () { if ('value' in this) { this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); } else if (this.isContentEditable) { this.textContent = ''; } }",
            }),
        )
        .await?;
        self.page("Input.insertText", json!({ "text": text }))
            .await?;
        if submit {
            for kind in ["keyDown", "keyUp"] {
                self.page(
                    "Input.dispatchKeyEvent",
                    json!({
                        "type": kind,
                        "key": "Enter",
                        "code": "Enter",
                        "windowsVirtualKeyCode": 13,
                        "nativeVirtualKeyCode": 13,
                        "text": if kind == "keyDown" { "\r" } else { "" },
                    }),
                )
                .await?;
            }
        }
        Ok(target)
    }

    pub async fn select(&self, reference: &str, choice: &str) -> Result<String, AppError> {
        let target = self.target(reference)?;
        self.guard_field(&target).await?;
        let object_id = self.object_id(target.backend_node_id).await?;
        let result = self
            .page(
                "Runtime.callFunctionOn",
                json!({
                    "objectId": object_id,
                    "returnByValue": true,
                    "arguments": [{ "value": choice }],
                    "functionDeclaration": "function (wanted) { if (this.tagName !== 'SELECT') { return { error: 'not a list' }; } const want = String(wanted).trim().toLowerCase(); const options = Array.from(this.options); const option = options.find((o) => o.value === wanted || (o.label || '').trim().toLowerCase() === want || (o.text || '').trim().toLowerCase() === want); if (!option) { return { error: 'no option', options: options.slice(0, 40).map((o) => o.label || o.text) }; } this.value = option.value; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); return { selected: option.label || option.text }; }",
                }),
            )
            .await?;
        let value = result
            .get("result")
            .and_then(|result| result.get("value"))
            .cloned()
            .unwrap_or(Value::Null);
        if let Some(selected) = value.get("selected").and_then(Value::as_str) {
            return Ok(selected.to_string());
        }
        match value.get("error").and_then(Value::as_str) {
            Some("not a list") => Err(agent_error(
                "browser_not_a_list",
                "That element is not a drop-down list. Click it instead.",
            )),
            _ => {
                let options = value
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|options| {
                        options
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default();
                Err(agent_error(
                    "browser_no_such_option",
                    format!("No option matches. The options are: {options}."),
                ))
            }
        }
    }

    pub async fn scroll(&self, down: bool) -> Result<Value, AppError> {
        let sign = if down { "" } else { "-" };
        self.evaluate(&format!(
            "(() => {{ window.scrollBy(0, {sign}Math.round(window.innerHeight * 0.8)); return {{ y: Math.round(window.scrollY), height: document.documentElement.scrollHeight }}; }})()"
        ))
        .await
    }

    pub async fn back(&mut self) -> Result<Location, AppError> {
        self.evaluate("history.back()").await?;
        tokio::time::sleep(Duration::from_millis(400)).await;
        self.refs.clear();
        self.settle().await;
        self.location().await
    }

    /// Waits until `text` shows on the page, or `seconds` pass.
    pub async fn wait_for(&self, text: Option<&str>, seconds: u64) -> Result<bool, AppError> {
        let seconds = seconds.clamp(1, MAX_WAIT_SECONDS);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);
        let Some(text) = text.filter(|text| !text.trim().is_empty()) else {
            tokio::time::sleep(Duration::from_secs(seconds)).await;
            return Ok(true);
        };
        let probe = format!(
            "(document.body ? document.body.innerText : '').includes({})",
            Value::String(text.to_string())
        );
        loop {
            if let Ok(Value::Bool(true)) = self.evaluate(&probe).await {
                return Ok(true);
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(false);
            }
            tokio::time::sleep(POLL).await;
        }
    }

    pub async fn extract_text(&self) -> Result<(String, bool), AppError> {
        let value = self
            .evaluate("document.body ? document.body.innerText : ''")
            .await?;
        let text = value.as_str().unwrap_or_default();
        let truncated = text.chars().count() > MAX_EXTRACT_CHARS;
        Ok((text.chars().take(MAX_EXTRACT_CHARS).collect(), truncated))
    }

    /// The visible part of the page, as a JPEG in base64.
    pub async fn screenshot(&self) -> Result<String, AppError> {
        self.page(
            "Page.captureScreenshot",
            json!({ "format": "jpeg", "quality": 60 }),
        )
        .await?
        .get("data")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            agent_error(
                "browser_screenshot_failed",
                "The browser returned no picture.",
            )
        })
    }
}

fn captcha_refusal() -> AppError {
    agent_error(
        "browser_captcha_refused",
        "This is a CAPTCHA. Sub Rosa never solves them: ask the person to complete it in the browser window, then call wait_for and continue.",
    )
}

/// The middle of a `DOM.getBoxModel` content quad.
pub fn center_of(model: &Value) -> Option<(f64, f64)> {
    let quad = model.get("model")?.get("content")?.as_array()?;
    if quad.len() < 8 {
        return None;
    }
    let numbers: Vec<f64> = quad.iter().filter_map(Value::as_f64).collect();
    if numbers.len() < 8 {
        return None;
    }
    let x = (numbers[0] + numbers[2] + numbers[4] + numbers[6]) / 4.0;
    let y = (numbers[1] + numbers[3] + numbers[5] + numbers[7]) / 4.0;
    (x.is_finite() && y.is_finite()).then_some((x, y))
}
