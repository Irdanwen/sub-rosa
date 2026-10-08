//! A DevTools protocol client over one browser-level socket.
//!
//! Commands carry an id and wait for the answer bearing it; events are not
//! subscribed to (the browser's state is read when an action needs it, which
//! is simpler to reason about than an event stream and is all the agent's
//! turn-by-turn pace asks for). Pages are driven through flattened target
//! sessions, so one socket carries the browser and its tab.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::net::tcp::OwnedWriteHalf;
use tokio::sync::{oneshot, Mutex};

use super::ws;
use crate::domain::types::AppError;

/// How long one command may take. Navigation is waited for separately, so
/// nothing here should come near it.
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

type Pending = Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

#[derive(Clone)]
pub struct CdpClient {
    writer: Arc<Mutex<OwnedWriteHalf>>,
    pending: Pending,
    next_id: Arc<AtomicU64>,
    open: Arc<AtomicBool>,
}

/// An error addressed to the agent, in English: it reads tool results, the
/// person reads the chat. Built from a variable so the catalog extractor,
/// which collects the person's sentences, leaves it alone.
pub fn agent_error(code: &str, message: impl Into<String>) -> AppError {
    let message: String = message.into();
    AppError::new(code, message)
}

impl CdpClient {
    /// Connects to `ws://127.0.0.1:{port}{path}` (the browser endpoint the
    /// browser wrote into `DevToolsActivePort`) and starts the reader.
    pub async fn connect(port: u16, path: &str) -> Result<Self, AppError> {
        let (mut reader, writer) = ws::connect(port, path)
            .await
            .map_err(|error| agent_error("browser_connect_failed", error.to_string()))?;
        let client = Self {
            writer: Arc::new(Mutex::new(writer)),
            pending: Arc::new(std::sync::Mutex::new(HashMap::new())),
            next_id: Arc::new(AtomicU64::new(1)),
            open: Arc::new(AtomicBool::new(true)),
        };
        let pending = client.pending.clone();
        let open = client.open.clone();
        let writer = client.writer.clone();
        tokio::spawn(async move {
            loop {
                match ws::read_message(&mut reader).await {
                    Ok(ws::Incoming::Text(text)) => deliver(&pending, &text),
                    Ok(ws::Incoming::Ping(payload)) => {
                        let mut writer = writer.lock().await;
                        let _ = writer.write_all(&ws::pong_frame(&payload)).await;
                    }
                    Ok(ws::Incoming::Closed) | Err(_) => break,
                }
            }
            open.store(false, Ordering::SeqCst);
            // Whoever is still waiting learns the browser is gone now rather
            // than after the timeout.
            let waiting: Vec<_> = pending
                .lock()
                .map(|mut map| map.drain().map(|(_, sender)| sender).collect())
                .unwrap_or_default();
            for sender in waiting {
                let _ = sender.send(Err("The browser closed.".to_string()));
            }
        });
        Ok(client)
    }

    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    /// Sends `method` (to the page when `session_id` names one) and waits for
    /// its result.
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
    ) -> Result<Value, AppError> {
        if !self.is_open() {
            return Err(agent_error(
                "browser_closed",
                "The browser is closed. Open a page again to start a new one.",
            ));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session_id) = session_id {
            message["sessionId"] = json!(session_id);
        }
        let (sender, receiver) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id, sender);
        }
        {
            let mut writer = self.writer.lock().await;
            if let Err(error) = ws::send_text(&mut *writer, &message.to_string()).await {
                self.forget(id);
                return Err(agent_error("browser_send_failed", error.to_string()));
            }
        }
        match tokio::time::timeout(COMMAND_TIMEOUT, receiver).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(message))) => Err(agent_error("browser_command_failed", message)),
            Ok(Err(_)) => Err(agent_error("browser_closed", "The browser closed.")),
            Err(_) => {
                self.forget(id);
                Err(agent_error(
                    "browser_timeout",
                    format!("The browser did not answer {method} in time."),
                ))
            }
        }
    }

    fn forget(&self, id: u64) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
    }

    pub async fn close(&self) {
        let mut writer = self.writer.lock().await;
        let _ = ws::send_close(&mut *writer).await;
    }
}

/// Routes one incoming message to the command waiting for it. Events (no id)
/// are dropped: nothing subscribes to them.
fn deliver(pending: &Pending, text: &str) {
    let Ok(message) = serde_json::from_str::<Value>(text) else {
        return;
    };
    let Some(id) = message.get("id").and_then(Value::as_u64) else {
        return;
    };
    let Some(sender) = pending.lock().ok().and_then(|mut map| map.remove(&id)) else {
        return;
    };
    let outcome = match message.get("error") {
        Some(error) => Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("The browser refused the command.")
            .to_string()),
        None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
    };
    let _ = sender.send(outcome);
}

/// Picks the tab to drive: the first page target, or a new blank one.
pub async fn attach_to_page(client: &CdpClient) -> Result<String, AppError> {
    let targets = client.call("Target.getTargets", json!({}), None).await?;
    let existing = targets
        .get("targetInfos")
        .and_then(Value::as_array)
        .and_then(|infos| {
            infos.iter().find(|info| {
                info.get("type").and_then(Value::as_str) == Some("page")
                    && !info
                        .get("url")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .starts_with("devtools://")
            })
        })
        .and_then(|info| info.get("targetId").and_then(Value::as_str))
        .map(str::to_string);
    let target_id = match existing {
        Some(id) => id,
        None => client
            .call("Target.createTarget", json!({ "url": "about:blank" }), None)
            .await?
            .get("targetId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| agent_error("browser_no_page", "The browser opened no tab."))?,
    };
    let attached = client
        .call(
            "Target.attachToTarget",
            json!({ "targetId": target_id, "flatten": true }),
            None,
        )
        .await?;
    let session_id = attached
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| agent_error("browser_no_page", "The browser did not share its tab."))?;
    for domain in ["Page.enable", "DOM.enable", "Accessibility.enable"] {
        // A domain that refuses to enable still answers the reads below; the
        // tab is usable either way.
        let _ = client.call(domain, json!({}), Some(&session_id)).await;
    }
    Ok(session_id)
}
