//! A DevTools protocol client over one browser-level connection.
//!
//! Commands carry an id and wait for the answer bearing it. Events (messages
//! without an id) go to one channel, read by the consent gate (`gate.rs`),
//! which is the only part that needs to hear the browser speak first: a
//! paused request, a new tab attached. Pages are driven through flattened
//! target sessions, so one connection carries the browser and its tabs.
//!
//! The connection is a pipe on macOS and Linux (`pipe.rs`, nothing listens
//! anywhere) and a loopback WebSocket on Windows (`ws.rs`), where handing a
//! child two extra handles is not something the standard library does.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::{oneshot, Mutex};

use super::{pipe, ws};
use crate::domain::types::AppError;

/// How long one command may take. Navigation is waited for separately, so
/// nothing here should come near it.
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

type Pending = Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;
type Writer = Box<dyn AsyncWrite + Send + Unpin>;
type Events = Arc<std::sync::Mutex<Option<UnboundedSender<Value>>>>;

/// How messages are framed on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Framing {
    /// RFC 6455 text frames, client-masked (`ws.rs`).
    WebSocket,
    /// JSON followed by a NUL byte (`pipe.rs`).
    Pipe,
}

#[derive(Clone)]
pub struct CdpClient {
    writer: Arc<Mutex<Writer>>,
    framing: Framing,
    pending: Pending,
    events: Events,
    event_receiver: Arc<std::sync::Mutex<Option<UnboundedReceiver<Value>>>>,
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
        let (reader, writer) = ws::connect(port, path)
            .await
            .map_err(|error| agent_error("browser_connect_failed", error.to_string()))?;
        Ok(Self::over_websocket(reader, writer))
    }

    /// A client over an upgraded WebSocket's two halves.
    pub fn over_websocket<R, W>(reader: R, writer: W) -> Self
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let client = Self::new(Box::new(writer), Framing::WebSocket);
        let (pending, events, open, writer) = client.reader_parts();
        tokio::spawn(async move {
            let mut reader = reader;
            loop {
                match ws::read_message(&mut reader).await {
                    Ok(ws::Incoming::Text(text)) => deliver(&pending, &events, &text),
                    Ok(ws::Incoming::Ping(payload)) => {
                        let mut writer = writer.lock().await;
                        let _ = writer.write_all(&ws::pong_frame(&payload)).await;
                    }
                    Ok(ws::Incoming::Closed) | Err(_) => break,
                }
            }
            closed(&pending, &events, &open);
        });
        client
    }

    /// A client over the browser's debugging pipe: `reader` is its fd 4,
    /// `writer` its fd 3.
    pub fn over_pipe<R, W>(reader: R, writer: W) -> Self
    where
        R: AsyncBufRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let client = Self::new(Box::new(writer), Framing::Pipe);
        let (pending, events, open, _) = client.reader_parts();
        tokio::spawn(async move {
            let mut reader = reader;
            while let Ok(Some(text)) = pipe::read_message(&mut reader).await {
                deliver(&pending, &events, &text);
            }
            closed(&pending, &events, &open);
        });
        client
    }

    fn new(writer: Writer, framing: Framing) -> Self {
        let (sender, receiver) = unbounded_channel();
        Self {
            writer: Arc::new(Mutex::new(writer)),
            framing,
            pending: Arc::new(std::sync::Mutex::new(HashMap::new())),
            events: Arc::new(std::sync::Mutex::new(Some(sender))),
            event_receiver: Arc::new(std::sync::Mutex::new(Some(receiver))),
            next_id: Arc::new(AtomicU64::new(1)),
            open: Arc::new(AtomicBool::new(true)),
        }
    }

    fn reader_parts(&self) -> (Pending, Events, Arc<AtomicBool>, Arc<Mutex<Writer>>) {
        (
            self.pending.clone(),
            self.events.clone(),
            self.open.clone(),
            self.writer.clone(),
        )
    }

    /// The browser's events, once: the consent gate is their only reader.
    pub fn take_events(&self) -> Option<UnboundedReceiver<Value>> {
        self.event_receiver
            .lock()
            .ok()
            .and_then(|mut slot| slot.take())
    }

    pub fn framing(&self) -> Framing {
        self.framing
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
            let text = message.to_string();
            let sent = match self.framing {
                Framing::WebSocket => ws::send_text(&mut *writer, &text).await,
                Framing::Pipe => pipe::send_text(&mut *writer, &text).await,
            };
            if let Err(error) = sent {
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
        let _ = match self.framing {
            Framing::WebSocket => ws::send_close(&mut *writer).await,
            Framing::Pipe => writer.shutdown().await,
        };
    }
}

/// The reader stopped: whoever is still waiting learns the browser is gone
/// now rather than after the timeout, and the gate's channel ends.
fn closed(pending: &Pending, events: &Events, open: &AtomicBool) {
    open.store(false, Ordering::SeqCst);
    let waiting: Vec<_> = pending
        .lock()
        .map(|mut map| map.drain().map(|(_, sender)| sender).collect())
        .unwrap_or_default();
    for sender in waiting {
        let _ = sender.send(Err("The browser closed.".to_string()));
    }
    if let Ok(mut events) = events.lock() {
        events.take();
    }
}

/// Routes one incoming message: an answer to the command waiting for it, an
/// event (no id) to the gate.
fn deliver(pending: &Pending, events: &Events, text: &str) {
    let Ok(message) = serde_json::from_str::<Value>(text) else {
        return;
    };
    let Some(id) = message.get("id").and_then(Value::as_u64) else {
        if message.get("method").is_some() {
            if let Some(sender) = events.lock().ok().as_ref().and_then(|slot| slot.as_ref()) {
                let _ = sender.send(message);
            }
        }
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

/// The tab the agent drives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attached {
    /// Also the id of the tab's main frame, which is how the gate tells a
    /// page's own document from one in a frame inside it.
    pub target_id: String,
    pub session_id: String,
}

/// Picks the tab to drive: the first page target, or a new blank one.
pub async fn attach_to_page(client: &CdpClient) -> Result<Attached, AppError> {
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
    Ok(Attached {
        target_id,
        session_id,
    })
}
