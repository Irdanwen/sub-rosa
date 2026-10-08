//! `run_python` (ADR-0086): data analysis on the phone, in the webview.
//!
//! iOS allows no interpreter process, so Python is Pyodide (CPython compiled
//! to WebAssembly) bundled with the app and run in a Web Worker. The tool
//! loop lives here, in Rust, so a run is a round trip: this side emits
//! [`PYTHON_RUN_EVENT`] with the code and the turn's attached files, the
//! webview answers through [`agent_lite_python_reply`], first "started" (or a
//! refusal), then the outcome. Two clocks bound it: a short one for the first
//! answer, which is how a frozen or absent webview is noticed, and a longer
//! one for the run itself, after which the webview is told to discard the
//! worker.
//!
//! Python runs only while the app is on screen. When it is not, the tool says
//! so and the turn continues without it; nothing is persisted, because the
//! run belongs to the turn and the turn is already the durable row
//! (ADR-0018): a turn a suspension interrupts is re-asked on resume, and the
//! model calls the tool again. Whether a run is pending is an in-process
//! question (the registry below), never a database one.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use super::AgentLiteAttachment;
use crate::domain::types::AppError;

pub(super) const TOOL: &str = "run_python";
pub const PYTHON_RUN_EVENT: &str = "agent-lite://python-run";
pub const PYTHON_CANCEL_EVENT: &str = "agent-lite://python-cancel";

/// The webview answers "started" at once; silence this long means it is not
/// there to run anything (backgrounded, frozen, or a build without Python).
pub(crate) const FIRST_ANSWER: Duration = Duration::from_secs(5);
/// The whole run, including the first load of Pyodide and pandas.
pub(crate) const RUN_LIMIT: Duration = Duration::from_secs(120);
pub(crate) const MAX_CODE_CHARS: usize = 20_000;
/// What the turn's attachments may put in the worker, all files together.
const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_BLOCKS: usize = 4;
pub(crate) const MAX_BLOCK_CHARS: usize = 60_000;
pub(crate) const MAX_STDOUT_CHARS: usize = 8_000;

/// Said to the model, which passes it on in its own words.
const NEEDS_APP_OPEN: &str = "Analysis needs the app open: Python runs on this phone only while Sub Rosa is on screen, and it is not right now. Do not retry in this turn. Answer from what you have, and tell the user to keep the app open and ask again for the computed result.";

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PythonOutcome {
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub blocks: Vec<PythonBlock>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PythonBlock {
    pub kind: String,
    pub json: String,
}

/// The webview's answers, in order: `started` or `refused`, then `done`.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PythonReply {
    Started,
    Done(PythonOutcome),
    Refused {
        reason: String,
        #[serde(default)]
        detail: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PythonFile {
    pub name: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonRunEvent {
    pub request_id: String,
    pub session: String,
    pub code: String,
    pub files: Vec<PythonFile>,
}

#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Done(PythonOutcome),
    NeedsApp,
    Unavailable(Option<String>),
    TimedOut,
    Stopped,
}

type Pending = HashMap<String, mpsc::UnboundedSender<PythonReply>>;
static PENDING: LazyLock<Mutex<Pending>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn pending() -> MutexGuard<'static, Pending> {
    PENDING.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// Removes the run from the registry however the wait ends, so a late
/// answer from the webview finds nobody and is dropped.
struct Registration(String);

impl Drop for Registration {
    fn drop(&mut self) {
        pending().remove(&self.0);
    }
}

/// Hands one webview answer to the run waiting for it. False when no run
/// with that id is waiting any more (it timed out, or the turn ended).
fn deliver(request_id: &str, reply: PythonReply) -> bool {
    pending()
        .get(request_id)
        .is_some_and(|sender| sender.send(reply).is_ok())
}

#[tauri::command]
pub fn agent_lite_python_reply(request_id: String, reply: PythonReply) -> Result<(), AppError> {
    if !deliver(&request_id, reply) {
        tracing::debug!("python reply for a run nobody waits on");
    }
    Ok(())
}

pub(crate) fn definition() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": TOOL,
            "description": "Run Python 3 on the user's phone, with numpy and pandas and the standard library (no other packages, no network). Use it for any computation over data: totals, averages, grouping, pivots, statistics, or reading the CSV and spreadsheet files attached to this message, which are mounted in /data (a spreadsheet as one CSV per sheet, name.sheet1.csv). Returns print() output and the value of the last line. subrosa_chart(type, data=df, x=\"col\", y=[\"col\"], title=..., unit=...) and subrosa_table(df, title=...) turn a result into a card whose fenced block the result returns. Variables persist between runs in this conversation while the app stays on screen; if a name is gone, rebuild it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": { "type": "string", "description": "The Python code to run." },
                    "files": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Names of attached files to mount. Omit to mount every file attached to this message."
                    }
                },
                "required": ["code"]
            }
        }
    })
}

/// Offered on the phones only: the desktop's agent has its own Python.
pub(super) fn offer_tool(tools: &mut Vec<serde_json::Value>) {
    if cfg!(mobile) {
        tools.push(definition());
    }
}

/// The run request, or the sentence that tells the model why there is none.
fn build_request(
    task_id: &str,
    args: &serde_json::Value,
    attachments: &[AgentLiteAttachment],
) -> Result<PythonRunEvent, String> {
    let code = args
        .get("code")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if code.trim().is_empty() {
        return Err("run_python needs Python code in `code`.".to_string());
    }
    if code.chars().count() > MAX_CODE_CHARS {
        return Err(format!(
            "The code is too long to run ({MAX_CODE_CHARS} characters at most). Split it into smaller runs; variables persist between them."
        ));
    }
    let wanted: Option<Vec<&str>> = args
        .get("files")
        .and_then(serde_json::Value::as_array)
        .map(|names| names.iter().filter_map(serde_json::Value::as_str).collect());
    let mut files = Vec::new();
    let mut total = 0usize;
    for attachment in attachments.iter().filter(|entry| entry.kind == "text") {
        if wanted
            .as_ref()
            .is_some_and(|names| !names.contains(&attachment.name.as_str()))
        {
            continue;
        }
        total += attachment.data.len();
        if total > MAX_FILE_BYTES {
            return Err("The attached files are too large to analyse on the phone (4 MB at most, all together).".to_string());
        }
        files.push(PythonFile {
            name: attachment.name.clone(),
            text: attachment.data.clone(),
        });
    }
    Ok(PythonRunEvent {
        request_id: uuid::Uuid::new_v4().to_string(),
        session: task_id.to_string(),
        code: code.to_string(),
        files,
    })
}

/// Emits the run and waits for its outcome under both clocks.
async fn run(
    request: PythonRunEvent,
    (first_answer, limit): (Duration, Duration),
    emit: impl Fn(&PythonRunEvent) -> bool,
    cancel: impl Fn(&str),
) -> Outcome {
    let (sender, mut answers) = mpsc::unbounded_channel();
    pending().insert(request.request_id.clone(), sender);
    let _registration = Registration(request.request_id.clone());
    if !emit(&request) {
        return Outcome::NeedsApp;
    }
    match tokio::time::timeout(first_answer, answers.recv()).await {
        Err(_) | Ok(None) => {
            cancel(&request.request_id);
            return Outcome::NeedsApp;
        }
        Ok(Some(PythonReply::Started)) => {}
        Ok(Some(reply)) => return settled(reply),
    }
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        match tokio::time::timeout_at(deadline, answers.recv()).await {
            Err(_) => {
                cancel(&request.request_id);
                return Outcome::TimedOut;
            }
            Ok(None) => return Outcome::NeedsApp,
            Ok(Some(PythonReply::Started)) => continue,
            Ok(Some(reply)) => return settled(reply),
        }
    }
}

fn settled(reply: PythonReply) -> Outcome {
    match reply {
        PythonReply::Done(outcome) => Outcome::Done(outcome),
        PythonReply::Refused { reason, .. } if reason == "background" => Outcome::NeedsApp,
        PythonReply::Refused { detail, .. } => Outcome::Unavailable(detail),
        PythonReply::Started => Outcome::NeedsApp,
    }
}

fn clip(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let kept: String = text.chars().take(limit).collect();
    format!("{kept}\n[truncated]")
}

/// The tool result the model reads.
fn describe(outcome: Outcome) -> String {
    let outcome = match outcome {
        Outcome::Done(outcome) => outcome,
        Outcome::NeedsApp => return NEEDS_APP_OPEN.to_string(),
        Outcome::Unavailable(detail) => {
            return format!(
                "Python is not available on this phone right now{}. Answer without running code, and say the figures were not computed.",
                detail.map(|detail| format!(" ({detail})")).unwrap_or_default()
            )
        }
        Outcome::TimedOut => {
            return format!(
                "The analysis was stopped after {} seconds. Try a smaller computation, or work on part of the data.",
                RUN_LIMIT.as_secs()
            )
        }
        Outcome::Stopped => return "The user stopped the reply.".to_string(),
    };
    let mut parts = Vec::new();
    if !outcome.files.is_empty() {
        parts.push(format!("Files: {}", outcome.files.join(", ")));
    }
    if !outcome.stdout.trim().is_empty() {
        parts.push(format!(
            "Output:\n{}",
            clip(outcome.stdout.trim_end(), MAX_STDOUT_CHARS)
        ));
    }
    if let Some(result) = outcome.result.filter(|result| !result.trim().is_empty()) {
        parts.push(format!("Result:\n{result}"));
    }
    if let Some(error) = outcome.error {
        parts.push(format!("Error:\n{error}"));
    }
    let blocks: Vec<String> = outcome
        .blocks
        .iter()
        .filter(|block| {
            matches!(block.kind.as_str(), "chart" | "table") && block.json.len() <= MAX_BLOCK_CHARS
        })
        .take(MAX_BLOCKS)
        .map(|block| format!("```subrosa:{}\n{}\n```", block.kind, block.json))
        .collect();
    if !blocks.is_empty() {
        parts.push(format!(
            "Cards (copy each block verbatim into your answer where it belongs):\n{}",
            blocks.join("\n")
        ));
    }
    if parts.is_empty() {
        "The code ran and printed nothing. End it with an expression, or print() what you need."
            .to_string()
    } else {
        parts.join("\n\n")
    }
}

pub(super) async fn run_tool(
    app: &AppHandle,
    task_id: &str,
    args: &serde_json::Value,
    attachments: &[AgentLiteAttachment],
) -> String {
    super::emit_status(app, task_id, "analysing-data", None);
    let request = match build_request(task_id, args, attachments) {
        Ok(request) => request,
        Err(message) => return message,
    };
    let request_id = request.request_id.clone();
    let cancel = |id: &str| {
        let _ = app.emit(PYTHON_CANCEL_EVENT, serde_json::json!({ "requestId": id }));
    };
    let stop = super::cancel::signal(task_id);
    let outcome = super::cancel::unless_stopped(
        &stop,
        run(
            request,
            (FIRST_ANSWER, RUN_LIMIT),
            |event| app.emit(PYTHON_RUN_EVENT, event).is_ok(),
            cancel,
        ),
    )
    .await
    .unwrap_or_else(|| {
        cancel(&request_id);
        Outcome::Stopped
    });
    describe(outcome)
}

/// The default chat prompt's section: the card shapes everywhere, and the
/// tool's guidance where the tool is offered.
pub(super) fn prompt_section() -> String {
    let cards = crate::data_cards::CARDS_PROMPT;
    if cfg!(mobile) {
        format!(
            "\n\n{cards}\n\n{}",
            crate::data_cards::PHONE_ANALYSIS_PROMPT
        )
    } else {
        format!("\n\n{cards}")
    }
}

#[cfg(debug_assertions)]
#[path = "python_selftest.rs"]
pub mod selftest;

#[cfg(test)]
#[path = "python_tests.rs"]
mod tests;
