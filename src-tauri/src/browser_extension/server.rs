//! The app's end of the socket (ADR-0100): accepts the relay, reads frames,
//! and performs what `session` decided.
//!
//! A question becomes an agent-lite chat turn, the same Rust tool loop the
//! phone and custom assistants run, so it needs neither the webview nor a
//! Hermes session, and the chat is in the app's list like any other. The
//! answer is streamed back from agent-lite's own events. A connection that
//! closes mid-answer does not stop the turn: the answer lands in the chat.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Listener};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

use super::protocol::{
    clip_bytes, domain_of, read_frame, write_frame, Page, Response, MAX_INCOMING_FRAME,
    MAX_OUTGOING_TEXT_BYTES,
};
use super::session::{Action, AskJob, Session};
use crate::agent_lite::{
    AgentLiteAttachment, AgentLiteRunRequest, TurnClaim, AGENT_LITE_DELTA_EVENT,
    AGENT_LITE_STATUS_EVENT,
};
use crate::domain::types::{AgentMessageRole, AgentTaskRequest, AppError};

static LISTENING: AtomicBool = AtomicBool::new(false);

pub fn is_listening() -> bool {
    LISTENING.load(Ordering::SeqCst)
}

/// Starts accepting relays, once per process.
pub fn ensure_listening(app: &AppHandle) {
    if LISTENING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = listen(app).await {
            tracing::warn!("browser extension endpoint stopped: {error}");
            LISTENING.store(false, Ordering::SeqCst);
        }
    });
}

#[cfg(unix)]
async fn listen(app: AppHandle) -> std::io::Result<()> {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
    let path = super::endpoint::socket_path().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the socket path is too long for this system",
        )
    })?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if path.exists() {
        // Another copy of the app (a dev build next to a release) owns it.
        if tokio::net::UnixStream::connect(&path).await.is_ok() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                "another Sub Rosa is answering the browser",
            ));
        }
        let _ = std::fs::remove_file(&path);
    }
    let listener = tokio::net::UnixListener::bind(&path)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    let owner = std::fs::metadata(&path)?.uid();
    loop {
        let (stream, _) = listener.accept().await?;
        // Only this user's processes: the browser it started runs as them.
        if stream.peer_cred().map(|cred| cred.uid()).ok() != Some(owner) {
            continue;
        }
        let (read, write) = stream.into_split();
        tauri::async_runtime::spawn(serve(app.clone(), read, write));
    }
}

#[cfg(windows)]
async fn listen(app: AppHandle) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let name = super::endpoint::pipe_name();
    // The first instance fails if someone else already holds the name.
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(&name)?;
    loop {
        server.connect().await?;
        let connected = server;
        server = ServerOptions::new()
            .reject_remote_clients(true)
            .create(&name)?;
        let (read, write) = tokio::io::split(connected);
        tauri::async_runtime::spawn(serve(app.clone(), read, write));
    }
}

#[cfg(not(any(unix, windows)))]
async fn listen(_app: AppHandle) -> std::io::Result<()> {
    Err(std::io::Error::other("unsupported platform"))
}

type Sink = UnboundedSender<Response>;

/// One relay, one browser port, until either closes.
async fn serve<R, W>(app: AppHandle, reader: R, writer: W)
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let mut session = Session::default();
    serve_frames(reader, writer, move |frame, sink| {
        let decision = super::decide(&app, &mut session, frame);
        perform(&app, sink, decision.action);
    })
    .await;
}

/// The framing loop, apart from what a frame means: replies are written in
/// the order they are sent, by one writer, while `on_frame` keeps reading.
async fn serve_frames<R, W, F>(mut reader: R, writer: W, mut on_frame: F)
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
    F: FnMut(&[u8], &Sink),
{
    let (sink, mut outgoing) = unbounded_channel::<Response>();
    let writing = tauri::async_runtime::spawn(async move {
        let mut writer = writer;
        while let Some(response) = outgoing.recv().await {
            if write_frame(&mut writer, &response.to_bytes())
                .await
                .is_err()
            {
                break;
            }
        }
    });
    loop {
        match read_frame(&mut reader, MAX_INCOMING_FRAME).await {
            Ok(Some(frame)) => on_frame(&frame, &sink),
            Ok(None) => break,
            Err(_) => {
                let _ = sink.send(Response::error(
                    None,
                    "malformed",
                    "Sub Rosa did not understand that request.",
                ));
                break;
            }
        }
    }
    // Work still running holds its own sender and finishes writing first.
    drop(sink);
    let _ = writing.await;
}

fn perform(app: &AppHandle, sink: &Sink, action: Action) {
    let app = app.clone();
    let sink = sink.clone();
    match action {
        Action::Accept => {}
        Action::Reply(response) => {
            let _ = sink.send(response);
        }
        Action::Ask(job) => {
            tauri::async_runtime::spawn(async move {
                let id = job.id.clone();
                if let Err(error) = ask(&app, &sink, job).await {
                    let _ = sink.send(Response::error(Some(&id), &error.code, &error.message));
                }
            });
        }
        Action::AddToNote { id, title, body } => {
            tauri::async_runtime::spawn(async move {
                let response = match crate::agent_notes::create(&app, Some(&title), &body).await {
                    Ok(note) => Response::Saved {
                        id,
                        kind: "note".into(),
                        item_id: note.id,
                        title: note.title,
                    },
                    Err(error) => Response::error(Some(&id), &error.code, &error.message),
                };
                let _ = sink.send(response);
            });
        }
        Action::SaveLink { id, page } => {
            tauri::async_runtime::spawn(async move {
                let response = match save_link(&app, &page).await {
                    Ok(item) => Response::Saved {
                        id,
                        kind: "link".into(),
                        item_id: item.id,
                        title: item.title,
                    },
                    Err(error) => Response::error(Some(&id), &error.code, &error.message),
                };
                let _ = sink.send(response);
            });
        }
        Action::Cancel {
            id,
            conversation_id,
        } => {
            tauri::async_runtime::spawn(async move {
                let request = AgentTaskRequest {
                    task_id: conversation_id,
                };
                // The stopped turn ends its own stream with what it had shown.
                if let Err(error) = crate::agent_lite::cancel::agent_lite_cancel(app, request).await
                {
                    let _ = sink.send(Response::error(Some(&id), &error.code, &error.message));
                }
            });
        }
    }
}

/// A link kept in the Library exactly as one kept from a chat's link card
/// (ADR-0088): same kind, same key, same payload.
async fn save_link(
    app: &AppHandle,
    page: &Page,
) -> Result<crate::saved_items::SavedItemDto, AppError> {
    let request = crate::saved_items::SaveItemRequest {
        kind: "link".into(),
        source_key: format!("link:{}", page.url),
        title: page.title.clone(),
        payload: serde_json::json!({ "url": page.url, "domain": domain_of(&page.url) }),
        conversation_id: None,
    };
    let repos = crate::commands::repositories(app).await?;
    crate::saved_items::save(&repos.pool, &request).await
}

fn already_running() -> AppError {
    AppError::new(
        "browser_extension_chat_busy",
        "This chat is still answering. Wait for it, then ask again.",
    )
}

/// Files the question as a chat (or adds it to one), runs the turn, and
/// streams it back.
async fn ask(app: &AppHandle, sink: &Sink, job: AskJob) -> Result<(), AppError> {
    let repos = crate::commands::repositories(app).await?;
    let (task_id, claim) = match job.conversation_id {
        Some(task_id) => {
            let task = repos.get_agent_task(&task_id).await?;
            // Claimed before the message is written, so a resume sweep can
            // never start this turn without the page.
            let claim = TurnClaim::try_hold(&task.id).ok_or_else(already_running)?;
            repos
                .add_agent_message(&task.id, AgentMessageRole::User, &job.content)
                .await?;
            (task.id, claim)
        }
        None => {
            let task = repos
                .create_agent_task(&job.content, None, Default::default(), None)
                .await?;
            let claim = TurnClaim::try_hold(&task.id).ok_or_else(already_running)?;
            (task.id, claim)
        }
    };
    let _ = sink.send(Response::Started {
        id: job.id.clone(),
        conversation_id: task_id.clone(),
    });
    let forwarding = Forwarding::start(app, sink, &job.id, &task_id);
    let request = AgentLiteRunRequest {
        task_id: task_id.clone(),
        model: None,
        attachments: job.attachment.map(|(name, data)| {
            vec![AgentLiteAttachment {
                kind: "text".into(),
                name,
                data,
            }]
        }),
        reasoning_effort: None,
    };
    let result = crate::agent_lite::run_claimed(app.clone(), request, claim).await;
    drop(forwarding);
    let task = result?;
    let text = task
        .messages
        .iter()
        .rev()
        .find(|message| message.role == AgentMessageRole::Assistant)
        .map(|message| clip_bytes(&message.content, MAX_OUTGOING_TEXT_BYTES).to_string())
        .unwrap_or_default();
    let _ = sink.send(Response::Done {
        id: job.id,
        conversation_id: task_id,
        text,
    });
    Ok(())
}

/// Agent-lite's stream events for one chat, relayed while it answers.
struct Forwarding {
    app: AppHandle,
    listeners: Vec<tauri::EventId>,
}

impl Forwarding {
    fn start(app: &AppHandle, sink: &Sink, request_id: &str, task_id: &str) -> Self {
        let listeners = [AGENT_LITE_DELTA_EVENT, AGENT_LITE_STATUS_EVENT]
            .into_iter()
            .map(|event| {
                let sink = sink.clone();
                let request_id = request_id.to_string();
                let task_id = task_id.to_string();
                app.listen_any(event, move |payload| {
                    if let Some(response) =
                        event_to_response(event, payload.payload(), &request_id, &task_id)
                    {
                        let _ = sink.send(response);
                    }
                })
            })
            .collect();
        Self {
            app: app.clone(),
            listeners,
        }
    }
}

impl Drop for Forwarding {
    fn drop(&mut self) {
        for id in self.listeners.drain(..) {
            self.app.unlisten(id);
        }
    }
}

/// One agent-lite event as the extension hears it, when it is about this chat.
pub fn event_to_response(
    event: &str,
    payload: &str,
    request_id: &str,
    task_id: &str,
) -> Option<Response> {
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    if value.get("taskId").and_then(serde_json::Value::as_str) != Some(task_id) {
        return None;
    }
    let id = request_id.to_string();
    if event == AGENT_LITE_STATUS_EVENT {
        let stage = value.get("stage")?.as_str()?.to_string();
        return Some(Response::Status { id, stage });
    }
    if let Some(text) = value.get("text").and_then(serde_json::Value::as_str) {
        return Some(Response::Delta {
            id,
            text: text.to_string(),
        });
    }
    let count = value.get("retract")?.as_u64()?;
    Some(Response::Retract {
        id,
        count: usize::try_from(count).ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser_extension::pairing::PairingBook;
    use tokio::io::AsyncWriteExt as _;

    async fn send(stream: &mut tokio::io::DuplexStream, value: serde_json::Value) {
        write_frame(stream, value.to_string().as_bytes())
            .await
            .unwrap();
    }

    async fn receive(stream: &mut tokio::io::DuplexStream) -> serde_json::Value {
        let frame = read_frame(stream, MAX_INCOMING_FRAME)
            .await
            .unwrap()
            .unwrap();
        serde_json::from_slice(&frame).unwrap()
    }

    /// The relay's bytes in, the extension's replies out: origin, pairing,
    /// then a paired hello, through the real framing and the real session.
    #[tokio::test]
    async fn a_connection_pairs_and_is_recognised() {
        let (mut relay, app_side) = tokio::io::duplex(4096);
        let (reader, writer) = tokio::io::split(app_side);
        let mut book = PairingBook::default();
        book.begin("123456".into(), chrono::Utc::now());
        let mut session = Session::default();
        let server = tokio::spawn(serve_frames(reader, writer, move |frame, sink| {
            let decision = session.decide(&mut book, frame, chrono::Utc::now(), "1.2.3", || {
                "tok".to_string()
            });
            if let Action::Reply(response) = decision.action {
                let _ = sink.send(response);
            }
        }));
        send(
            &mut relay,
            serde_json::json!({"type":"origin","origin":"chrome-extension://abc/"}),
        )
        .await;
        send(
            &mut relay,
            serde_json::json!({"v":1,"type":"pair","id":"p","code":"123456"}),
        )
        .await;
        assert_eq!(
            receive(&mut relay).await,
            serde_json::json!({"type":"paired","id":"p","token":"tok"})
        );
        send(
            &mut relay,
            serde_json::json!({"v":1,"type":"hello","id":"h","token":"tok"}),
        )
        .await;
        let hello = receive(&mut relay).await;
        assert_eq!(hello["paired"], true);
        assert_eq!(hello["appVersion"], "1.2.3");
        relay.shutdown().await.unwrap();
        drop(relay);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn an_oversized_frame_is_refused_and_the_connection_closed() {
        let (mut relay, app_side) = tokio::io::duplex(64);
        let (reader, writer) = tokio::io::split(app_side);
        let server = tokio::spawn(serve_frames(reader, writer, |_, _| {}));
        let length = u32::try_from(MAX_INCOMING_FRAME + 1).unwrap();
        relay.write_all(&length.to_ne_bytes()).await.unwrap();
        assert_eq!(receive(&mut relay).await["code"], "malformed");
        server.await.unwrap();
    }

    #[test]
    fn only_this_chats_events_reach_the_extension() {
        let delta = r#"{"taskId":"t1","text":"Hel"}"#;
        assert_eq!(
            event_to_response(AGENT_LITE_DELTA_EVENT, delta, "r", "t1"),
            Some(Response::Delta {
                id: "r".into(),
                text: "Hel".into()
            })
        );
        assert_eq!(
            event_to_response(AGENT_LITE_DELTA_EVENT, delta, "r", "t2"),
            None
        );
        assert_eq!(
            event_to_response(
                AGENT_LITE_DELTA_EVENT,
                r#"{"taskId":"t1","retract":4}"#,
                "r",
                "t1"
            ),
            Some(Response::Retract {
                id: "r".into(),
                count: 4
            })
        );
        assert_eq!(
            event_to_response(
                AGENT_LITE_STATUS_EVENT,
                r#"{"taskId":"t1","stage":"searching-web","detail":"x"}"#,
                "r",
                "t1"
            ),
            Some(Response::Status {
                id: "r".into(),
                stage: "searching-web".into()
            })
        );
        assert_eq!(
            event_to_response(AGENT_LITE_DELTA_EVENT, "nope", "r", "t1"),
            None
        );
    }
}
