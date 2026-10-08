//! The phone's half of asking from the Apple Watch (ADR-0095).
//!
//! The watch app (`gen/apple/Watch`) takes a question by dictation and sends
//! it over WatchConnectivity. The watch cannot run a turn: it has no key, no
//! sidecar and no notes. The phone does, so the question becomes an ordinary
//! agent-lite chat here, and the answer goes back to the wrist as plain text.
//!
//! The Swift side (`Sources/os-june/Watch/WatchBridge.swift`) owns the
//! `WCSession`; it hands each message to [`on_message`] through a C function
//! pointer registered at setup, and sends what [`send`] gives it back. iOS
//! wakes the app in the background for a watch message, so all of this runs
//! without the webview.
//!
//! Durable rows, never a long-lived task (ADR-0018): the question is a chat
//! row the resume sweep finishes if the phone suspends mid-turn, and the
//! promise of an answer is a `watch-requests/<id>.json` file, removed once the
//! answer is handed to WatchConnectivity (which queues it for the watch if
//! the watch is out of reach). [`deliver_pending`] runs in the background
//! sweep, after the chat resume, so a turn finished on a later launch still
//! reaches the wrist.
//!
//! Only the bridge is iOS; the message rules are plain Rust, tested on every
//! platform.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::domain::types::{AgentMessageRole, AgentTaskStatus};

const REQUESTS_DIR: &str = "watch-requests";
const MAX_MESSAGE_BYTES: usize = 16 * 1024;
const MAX_QUESTION_CHARS: usize = 2_000;
/// A wrist reads a paragraph or two; the whole answer stays in the chat.
const MAX_ANSWER_CHARS: usize = 4_000;
/// An answer still owed after a day is not one anybody is waiting for.
const GIVE_UP_AFTER_HOURS: i64 = 24;

#[derive(Debug, Deserialize)]
struct Incoming {
    v: u32,
    kind: String,
    id: String,
    question: String,
}

/// A question from the watch, validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchQuestion {
    pub id: String,
    pub question: String,
}

/// Reads one message from the watch. `None` for anything else: the watch app
/// is ours, but the channel is not the place to guess.
pub fn parse_question(bytes: &[u8]) -> Option<WatchQuestion> {
    if bytes.len() > MAX_MESSAGE_BYTES {
        return None;
    }
    let incoming: Incoming = serde_json::from_slice(bytes).ok()?;
    if incoming.v != 1 || incoming.kind != "ask" {
        return None;
    }
    if !crate::share_inbox::valid_item_id(&incoming.id) {
        return None;
    }
    let question = incoming.question.trim();
    if question.is_empty() {
        return None;
    }
    Some(WatchQuestion {
        id: incoming.id.to_ascii_lowercase(),
        question: question.chars().take(MAX_QUESTION_CHARS).collect(),
    })
}

/// The durable promise of an answer: which chat answers which question.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PendingAnswer {
    id: String,
    task_id: String,
    created_at: String,
}

/// What goes back to the watch. The watch says the failure in its own words.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatchReply {
    pub v: u32,
    pub kind: &'static str,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub failed: bool,
}

impl WatchReply {
    fn answer(id: &str, text: String) -> Self {
        Self {
            v: 1,
            kind: "answer",
            id: id.to_string(),
            answer: Some(text),
            failed: false,
        }
    }

    fn failed(id: &str) -> Self {
        Self {
            v: 1,
            kind: "answer",
            id: id.to_string(),
            answer: None,
            failed: true,
        }
    }
}

/// The answer as a wrist can show and a voice can read it: the chat's cards
/// (`subrosa:*` blocks: links, places, notes) are for the phone's screen and
/// are left out, the rest is kept as written.
pub fn plain_answer(markdown: &str) -> String {
    let mut kept = Vec::new();
    let mut skipping = false;
    for line in markdown.lines() {
        let fence = line.trim_start();
        if skipping {
            if fence.starts_with("```") {
                skipping = false;
            }
            continue;
        }
        if fence
            .strip_prefix("```")
            .is_some_and(|info| info.trim_start().starts_with("subrosa:"))
        {
            skipping = true;
            continue;
        }
        kept.push(line);
    }
    let mut text = String::new();
    let mut blank_run = 0;
    for line in kept {
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        text.push_str(line);
        text.push('\n');
    }
    let text = text.trim();
    if text.chars().count() > MAX_ANSWER_CHARS {
        let cut: String = text.chars().take(MAX_ANSWER_CHARS).collect();
        format!("{}...", cut.trim_end())
    } else {
        text.to_string()
    }
}

/// Where a chat stands, for the watch.
fn reply_for(id: &str, task: &crate::domain::types::AgentTaskDto) -> Option<WatchReply> {
    match task.status {
        AgentTaskStatus::Completed => {
            let answer = task
                .messages
                .iter()
                .rev()
                .find(|message| message.role == AgentMessageRole::Assistant)
                .map(|message| plain_answer(&message.content))
                .filter(|text| !text.is_empty());
            Some(match answer {
                Some(text) => WatchReply::answer(id, text),
                None => WatchReply::failed(id),
            })
        }
        AgentTaskStatus::Failed | AgentTaskStatus::Cancelled => Some(WatchReply::failed(id)),
        _ => None,
    }
}

fn expired(created_at: &str, now: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(created_at)
        .map(|created| (now - created.with_timezone(&Utc)).num_hours() >= GIVE_UP_AFTER_HOURS)
        .unwrap_or(true)
}

fn requests_dir(app: &AppHandle) -> Option<PathBuf> {
    crate::app_paths::app_data_dir(app)
        .ok()
        .map(|dir| dir.join(REQUESTS_DIR))
}

fn write_pending(dir: &Path, pending: &PendingAnswer) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let bytes = serde_json::to_vec(pending).map_err(std::io::Error::other)?;
    let staging = dir.join(format!("{}.json.part", pending.id));
    std::fs::write(&staging, bytes)?;
    std::fs::rename(staging, dir.join(format!("{}.json", pending.id)))
}

fn read_pending(path: &Path) -> Option<PendingAnswer> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Take one question: file the chat and the promise, run the turn, answer.
/// A question the phone already took (the watch sent it twice) is answered
/// from the chat it already has, never asked again.
pub async fn accept(app: &AppHandle, question: WatchQuestion) {
    let Some(dir) = requests_dir(app) else {
        return;
    };
    let path = dir.join(format!("{}.json", question.id));
    if path.exists() {
        deliver_one(app, &path).await;
        return;
    }
    let Ok(repos) = crate::commands::repositories(app).await else {
        let _ = send(&WatchReply::failed(&question.id));
        return;
    };
    let task = match repos
        .create_agent_task(&question.question, None, Default::default(), None)
        .await
    {
        Ok(task) => task,
        Err(error) => {
            tracing::warn!("watch question could not be filed: {error}");
            let _ = send(&WatchReply::failed(&question.id));
            return;
        }
    };
    let pending = PendingAnswer {
        id: question.id.clone(),
        task_id: task.id.clone(),
        created_at: Utc::now().to_rfc3339(),
    };
    if let Err(error) = write_pending(&dir, &pending) {
        // The chat is filed and will be answered there; only the wrist misses
        // out if the phone suspends before the turn ends.
        tracing::warn!("watch request row could not be written: {error}");
    }
    if let Some(claim) = crate::agent_lite::TurnClaim::try_hold(&task.id) {
        let request = crate::agent_lite::AgentLiteRunRequest {
            task_id: task.id.clone(),
            model: None,
            attachments: None,
            reasoning_effort: None,
        };
        let _ = crate::agent_lite::run_claimed(app.clone(), request, claim).await;
    }
    if path.exists() {
        deliver_one(app, &path).await;
    } else if let Ok(task) = repos.get_agent_task(&task.id).await {
        if let Some(reply) = reply_for(&question.id, &task) {
            let _ = send(&reply);
        }
    }
}

/// Hands one owed answer to the watch when its chat has one, and forgets the
/// promise once it is handed over (or once nobody is waiting any more).
async fn deliver_one(app: &AppHandle, path: &Path) {
    let Some(pending) = read_pending(path) else {
        let _ = std::fs::remove_file(path);
        return;
    };
    let Ok(repos) = crate::commands::repositories(app).await else {
        return;
    };
    let reply = match repos.get_agent_task(&pending.task_id).await {
        Ok(task) => reply_for(&pending.id, &task),
        // The chat was deleted on the phone: the question has no answer.
        Err(_) => Some(WatchReply::failed(&pending.id)),
    };
    let give_up = expired(&pending.created_at, Utc::now());
    match reply {
        Some(reply) => {
            if send(&reply) || give_up {
                let _ = std::fs::remove_file(path);
            }
        }
        None if give_up => {
            let _ = send(&WatchReply::failed(&pending.id));
            let _ = std::fs::remove_file(path);
        }
        // Still being answered, by this process or by the resume sweep.
        None => {}
    }
}

/// Every answer still owed to the watch. Part of [`crate::background::sweep`],
/// after the chat resume.
pub async fn deliver_pending(app: &AppHandle) {
    let Some(dir) = requests_dir(app) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let paths: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    for path in paths {
        deliver_one(app, &path).await;
    }
}

/// Starts listening to the watch. iOS only; a no-op elsewhere.
pub fn setup(app: &AppHandle) {
    #[cfg(target_os = "ios")]
    bridge::start(app);
    #[cfg(not(target_os = "ios"))]
    let _ = app;
}

/// Hands a reply to WatchConnectivity. `false` when there is no watch to
/// hand it to (no pairing, no watch app, or not iOS).
fn send(reply: &WatchReply) -> bool {
    let Ok(json) = serde_json::to_string(reply) else {
        return false;
    };
    #[cfg(target_os = "ios")]
    {
        bridge::deliver(&json)
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = json;
        false
    }
}

#[cfg(target_os = "ios")]
mod bridge {
    use std::ffi::{c_char, CStr};
    use std::sync::OnceLock;

    use objc2::msg_send;
    use objc2::runtime::AnyClass;
    use objc2_foundation::NSString;
    use tauri::AppHandle;

    static APP: OnceLock<AppHandle> = OnceLock::new();

    /// Called by `WatchBridge.swift` on WatchConnectivity's queue, with the
    /// message as JSON. Copies it and returns at once.
    extern "C" fn on_message(json: *const c_char) {
        if json.is_null() {
            return;
        }
        // SAFETY: the Swift side passes a NUL-terminated string that lives
        // for the duration of this call; it is copied before returning.
        let bytes = unsafe { CStr::from_ptr(json) }.to_bytes().to_vec();
        let (Some(app), Some(question)) = (APP.get().cloned(), super::parse_question(&bytes))
        else {
            return;
        };
        tauri::async_runtime::spawn(async move {
            super::accept(&app, question).await;
        });
    }

    fn bridge_class() -> Option<&'static AnyClass> {
        AnyClass::get(c"SubRosaWatchBridge")
    }

    pub fn start(app: &AppHandle) {
        let _ = APP.set(app.clone());
        let Some(class) = bridge_class() else {
            tracing::warn!("watch bridge class missing; the watch cannot ask");
            return;
        };
        let handler: extern "C" fn(*const c_char) = on_message;
        // SAFETY: `+startWithHandler:` takes a C function pointer and keeps
        // it for the life of the process; `on_message` is a plain function.
        unsafe {
            let _: () = msg_send![class, startWithHandler: handler];
        }
    }

    pub fn deliver(json: &str) -> bool {
        let Some(class) = bridge_class() else {
            return false;
        };
        let payload = NSString::from_str(json);
        // SAFETY: `+deliver:` takes an NSString and answers a BOOL.
        unsafe { msg_send![class, deliver: &*payload] }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::types::{AgentMessageDto, AgentTaskDto};

    #[test]
    fn reads_a_question_and_nothing_else() {
        let ok = br#"{"v":1,"kind":"ask","id":"3F2C1A9E-AA10-4B6E-9D1C-0F1E2D3C4B5A","question":"  what is on today  "}"#;
        let question = parse_question(ok).unwrap();
        assert_eq!(question.id, "3f2c1a9e-aa10-4b6e-9d1c-0f1e2d3c4b5a");
        assert_eq!(question.question, "what is on today");

        assert!(parse_question(br#"{"v":2,"kind":"ask","id":"a","question":"x"}"#).is_none());
        assert!(parse_question(br#"{"v":1,"kind":"send","id":"a","question":"x"}"#).is_none());
        assert!(parse_question(br#"{"v":1,"kind":"ask","id":"../a","question":"x"}"#).is_none());
        assert!(parse_question(br#"{"v":1,"kind":"ask","id":"a","question":"   "}"#).is_none());
        assert!(parse_question(b"not json").is_none());
        let long = format!(
            r#"{{"v":1,"kind":"ask","id":"a","question":"{}"}}"#,
            "q".repeat(5_000)
        );
        assert_eq!(
            parse_question(long.as_bytes())
                .unwrap()
                .question
                .chars()
                .count(),
            MAX_QUESTION_CHARS
        );
        let huge = format!(
            r#"{{"v":1,"kind":"ask","id":"a","question":"{}"}}"#,
            "q".repeat(MAX_MESSAGE_BYTES)
        );
        assert!(parse_question(huge.as_bytes()).is_none());
    }

    #[test]
    fn the_wrist_gets_the_prose_without_the_cards() {
        let answer = "You meet Ana at 10.\n\n```subrosa:places\n{\"v\":1}\n```\n\n\n\nThen lunch.\n```rust\nfn main() {}\n```";
        assert_eq!(
            plain_answer(answer),
            "You meet Ana at 10.\n\nThen lunch.\n```rust\nfn main() {}\n```"
        );
        let long = "word ".repeat(2_000);
        let cut = plain_answer(&long);
        assert!(cut.ends_with("..."));
        assert!(cut.chars().count() <= MAX_ANSWER_CHARS + 3);
    }

    fn task(status: AgentTaskStatus, messages: &[(AgentMessageRole, &str)]) -> AgentTaskDto {
        let mut task: AgentTaskDto = serde_json::from_value(serde_json::json!({
            "id": "t", "title": "t", "prompt": "q", "status": "queued",
            "safetyProfile": "autonomousPrivate", "progressSummary": "", "createdAt": "", "updatedAt": "",
            "messages": [], "toolEvents": []
        }))
        .unwrap();
        task.status = status;
        task.messages = messages
            .iter()
            .map(|(role, content)| AgentMessageDto {
                id: "m".into(),
                task_id: "t".into(),
                role: *role,
                content: (*content).into(),
                created_at: String::new(),
            })
            .collect();
        task
    }

    #[test]
    fn answers_only_a_finished_chat() {
        let running = task(AgentTaskStatus::Running, &[(AgentMessageRole::User, "q")]);
        assert!(reply_for("id", &running).is_none());
        let done = task(
            AgentTaskStatus::Completed,
            &[
                (AgentMessageRole::User, "q"),
                (AgentMessageRole::Assistant, "It is sunny."),
            ],
        );
        assert_eq!(
            reply_for("id", &done),
            Some(WatchReply::answer("id", "It is sunny.".into()))
        );
        let failed = task(AgentTaskStatus::Failed, &[(AgentMessageRole::User, "q")]);
        assert_eq!(reply_for("id", &failed), Some(WatchReply::failed("id")));
        let json = serde_json::to_string(&WatchReply::failed("id")).unwrap();
        assert_eq!(json, r#"{"v":1,"kind":"answer","id":"id","failed":true}"#);
    }

    #[test]
    fn a_promise_is_kept_for_a_day() {
        let now = Utc::now();
        assert!(!expired(
            &(now - chrono::Duration::hours(2)).to_rfc3339(),
            now
        ));
        assert!(expired(
            &(now - chrono::Duration::hours(25)).to_rfc3339(),
            now
        ));
        assert!(expired("garbage", now));
    }

    #[test]
    fn the_promise_survives_as_a_file() {
        let dir = std::env::temp_dir().join(format!("watch-requests-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let pending = PendingAnswer {
            id: "abc".into(),
            task_id: "task".into(),
            created_at: Utc::now().to_rfc3339(),
        };
        write_pending(&dir, &pending).unwrap();
        assert_eq!(read_pending(&dir.join("abc.json")), Some(pending));
        assert!(!dir.join("abc.json.part").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn swift_and_rust_name_the_same_bridge() {
        let swift = include_str!("../gen/apple/Sources/os-june/Watch/WatchBridge.swift");
        assert!(swift.contains("@objc(SubRosaWatchBridge)"));
        assert!(swift.contains("@objc(startWithHandler:)"));
        assert!(swift.contains("@objc(deliver:)"));
        let watch = include_str!("../gen/apple/Watch/WatchSession.swift");
        assert!(watch.contains("\"kind\": \"ask\""));
        assert!(watch.contains("\"failed\""));
    }
}
