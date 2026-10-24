//! The Hermes gateway (`/api/ws`) from Rust: JSON-RPC requests out, event
//! notifications in. The same protocol `src/lib/hermes-gateway.ts` speaks for
//! the webview, over the loopback WebSocket client the browser bridge already
//! uses (`agent_browser::ws`).

use std::{collections::VecDeque, io, sync::Arc, time::Duration};

use serde_json::{json, Value};
use tokio::{
    net::tcp::OwnedWriteHalf,
    sync::{mpsc, Mutex},
    task::JoinHandle,
};

use crate::agent_browser::ws;
use crate::domain::types::AppError;

/// One frame off the socket.
#[derive(Debug, PartialEq)]
pub enum Frame {
    Response {
        id: u64,
        outcome: Result<Value, RpcError>,
    },
    /// The `params` of a `method: "event"` notification: `{type, session_id, payload}`.
    Event(Value),
}

#[derive(Clone, Debug, PartialEq)]
pub struct RpcError {
    pub code: Option<i64>,
    pub message: String,
}

/// Reads one text message. Anything that is not a response to a numeric id
/// or an event notification is ignored, as the webview client does.
#[must_use]
pub fn parse_frame(text: &str) -> Option<Frame> {
    let frame: Value = serde_json::from_str(text).ok()?;
    if let Some(id) = frame.get("id").and_then(Value::as_u64) {
        let outcome = match frame.get("error") {
            Some(error) if !error.is_null() => Err(RpcError {
                code: error.get("code").and_then(Value::as_i64),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("The agent runtime refused the request.")
                    .to_string(),
            }),
            _ => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
        };
        return Some(Frame::Response { id, outcome });
    }
    if frame.get("method").and_then(Value::as_str) == Some("event") {
        let params = frame.get("params")?;
        params.get("type").and_then(Value::as_str)?;
        return Some(Frame::Event(params.clone()));
    }
    None
}

enum Incoming {
    Frame(Frame),
    Closed,
}

pub struct Gateway {
    writer: Arc<Mutex<OwnedWriteHalf>>,
    incoming: mpsc::UnboundedReceiver<Incoming>,
    backlog: VecDeque<Value>,
    next_id: u64,
    reader: JoinHandle<()>,
    closed: bool,
}

impl Gateway {
    /// Connects to `ws://127.0.0.1:{port}{path}`; `path` carries the token.
    pub async fn connect(port: u16, path: &str) -> io::Result<Self> {
        let (mut read, write) = ws::connect(port, path).await?;
        let writer = Arc::new(Mutex::new(write));
        let (sender, incoming) = mpsc::unbounded_channel();
        let pong_writer = writer.clone();
        let reader = tokio::spawn(async move {
            loop {
                match ws::read_message(&mut read).await {
                    Ok(ws::Incoming::Text(text)) => {
                        if let Some(frame) = parse_frame(&text) {
                            if sender.send(Incoming::Frame(frame)).is_err() {
                                return;
                            }
                        }
                    }
                    Ok(ws::Incoming::Ping(payload)) => {
                        use tokio::io::AsyncWriteExt as _;
                        let mut writer = pong_writer.lock().await;
                        let _ = writer.write_all(&ws::pong_frame(&payload)).await;
                    }
                    Ok(ws::Incoming::Closed) | Err(_) => {
                        let _ = sender.send(Incoming::Closed);
                        return;
                    }
                }
            }
        });
        Ok(Self {
            writer,
            incoming,
            backlog: VecDeque::new(),
            next_id: 0,
            reader,
            closed: false,
        })
    }

    /// Sends a request and waits for its answer. Events that arrive in the
    /// meantime are kept, in order, for [`Self::next_event`].
    pub async fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, AppError> {
        self.next_id += 1;
        let id = self.next_id;
        let text =
            json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
        {
            let mut writer = self.writer.lock().await;
            ws::send_text(&mut *writer, &text)
                .await
                .map_err(|error| gateway_error(&format!("{method}: {error}")))?;
        }
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let next = tokio::time::timeout_at(deadline, self.incoming.recv())
                .await
                .map_err(|_| gateway_error(&format!("{method} timed out")))?;
            match next {
                Some(Incoming::Frame(Frame::Response { id: got, outcome })) if got == id => {
                    return outcome.map_err(|error| {
                        AppError::new(
                            "hermes_gateway_refused",
                            match error.code {
                                Some(code) => format!("{method} ({code}): {}", error.message),
                                None => format!("{method}: {}", error.message),
                            },
                        )
                    });
                }
                Some(Incoming::Frame(Frame::Response { .. })) => {}
                Some(Incoming::Frame(Frame::Event(event))) => self.backlog.push_back(event),
                Some(Incoming::Closed) | None => {
                    self.closed = true;
                    return Err(gateway_error("the connection closed"));
                }
            }
        }
    }

    /// The next event, or `None` once the socket is closed.
    pub async fn next_event(&mut self) -> Option<Value> {
        if let Some(event) = self.backlog.pop_front() {
            return Some(event);
        }
        if self.closed {
            return None;
        }
        loop {
            match self.incoming.recv().await {
                Some(Incoming::Frame(Frame::Event(event))) => return Some(event),
                Some(Incoming::Frame(Frame::Response { .. })) => {}
                Some(Incoming::Closed) | None => {
                    self.closed = true;
                    return None;
                }
            }
        }
    }

    pub async fn close(self) {
        {
            let mut writer = self.writer.lock().await;
            let _ = ws::send_close(&mut *writer).await;
        }
        self.reader.abort();
    }
}

fn gateway_error(detail: &str) -> AppError {
    AppError::new(
        "hermes_gateway_failed",
        format!("The agent runtime's gateway failed: {detail}."),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_and_events_are_told_apart() {
        assert_eq!(
            parse_frame(r#"{"jsonrpc":"2.0","id":3,"result":{"session_id":"s1"}}"#),
            Some(Frame::Response {
                id: 3,
                outcome: Ok(json!({"session_id": "s1"})),
            })
        );
        assert_eq!(
            parse_frame(
                r#"{"jsonrpc":"2.0","id":4,"error":{"code":4009,"message":"session busy"}}"#
            ),
            Some(Frame::Response {
                id: 4,
                outcome: Err(RpcError {
                    code: Some(4009),
                    message: "session busy".into(),
                }),
            })
        );
        assert_eq!(
            parse_frame(
                r#"{"jsonrpc":"2.0","method":"event","params":{"type":"message.delta","session_id":"s1","payload":{"text":"hi"}}}"#
            ),
            Some(Frame::Event(
                json!({"type": "message.delta", "session_id": "s1", "payload": {"text": "hi"}})
            ))
        );
    }

    #[test]
    fn noise_is_ignored() {
        assert_eq!(parse_frame("not json"), None);
        assert_eq!(parse_frame(r#"{"method":"event","params":{}}"#), None);
        assert_eq!(parse_frame(r#"{"method":"ping"}"#), None);
        assert_eq!(parse_frame(r#"{"id":"abc","result":1}"#), None);
    }
}
