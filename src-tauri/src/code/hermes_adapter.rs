//! Hermes gateway frames to code events (ADR-0123).
//!
//! The gateway (`tui_gateway/server.py` in the pinned runtime) sends one
//! `{type, session_id, payload}` object per notification. This adapter reads
//! them defensively, the way `src/lib/hermes-control-plane/event-classifier.ts`
//! does for the chat: every field may be missing, renamed, or of another type
//! after a pin bump, so nothing here trusts a shape. It is pure: frames in,
//! events out, no IO, so the fixtures under `src/lib/hermes-control-plane/`
//! and the recorded run under `src/lib/code/fixtures/` pin its behaviour.
//!
//! What it knows about Hermes v0.19 (3ef6bbd2):
//! - `tool.start` carries `tool_id`, `name` and a short `context` label, never
//!   the arguments; `tool.complete` carries `args`, `result` (JSON-decoded
//!   when it was JSON), `duration_s`, `summary`, `todos` and `inline_diff`.
//! - `patch` returns `{success, diff, files_modified, lint, lsp_diagnostics}`,
//!   `write_file` returns `{bytes_written, lint, lsp_diagnostics}`, `terminal`
//!   returns `{output, exit_code, error}`.
//! - A turn ends on `message.complete` (or `error`); `message.interim` seals
//!   commentary inside the turn.

use std::collections::HashMap;

use serde_json::Value;

use super::event::{
    ApprovalKind, CodeEvent, Diagnostic, DiagnosticSeverity, EditDetail, LineRange, MessageChannel,
    TodoItem, TodoStatus, ToolDetail, ToolKind, TurnStatus,
};

/// The most text one `terminal.output` line carries. A build log can be
/// megabytes; the run's consumer wants the end of it, and the full output
/// stays in the engine's own transcript.
pub const TERMINAL_OUTPUT_MAX_CHARS: usize = 16 * 1024;
/// The most a diff carried on an edit may weigh.
const DIFF_MAX_CHARS: usize = 64 * 1024;
const SUMMARY_MAX_CHARS: usize = 2 * 1024;

/// What the adapter remembers between frames.
#[derive(Debug, Default)]
pub struct HermesAdapter {
    /// Only frames of this runtime session are adapted, once it is known.
    session_id: Option<String>,
    turn_id: Option<String>,
    /// Name of each tool call between its start and its completion, for the
    /// engines that leave it out of the completion.
    open_tools: HashMap<String, String>,
    /// Subagents seen started and not yet completed, each reported as a call
    /// of its own (`subagent:<id>`).
    open_subagents: HashMap<String, ()>,
    anonymous_requests: u64,
}

impl HermesAdapter {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Ignore every frame that names another session from now on.
    pub fn watch_session(&mut self, runtime_session_id: impl Into<String>) {
        self.session_id = Some(runtime_session_id.into());
    }

    /// Opens a turn. The caller submits the prompt right after.
    pub fn begin_turn(&mut self, turn_id: impl Into<String>) -> CodeEvent {
        let turn_id = turn_id.into();
        self.turn_id = Some(turn_id.clone());
        CodeEvent::TurnStarted { turn_id }
    }

    #[must_use]
    pub fn turn_open(&self) -> bool {
        self.turn_id.is_some()
    }

    /// Closes the open turn from outside (an interrupt, a budget stop, a lost
    /// socket). `None` when no turn is open.
    pub fn end_turn(&mut self, status: TurnStatus) -> Option<CodeEvent> {
        self.turn_id
            .take()
            .map(|turn_id| CodeEvent::TurnFinished { turn_id, status })
    }

    /// The events one gateway frame stands for. Frames the contract has no
    /// use for (lifecycle, status, session info) give nothing.
    pub fn adapt(&mut self, frame: &Value) -> Vec<CodeEvent> {
        let kind = frame.get("type").and_then(Value::as_str).unwrap_or("");
        if let (Some(watched), Some(session)) = (
            self.session_id.as_deref(),
            frame.get("session_id").and_then(Value::as_str),
        ) {
            if watched != session {
                return Vec::new();
            }
        }
        let empty = Value::Null;
        let payload = frame.get("payload").unwrap_or(&empty);
        match kind {
            "message.delta" => text_of(payload, &["text", "delta", "message", "content"], false)
                .map(|text| {
                    vec![CodeEvent::MessageDelta {
                        message_id: message_id(payload),
                        channel: MessageChannel::Answer,
                        text,
                    }]
                })
                .unwrap_or_default(),
            // `thinking.delta` is the runtime's spinner line in v0.19 (the
            // `thinking_callback`: "(¬_¬) synthesizing...", then empty to
            // clear it), not the model's reasoning, which is `reasoning.delta`.
            "reasoning.delta" => text_of(payload, &["text", "delta", "message", "content"], false)
                .map(|text| {
                    vec![CodeEvent::MessageDelta {
                        message_id: message_id(payload),
                        channel: MessageChannel::Reasoning,
                        text,
                    }]
                })
                .unwrap_or_default(),
            "message.interim" => text_of(payload, &["text", "message", "content", "delta"], false)
                .map(|text| {
                    vec![CodeEvent::MessageCompleted {
                        message_id: message_id(payload),
                        text,
                        interim: true,
                    }]
                })
                .unwrap_or_default(),
            "message.complete" | "message.completed" => self.complete_message(payload),
            "tool.start" => self.tool_start(payload),
            "tool.progress" => tool_progress(payload),
            "tool.complete" => self.tool_complete(payload),
            "approval.request" => vec![self.approval(ApprovalKind::Command, payload)],
            "clarify.request" => vec![self.approval(ApprovalKind::Clarify, payload)],
            "sudo.request" => vec![self.approval(ApprovalKind::Sudo, payload)],
            "secret.request" => vec![self.approval(ApprovalKind::Secret, payload)],
            "error" => {
                let recoverable = payload
                    .get("recoverable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let mut events = vec![CodeEvent::Error {
                    // Only the message: a provider error can carry a bearer
                    // or a key in its other fields.
                    message: text_of(payload, &["message", "text"], true)
                        .unwrap_or_else(|| "The agent reported an error.".to_string()),
                    code: payload.get("code").and_then(scalar_string),
                    recoverable,
                }];
                // A recoverable error is reported and the turn goes on: the
                // runtime retries or works around it, and its own
                // `message.complete` closes the turn.
                if !recoverable {
                    events.extend(self.end_turn(TurnStatus::Failed));
                }
                events
            }
            // A background process the agent started (`terminal` with
            // `background: true`) streams its output apart from any call.
            "agent.terminal.output" => background_output(payload),
            _ if kind.starts_with("subagent.") => self.subagent(kind, payload),
            _ => Vec::new(),
        }
    }

    fn complete_message(&mut self, payload: &Value) -> Vec<CodeEvent> {
        let status = payload.get("status").and_then(Value::as_str).unwrap_or("");
        let turn_status = match status {
            "error" | "failed" => TurnStatus::Failed,
            "interrupted" | "cancelled" | "canceled" => TurnStatus::Interrupted,
            _ => TurnStatus::Completed,
        };
        let mut events = Vec::new();
        let text = text_of(payload, &["text", "message", "content", "delta"], false);
        if turn_status == TurnStatus::Failed {
            // The runtime puts its failure in the answer's place ("API call
            // failed after 3 retries: ..."): it is an error, not a reply.
            events.push(CodeEvent::Error {
                message: text
                    .map(|text| text.trim().to_string())
                    .unwrap_or_else(|| "The agent runtime ended the turn on an error.".to_string()),
                code: None,
                recoverable: false,
            });
        } else if let Some(text) = text {
            events.push(CodeEvent::MessageCompleted {
                message_id: message_id(payload),
                text,
                interim: false,
            });
        }
        events.extend(self.end_turn(turn_status));
        events
    }

    fn tool_start(&mut self, payload: &Value) -> Vec<CodeEvent> {
        let call_id = call_id(payload);
        let name = tool_name(payload).unwrap_or_else(|| "tool".to_string());
        self.open_tools.insert(call_id.clone(), name.clone());
        let kind = tool_kind(&name);
        // v0.19 sends a display label (`context`: "Writing hello.py"), never
        // the arguments, at the start; those arrive with the completion.
        let detail = payload
            .get("args")
            .or_else(|| payload.get("arguments"))
            .map(|args| detail_from_args(kind, args))
            .unwrap_or_default();
        vec![CodeEvent::ToolStarted {
            call_id,
            name,
            kind,
            label: payload
                .get("context")
                .and_then(non_empty_str)
                .map(|label| clip_start(label, SUMMARY_MAX_CHARS).0),
            detail,
        }]
    }

    fn tool_complete(&mut self, payload: &Value) -> Vec<CodeEvent> {
        let call_id = call_id(payload);
        let remembered = self.open_tools.remove(&call_id);
        let name = tool_name(payload)
            .or(remembered)
            .unwrap_or_else(|| "tool".to_string());
        let kind = tool_kind(&name);
        let empty = Value::Null;
        let args = payload
            .get("args")
            .or_else(|| payload.get("arguments"))
            .unwrap_or(&empty);
        let result = payload.get("result").unwrap_or(&empty);
        let mut detail = detail_from_args(kind, args);
        let error = tool_error(payload, result);
        if kind == ToolKind::Edit {
            detail.edit = Some(edit_detail(payload, result));
            if detail.path.is_none() {
                detail.path = result
                    .get("files_modified")
                    .or_else(|| result.get("files_created"))
                    .and_then(Value::as_array)
                    .and_then(|files| files.first())
                    .and_then(non_empty_str)
                    .map(str::to_string);
            }
        }
        let mut events = vec![CodeEvent::ToolCompleted {
            call_id: call_id.clone(),
            name: name.clone(),
            kind,
            ok: error.is_none(),
            detail,
            summary: payload
                .get("summary")
                .and_then(non_empty_str)
                .map(|text| clip_start(text, SUMMARY_MAX_CHARS).0),
            error,
            duration_ms: payload
                .get("duration_s")
                .and_then(Value::as_f64)
                .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
                .map(|seconds| (seconds * 1000.0).round() as u64),
        }];
        if kind == ToolKind::Shell {
            if let Some(output) = shell_output(result) {
                let (text, truncated) = clip_end(&output, TERMINAL_OUTPUT_MAX_CHARS);
                events.push(CodeEvent::TerminalOutput {
                    call_id: Some(call_id),
                    process_id: None,
                    text,
                    exit_code: result.get("exit_code").and_then(Value::as_i64),
                    truncated,
                });
            }
        }
        if let Some(items) = payload.get("todos").and_then(Value::as_array) {
            events.push(CodeEvent::TodoUpdated {
                items: items.iter().filter_map(todo_item).collect(),
            });
        }
        events
    }

    /// A delegated subagent, reported as a call of its own: opened on its
    /// first frame (normally `subagent.start`), its activity as progress of
    /// that call, closed on `subagent.complete`. A progress line therefore
    /// never names a call that was not started.
    fn subagent(&mut self, kind: &str, payload: &Value) -> Vec<CodeEvent> {
        let id = ["subagent_id", "subagentId", "handle", "id"]
            .iter()
            .find_map(|key| payload.get(*key).and_then(scalar_string))
            .unwrap_or_else(|| "subagent".to_string());
        let call_id = format!("subagent:{id}");
        let phase = kind.trim_start_matches("subagent.");
        let mut events = Vec::new();
        if self.open_subagents.insert(id.clone(), ()).is_none() {
            events.push(CodeEvent::ToolStarted {
                call_id: call_id.clone(),
                name: "subagent".to_string(),
                kind: ToolKind::Delegate,
                label: text_of(payload, &["goal"], true)
                    .map(|goal| clip_start(&goal, SUMMARY_MAX_CHARS).0),
                detail: ToolDetail::default(),
            });
        }
        match phase {
            "start" => {}
            "complete" => {
                self.open_subagents.remove(&id);
                let status = payload.get("status").and_then(Value::as_str).unwrap_or("");
                let failed = matches!(status, "error" | "failed" | "interrupted" | "cancelled");
                events.push(CodeEvent::ToolCompleted {
                    call_id,
                    name: "subagent".to_string(),
                    kind: ToolKind::Delegate,
                    ok: !failed,
                    detail: ToolDetail::default(),
                    summary: text_of(payload, &["summary"], true)
                        .map(|text| clip_start(&text, SUMMARY_MAX_CHARS).0),
                    error: failed.then(|| format!("The subagent ended: {status}.")),
                    duration_ms: payload
                        .get("duration_seconds")
                        .and_then(Value::as_f64)
                        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
                        .map(|seconds| (seconds * 1000.0).round() as u64),
                });
            }
            _ => {
                let detail = text_of(
                    payload,
                    &["summary", "tool_preview", "tool_name", "text", "delta"],
                    false,
                );
                events.push(CodeEvent::ToolProgress {
                    call_id,
                    text: match detail {
                        Some(detail) => format!("{phase}: {detail}"),
                        None => phase.to_string(),
                    },
                });
            }
        }
        events
    }

    fn approval(&mut self, kind: ApprovalKind, payload: &Value) -> CodeEvent {
        let request_id = ["request_id", "requestId", "id"]
            .iter()
            .find_map(|key| payload.get(*key).and_then(scalar_string))
            .unwrap_or_else(|| {
                self.anonymous_requests += 1;
                format!("request-{}", self.anonymous_requests)
            });
        let description = match kind {
            ApprovalKind::Clarify => text_of(payload, &["question"], true),
            ApprovalKind::Secret => text_of(payload, &["reason"], true).or_else(|| {
                ["key_name", "keyName", "key", "name"]
                    .iter()
                    .find_map(|key| payload.get(*key).and_then(non_empty_str))
                    .map(str::to_string)
            }),
            ApprovalKind::Command | ApprovalKind::Sudo => {
                text_of(payload, &["description", "reason"], true)
            }
        };
        let command = match kind {
            // A secret request never carries its value out of here.
            ApprovalKind::Secret | ApprovalKind::Clarify => None,
            ApprovalKind::Command | ApprovalKind::Sudo => text_of(payload, &["command"], true),
        };
        CodeEvent::ApprovalRequested {
            request_id,
            kind,
            command,
            description,
            choices: payload
                .get("choices")
                .and_then(Value::as_array)
                .map(|choices| {
                    choices
                        .iter()
                        .filter_map(non_empty_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
        }
    }
}

/// Which family a tool belongs to, by its name. Unknown tools are `other`,
/// never guessed into a family whose detail they would not fill.
#[must_use]
pub fn tool_kind(name: &str) -> ToolKind {
    match name {
        "read_file" | "view" | "read" | "cat" => ToolKind::Read,
        "write_file" | "patch" | "edit" | "edit_file" | "apply_patch" | "str_replace"
        | "multi_edit" => ToolKind::Edit,
        "terminal" | "process" | "execute_code" | "read_terminal" | "close_terminal" | "shell"
        | "bash" => ToolKind::Shell,
        "search_files" | "grep" | "glob" | "find" | "web_search" | "session_search" => {
            ToolKind::Search
        }
        "delegate_task" | "task" | "subagent" => ToolKind::Delegate,
        _ => ToolKind::Other,
    }
}

fn detail_from_args(kind: ToolKind, args: &Value) -> ToolDetail {
    let text = |key: &str| args.get(key).and_then(non_empty_str).map(str::to_string);
    match kind {
        ToolKind::Read => ToolDetail {
            path: text("path").or_else(|| text("file_path")),
            lines: read_lines(args),
            ..ToolDetail::default()
        },
        ToolKind::Edit => ToolDetail {
            path: text("path").or_else(|| text("file_path")),
            ..ToolDetail::default()
        },
        ToolKind::Shell => ToolDetail {
            command: text("command")
                .or_else(|| text("code"))
                .or_else(|| text("action")),
            ..ToolDetail::default()
        },
        ToolKind::Search => ToolDetail {
            path: text("path"),
            query: text("pattern").or_else(|| text("query")),
            ..ToolDetail::default()
        },
        ToolKind::Delegate | ToolKind::Other => ToolDetail::default(),
    }
}

/// `read_file`'s `offset` (1-based first line) and `limit` (line count).
fn read_lines(args: &Value) -> Option<LineRange> {
    let start = args
        .get("offset")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1);
    let limit = args.get("limit").and_then(Value::as_u64)?;
    if limit == 0 {
        return None;
    }
    let start = u32::try_from(start).ok()?;
    let end = start.saturating_add(u32::try_from(limit).ok()?.saturating_sub(1));
    Some(LineRange { start, end })
}

fn edit_detail(payload: &Value, result: &Value) -> EditDetail {
    let diff = result
        .get("diff")
        .and_then(non_empty_str)
        .map(str::to_string)
        .or_else(|| {
            payload
                .get("inline_diff")
                .and_then(non_empty_str)
                .map(|rendered| unified_from_rendered(&strip_ansi(rendered)))
        });
    let (added, removed) = diff.as_deref().map(count_diff_lines).unwrap_or((0, 0));
    let mut files: Vec<String> = Vec::new();
    for key in ["files_modified", "files_created", "files_deleted"] {
        for file in result
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(non_empty_str)
        {
            if !files.iter().any(|known| known == file) {
                files.push(file.to_string());
            }
        }
    }
    if files.len() < 2 {
        files.clear();
    }
    let mut diagnostics = result
        .get("lsp_diagnostics")
        .and_then(Value::as_str)
        .map(parse_lsp_diagnostics)
        .unwrap_or_default();
    if let Some(lint) = result.get("lint").and_then(lint_diagnostic) {
        diagnostics.push(lint);
    }
    EditDetail {
        // Hermes v0.19 computes the matching strategy and drops it
        // (`_strategy` in file_operations.py); P1 recovers it through a
        // plugin hook. Read here as soon as the result carries it.
        strategy: result
            .get("strategy")
            .and_then(non_empty_str)
            .map(str::to_string),
        formatter: result
            .get("formatter")
            .and_then(non_empty_str)
            .map(str::to_string),
        diagnostics,
        added,
        removed,
        diff: diff.map(|diff| clip_start(&diff, DIFF_MAX_CHARS).0),
        files,
    }
}

/// Hermes' rendered review diff (`inline_diff`, colours stripped) back to a
/// unified diff: its `┊ review diff` banner goes, and its `a/x → b/x` file
/// line becomes the `---`/`+++` pair.
fn unified_from_rendered(rendered: &str) -> String {
    let mut out = Vec::new();
    for line in rendered.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('┊') {
            continue;
        }
        if let Some((from, to)) = trimmed.split_once(" → ") {
            if from.starts_with("a/") && to.starts_with("b/") {
                out.push(format!("--- {from}"));
                out.push(format!("+++ {to}"));
                continue;
            }
        }
        out.push(line.to_string());
    }
    let mut diff = out.join("\n");
    diff.push('\n');
    diff
}

/// Added and removed lines of a unified diff, headers left out.
#[must_use]
pub fn count_diff_lines(diff: &str) -> (u32, u32) {
    let mut added = 0u32;
    let mut removed = 0u32;
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            added = added.saturating_add(1);
        } else if line.starts_with('-') {
            removed = removed.saturating_add(1);
        }
    }
    (added, removed)
}

/// Hermes' LSP report: `<diagnostics file="…">` blocks of
/// `SEVERITY [line:col] message [code] (source)` lines
/// (`agent/lsp/reporter.py`).
#[must_use]
pub fn parse_lsp_diagnostics(report: &str) -> Vec<Diagnostic> {
    report
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let (severity, rest) = line.split_once(' ')?;
            let severity = match severity {
                "ERROR" => DiagnosticSeverity::Error,
                "WARNING" | "WARN" => DiagnosticSeverity::Warning,
                "INFO" | "HINT" | "INFORMATION" => DiagnosticSeverity::Info,
                _ => return None,
            };
            let rest = rest.strip_prefix('[')?;
            let (position, message) = rest.split_once("] ")?;
            let line_number = position.split(':').next()?.parse::<u32>().ok();
            let (message, source) = match message.rsplit_once(" (") {
                Some((body, tail)) if tail.ends_with(')') => (
                    body.to_string(),
                    Some(tail.trim_end_matches(')').to_string()),
                ),
                _ => (message.to_string(), None),
            };
            Some(Diagnostic {
                severity,
                message,
                line: line_number,
                source,
            })
        })
        .collect()
}

/// `LintResult.to_dict()`: `{status: ok|error|skipped, output, message}`.
fn lint_diagnostic(lint: &Value) -> Option<Diagnostic> {
    if lint.get("status").and_then(Value::as_str) != Some("error") {
        return None;
    }
    let message = text_of(lint, &["output", "message"], false)
        .map(|text| clip_start(text.trim(), SUMMARY_MAX_CHARS).0)
        .unwrap_or_else(|| "The file does not parse.".to_string());
    Some(Diagnostic {
        severity: DiagnosticSeverity::Error,
        message,
        line: None,
        source: Some("lint".to_string()),
    })
}

fn tool_error(payload: &Value, result: &Value) -> Option<String> {
    let explicit = text_of(payload, &["error"], false)
        .or_else(|| text_of(result, &["error"], false))
        .map(|text| clip_start(&text, SUMMARY_MAX_CHARS).0);
    if explicit.is_some() {
        return explicit;
    }
    let status = payload.get("status").and_then(Value::as_str);
    if matches!(status, Some("error" | "failed"))
        || result.get("success") == Some(&Value::Bool(false))
    {
        return Some("The tool call failed.".to_string());
    }
    None
}

/// What a shell tool printed: `{output}` (terminal), `{stdout, stderr}`, or a
/// plain string result.
fn shell_output(result: &Value) -> Option<String> {
    if let Some(text) = result.as_str() {
        return (!text.is_empty()).then(|| text.to_string());
    }
    if let Some(output) = result.get("output").and_then(Value::as_str) {
        return Some(output.to_string());
    }
    let stdout = result.get("stdout").and_then(Value::as_str).unwrap_or("");
    let stderr = result.get("stderr").and_then(Value::as_str).unwrap_or("");
    let joined = match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => return None,
        (false, true) => stdout.to_string(),
        (true, false) => stderr.to_string(),
        (false, false) => format!("{stdout}\n{stderr}"),
    };
    Some(joined)
}

fn tool_progress(payload: &Value) -> Vec<CodeEvent> {
    text_of(
        payload,
        &["output", "text", "preview", "message", "summary"],
        false,
    )
    .map(|text| {
        vec![CodeEvent::ToolProgress {
            call_id: call_id(payload),
            text,
        }]
    })
    .unwrap_or_default()
}

/// A chunk of a background process's output, without ANSI codes.
fn background_output(payload: &Value) -> Vec<CodeEvent> {
    let Some(chunk) = payload
        .get("chunk")
        .or_else(|| payload.get("text"))
        .and_then(Value::as_str)
    else {
        return Vec::new();
    };
    let clean = strip_ansi(chunk);
    if clean.is_empty() {
        return Vec::new();
    }
    let (text, truncated) = clip_end(&clean, TERMINAL_OUTPUT_MAX_CHARS);
    vec![CodeEvent::TerminalOutput {
        call_id: None,
        process_id: ["process_id", "processId", "id"]
            .iter()
            .find_map(|key| payload.get(*key).and_then(scalar_string)),
        text,
        exit_code: None,
        truncated,
    }]
}

/// The request id of a `terminal.read.request`: the runtime asks for the
/// in-app terminal's contents and blocks until an answer. A run without a
/// window answers it at once with nothing (the tool then says no terminal is
/// open), rather than let it wait out its timeout. The contract has no event
/// for it: it is neither a decision nor anything the run did.
#[must_use]
pub fn terminal_read_request(frame: &Value) -> Option<String> {
    if frame.get("type").and_then(Value::as_str) != Some("terminal.read.request") {
        return None;
    }
    frame
        .get("payload")
        .and_then(|payload| payload.get("request_id"))
        .and_then(scalar_string)
}

fn todo_item(value: &Value) -> Option<TodoItem> {
    let content = text_of(value, &["content", "text", "title"], false)?;
    let status = match value.get("status").and_then(Value::as_str).unwrap_or("") {
        "in_progress" | "in-progress" | "active" => TodoStatus::InProgress,
        "completed" | "done" => TodoStatus::Completed,
        "cancelled" | "canceled" => TodoStatus::Cancelled,
        _ => TodoStatus::Pending,
    };
    Some(TodoItem {
        id: value.get("id").and_then(scalar_string),
        content,
        status,
    })
}

fn call_id(payload: &Value) -> String {
    ["tool_id", "tool_call_id", "toolCallId", "call_id", "id"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(scalar_string))
        .unwrap_or_else(|| "tool".to_string())
}

fn tool_name(payload: &Value) -> Option<String> {
    ["name", "tool_name", "tool"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(non_empty_str))
        .map(str::to_string)
}

fn message_id(payload: &Value) -> Option<String> {
    ["message_id", "messageId"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(scalar_string))
}

/// The first non-empty string among `keys`. Streamed text keeps its
/// whitespace (a delta of one space is a real delta); `trim` is for labels.
fn text_of(value: &Value, keys: &[&str], trim: bool) -> Option<String> {
    keys.iter().find_map(|key| {
        let text = value.get(*key)?.as_str()?;
        if trim {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        } else {
            (!text.is_empty()).then(|| text.to_string())
        }
    })
}

fn non_empty_str(value: &Value) -> Option<&str> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

fn scalar_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => non_empty_str(value).map(|_| text.trim().to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Keeps the beginning of `text`, at most `max` characters.
fn clip_start(text: &str, max: usize) -> (String, bool) {
    match text.char_indices().nth(max) {
        Some((cut, _)) => (text[..cut].to_string(), true),
        None => (text.to_string(), false),
    }
}

/// Keeps the end of `text`, at most `max` characters: the end of a log is
/// where the failure is.
fn clip_end(text: &str, max: usize) -> (String, bool) {
    let count = text.chars().count();
    if count <= max {
        return (text.to_string(), false);
    }
    let skip = count - max;
    let cut = text.char_indices().nth(skip).map_or(0, |(index, _)| index);
    (text[cut..].to_string(), true)
}

/// Removes terminal colour sequences (`ESC [ … letter`).
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::code::event::tests::assert_fixture;
    use serde_json::json;

    fn fixture(name: &str) -> Vec<Value> {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../src/lib/hermes-control-plane/fixtures")
            .join(format!("{name}.json"));
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        raw["frames"].as_array().unwrap().clone()
    }

    fn adapt_all(adapter: &mut HermesAdapter, frames: &[Value]) -> Vec<CodeEvent> {
        frames
            .iter()
            .flat_map(|frame| adapter.adapt(frame))
            .collect()
    }

    #[test]
    fn a_streamed_answer_becomes_deltas_then_the_whole_message_and_closes_the_turn() {
        let mut adapter = HermesAdapter::new();
        adapter.begin_turn("turn-1");
        let events = adapt_all(&mut adapter, &fixture("normal-message"));
        assert_eq!(
            events,
            vec![
                CodeEvent::MessageDelta {
                    message_id: Some("m-1".into()),
                    channel: MessageChannel::Answer,
                    text: "Sure, here is the plan: ".into(),
                },
                CodeEvent::MessageDelta {
                    message_id: Some("m-1".into()),
                    channel: MessageChannel::Answer,
                    text: "step one.".into(),
                },
                CodeEvent::MessageCompleted {
                    message_id: Some("m-1".into()),
                    text: "Sure, here is the plan: step one.".into(),
                    interim: false,
                },
                CodeEvent::TurnFinished {
                    turn_id: "turn-1".into(),
                    status: TurnStatus::Completed,
                },
            ]
        );
        assert!(!adapter.turn_open());
    }

    #[test]
    fn a_tool_call_keeps_its_id_and_name_across_its_phases() {
        let mut adapter = HermesAdapter::new();
        let events = adapt_all(&mut adapter, &fixture("tool-call-success"));
        assert_eq!(events.len(), 3);
        match &events[0] {
            CodeEvent::ToolStarted {
                call_id,
                kind,
                detail,
                ..
            } => {
                assert_eq!(call_id, "tc-1");
                assert_eq!(*kind, ToolKind::Read);
                assert_eq!(detail.path.as_deref(), Some("/workspace/src/index.ts"));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(&events[1], CodeEvent::ToolProgress { call_id, .. } if call_id == "tc-1"));
        match &events[2] {
            CodeEvent::ToolCompleted { name, ok, .. } => {
                // The completion frame has no name; the start's is kept.
                assert_eq!(name, "read_file");
                assert!(ok);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_failed_tool_is_reported_failed_with_its_error() {
        let mut adapter = HermesAdapter::new();
        let events = adapt_all(&mut adapter, &fixture("tool-call-failure"));
        match events.iter().find(|e| e.type_name() == "tool.completed") {
            Some(CodeEvent::ToolCompleted {
                ok, error, kind, ..
            }) => {
                assert!(!ok);
                assert_eq!(error.as_deref(), Some("exit code 1"));
                assert_eq!(*kind, ToolKind::Shell);
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(events.iter().any(|e| matches!(
            e,
            CodeEvent::TerminalOutput { text, .. } if text.contains("TS2322")
        )));
    }

    #[test]
    fn requests_to_decide_become_approval_requests_and_a_secret_never_carries_a_value() {
        let mut adapter = HermesAdapter::new();
        let approval = adapt_all(&mut adapter, &fixture("approval-request-response"));
        assert_eq!(
            approval,
            vec![CodeEvent::ApprovalRequested {
                request_id: "ap-1".into(),
                kind: ApprovalKind::Command,
                command: Some("rm -rf build".into()),
                description: Some("Delete the build directory".into()),
                choices: Vec::new(),
            }]
        );
        let secret = adapt_all(&mut adapter, &fixture("secret-request-response"));
        let rendered = serde_json::to_string(&secret).unwrap();
        assert!(secret.iter().any(|e| matches!(
            e,
            CodeEvent::ApprovalRequested {
                kind: ApprovalKind::Secret,
                command: None,
                ..
            }
        )));
        assert!(!rendered.contains("FAKE"), "{rendered}");
    }

    #[test]
    fn a_provider_error_fails_the_turn_and_keeps_only_its_message() {
        let mut adapter = HermesAdapter::new();
        adapter.begin_turn("turn-1");
        let events = adapt_all(&mut adapter, &fixture("provider-account-error"));
        let rendered = serde_json::to_string(&events).unwrap();
        assert!(!rendered.contains("FAKE"), "{rendered}");
        assert_eq!(
            events,
            vec![
                CodeEvent::Error {
                    message: "Upstream provider returned 401 Unauthorized".into(),
                    code: Some("401".into()),
                    recoverable: false,
                },
                CodeEvent::TurnFinished {
                    turn_id: "turn-1".into(),
                    status: TurnStatus::Failed,
                },
            ]
        );
    }

    #[test]
    fn reasoning_is_its_own_channel_and_status_and_spinner_frames_give_nothing() {
        let mut adapter = HermesAdapter::new();
        let events = adapt_all(&mut adapter, &fixture("reasoning-and-status"));
        assert_eq!(
            events,
            vec![CodeEvent::MessageDelta {
                message_id: None,
                channel: MessageChannel::Reasoning,
                text: "The reconnect is coalesced via connectPromise.".into(),
            }]
        );
    }

    #[test]
    fn a_turn_the_runtime_ends_on_an_error_reports_the_error_not_a_reply() {
        let mut adapter = HermesAdapter::new();
        adapter.begin_turn("turn-1");
        let events = adapter.adapt(&json!({
            "type": "message.complete",
            "session_id": "s",
            "payload": {"status": "error", "text": "API call failed after 3 retries: HTTP 502: upstream_provider_failed"}
        }));
        assert_eq!(
            events,
            vec![
                CodeEvent::Error {
                    message: "API call failed after 3 retries: HTTP 502: upstream_provider_failed"
                        .into(),
                    code: None,
                    recoverable: false,
                },
                CodeEvent::TurnFinished {
                    turn_id: "turn-1".into(),
                    status: TurnStatus::Failed,
                },
            ]
        );
    }

    #[test]
    fn a_subagent_is_a_call_opened_then_closed_and_its_activity_its_progress() {
        let mut adapter = HermesAdapter::new();
        let events = adapt_all(&mut adapter, &fixture("subagent-lifecycle"));
        assert_eq!(events.len(), 5);
        assert!(matches!(
            &events[0],
            CodeEvent::ToolStarted { call_id, kind: ToolKind::Delegate, label: Some(goal), .. }
                if call_id == "subagent:sub-1" && goal.contains("gateway reconnects")
        ));
        assert!(events[1..4].iter().all(|e| matches!(
            e,
            CodeEvent::ToolProgress { call_id, .. } if call_id == "subagent:sub-1"
        )));
        assert!(matches!(
            &events[4],
            CodeEvent::ToolCompleted { call_id, ok: true, summary: Some(_), .. }
                if call_id == "subagent:sub-1"
        ));
    }

    /// Every progress line names a call opened before it, in every recorded
    /// fixture: a consumer never sees progress on an unknown call.
    #[test]
    fn no_progress_ever_names_a_call_that_was_not_started() {
        for name in ["subagent-lifecycle", "subagent-background-completion"] {
            let mut adapter = HermesAdapter::new();
            adapter.begin_turn("t");
            let mut opened = std::collections::HashSet::new();
            for event in adapt_all(&mut adapter, &fixture(name)) {
                match event {
                    CodeEvent::ToolStarted { call_id, .. } => {
                        opened.insert(call_id);
                    }
                    CodeEvent::ToolProgress { call_id, .. } => {
                        assert!(opened.contains(&call_id), "{name}: {call_id}");
                    }
                    _ => {}
                }
            }
        }
    }

    #[test]
    fn a_recoverable_error_is_reported_and_the_turn_goes_on() {
        let mut adapter = HermesAdapter::new();
        adapter.begin_turn("turn-1");
        let events = adapter.adapt(&json!({
            "type": "error",
            "payload": {"message": "Rate limited, retrying", "recoverable": true}
        }));
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            CodeEvent::Error {
                recoverable: true,
                ..
            }
        ));
        assert!(adapter.turn_open());
        let fatal = adapter.adapt(&json!({"type": "error", "payload": {"message": "boom"}}));
        assert!(matches!(
            fatal.last(),
            Some(CodeEvent::TurnFinished {
                status: TurnStatus::Failed,
                ..
            })
        ));
        assert!(!adapter.turn_open());
    }

    #[test]
    fn a_background_process_output_is_terminal_output_of_its_process() {
        let mut adapter = HermesAdapter::new();
        let events = adapter.adapt(&json!({
            "type": "agent.terminal.output",
            "session_id": "s",
            "payload": {"process_id": "proc_9", "chunk": "\u{1b}[32mready\u{1b}[0m in 412 ms\n"}
        }));
        assert_eq!(
            events,
            vec![CodeEvent::TerminalOutput {
                call_id: None,
                process_id: Some("proc_9".into()),
                text: "ready in 412 ms\n".into(),
                exit_code: None,
                truncated: false,
            }]
        );
    }

    #[test]
    fn a_terminal_read_request_is_recognized_for_an_answer_and_gives_no_event() {
        let frame = json!({
            "type": "terminal.read.request",
            "session_id": "s",
            "payload": {"request_id": "ab12cd34", "count": 40}
        });
        assert_eq!(terminal_read_request(&frame).as_deref(), Some("ab12cd34"));
        assert!(HermesAdapter::new().adapt(&frame).is_empty());
        assert_eq!(
            terminal_read_request(
                &json!({"type": "clarify.request", "payload": {"request_id": "x"}})
            ),
            None
        );
    }

    #[test]
    fn every_recorded_fixture_adapts_without_panicking() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../src/lib/hermes-control-plane/fixtures");
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let raw: Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let frames = raw
                .get("frames")
                .or_else(|| raw.get("events"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut adapter = HermesAdapter::new();
            adapter.begin_turn("t");
            for frame in &frames {
                for event in adapter.adapt(frame) {
                    serde_json::to_string(&event).unwrap();
                }
            }
        }
    }

    #[test]
    fn frames_of_another_session_are_ignored_once_one_is_watched() {
        let mut adapter = HermesAdapter::new();
        adapter.watch_session("mine");
        let other =
            json!({"type": "message.delta", "session_id": "theirs", "payload": {"text": "x"}});
        let mine = json!({"type": "message.delta", "session_id": "mine", "payload": {"text": "y"}});
        let unnamed = json!({"type": "message.delta", "payload": {"text": "z"}});
        assert!(adapter.adapt(&other).is_empty());
        assert_eq!(adapter.adapt(&mine).len(), 1);
        assert_eq!(adapter.adapt(&unnamed).len(), 1);
    }

    #[test]
    fn a_v019_patch_carries_its_diff_counts_files_and_diagnostics() {
        let mut adapter = HermesAdapter::new();
        adapter.adapt(&json!({
            "type": "tool.start",
            "session_id": "s",
            "payload": {"tool_id": "call_9", "name": "patch", "context": "src/lib.rs"}
        }));
        let events = adapter.adapt(&json!({
            "type": "tool.complete",
            "session_id": "s",
            "payload": {
                "tool_id": "call_9",
                "name": "patch",
                "args": {"mode": "replace", "path": "src/lib.rs", "old_string": "a", "new_string": "b"},
                "duration_s": 0.0421,
                "result": {
                    "success": true,
                    "diff": "--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1,2 +1,3 @@\n-a\n+b\n+c\n",
                    "files_modified": ["src/lib.rs", "src/main.rs"],
                    "lint": {"status": "ok", "output": ""},
                    "lsp_diagnostics": "<diagnostics file=\"src/lib.rs\">\nERROR [3:5] mismatched types [E0308] (rustc)\nWARNING [9:1] unused import\n</diagnostics>"
                }
            }
        }));
        let CodeEvent::ToolCompleted {
            detail,
            duration_ms,
            ok,
            ..
        } = &events[0]
        else {
            panic!("unexpected {events:?}");
        };
        assert!(ok);
        assert_eq!(*duration_ms, Some(42));
        assert_eq!(detail.path.as_deref(), Some("src/lib.rs"));
        let edit = detail.edit.as_ref().unwrap();
        assert_eq!((edit.added, edit.removed), (2, 1));
        assert_eq!(edit.files, vec!["src/lib.rs", "src/main.rs"]);
        assert_eq!(
            edit.diagnostics,
            vec![
                Diagnostic {
                    severity: DiagnosticSeverity::Error,
                    message: "mismatched types [E0308]".into(),
                    line: Some(3),
                    source: Some("rustc".into()),
                },
                Diagnostic {
                    severity: DiagnosticSeverity::Warning,
                    message: "unused import".into(),
                    line: Some(9),
                    source: None,
                },
            ]
        );
        assert_eq!(edit.strategy, None);
    }

    #[test]
    fn a_write_that_does_not_parse_reports_the_linter() {
        let mut adapter = HermesAdapter::new();
        let events = adapter.adapt(&json!({
            "type": "tool.complete",
            "payload": {
                "tool_id": "w1",
                "name": "write_file",
                "args": {"path": "hello.py", "content": "print("},
                "inline_diff": "\u{1b}[32m+print(\u{1b}[0m",
                "result": {"bytes_written": 6, "lint": {"status": "error", "output": "SyntaxError: '(' was never closed"}}
            }
        }));
        let CodeEvent::ToolCompleted { detail, ok, .. } = &events[0] else {
            panic!("unexpected {events:?}");
        };
        // The write happened: the call succeeded, the check flagged it.
        assert!(ok);
        let edit = detail.edit.as_ref().unwrap();
        assert_eq!(edit.diff.as_deref(), Some("+print(\n"));
        assert_eq!(edit.added, 1);
        assert_eq!(edit.diagnostics[0].source.as_deref(), Some("lint"));
    }

    #[test]
    fn a_terminal_result_becomes_its_output_cut_from_the_start() {
        let mut adapter = HermesAdapter::new();
        let long = format!("{}END", "x".repeat(TERMINAL_OUTPUT_MAX_CHARS));
        let events = adapter.adapt(&json!({
            "type": "tool.complete",
            "payload": {
                "tool_id": "t1",
                "name": "terminal",
                "args": {"command": "cargo test"},
                "result": {"output": long, "exit_code": 0}
            }
        }));
        let CodeEvent::TerminalOutput {
            text,
            truncated,
            exit_code,
            ..
        } = &events[1]
        else {
            panic!("unexpected {events:?}");
        };
        assert!(*truncated);
        assert!(text.ends_with("END"));
        assert_eq!(text.chars().count(), TERMINAL_OUTPUT_MAX_CHARS);
        assert_eq!(*exit_code, Some(0));
    }

    #[test]
    fn a_todo_completion_publishes_the_whole_list() {
        let mut adapter = HermesAdapter::new();
        let events = adapter.adapt(&json!({
            "type": "tool.complete",
            "payload": {
                "tool_id": "t2",
                "name": "todo",
                "todos": [
                    {"id": "1", "content": "Write hello.py", "status": "completed"},
                    {"id": "2", "content": "Run it", "status": "in_progress"}
                ]
            }
        }));
        assert_eq!(
            events[1],
            CodeEvent::TodoUpdated {
                items: vec![
                    TodoItem {
                        id: Some("1".into()),
                        content: "Write hello.py".into(),
                        status: TodoStatus::Completed,
                    },
                    TodoItem {
                        id: Some("2".into()),
                        content: "Run it".into(),
                        status: TodoStatus::InProgress,
                    },
                ]
            }
        );
    }

    #[test]
    fn an_interrupted_completion_closes_the_turn_as_interrupted() {
        let mut adapter = HermesAdapter::new();
        adapter.begin_turn("turn-2");
        let events = adapter.adapt(&json!({
            "type": "message.complete",
            "payload": {"text": "", "status": "interrupted"}
        }));
        assert_eq!(
            events,
            vec![CodeEvent::TurnFinished {
                turn_id: "turn-2".into(),
                status: TurnStatus::Interrupted,
            }]
        );
    }

    /// The recorded run (a real Hermes v0.19 session, paths replaced) and
    /// what the adapter makes of it, kept as a golden file the TypeScript
    /// validator also reads: a second Hermes adapter, should one ever be
    /// written, has to produce the same output from the same frames.
    #[test]
    fn the_recorded_run_adapts_to_the_committed_golden_output() {
        let path = crate::code::event::tests::fixture_path("hermes-v0.19-run.frames.json");
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let session = raw["sessionId"].as_str().unwrap().to_string();
        let mut adapter = HermesAdapter::new();
        adapter.watch_session(session);
        let mut events = vec![adapter.begin_turn("turn-1")];
        for frame in raw["frames"].as_array().unwrap() {
            events.extend(adapter.adapt(frame));
        }
        assert!(!adapter.turn_open(), "the recorded turn must close");
        assert_fixture(
            "hermes-v0.19-run.events.json",
            &serde_json::json!({ "events": events }),
        );
    }

    #[test]
    fn diagnostics_lines_that_are_not_diagnostics_are_skipped() {
        assert!(
            parse_lsp_diagnostics("<diagnostics file=\"x\">\n... and 3 more\n</diagnostics>")
                .is_empty()
        );
    }

    #[test]
    fn tools_fall_into_their_families() {
        assert_eq!(tool_kind("read_file"), ToolKind::Read);
        assert_eq!(tool_kind("patch"), ToolKind::Edit);
        assert_eq!(tool_kind("write_file"), ToolKind::Edit);
        assert_eq!(tool_kind("terminal"), ToolKind::Shell);
        assert_eq!(tool_kind("execute_code"), ToolKind::Shell);
        assert_eq!(tool_kind("search_files"), ToolKind::Search);
        assert_eq!(tool_kind("delegate_task"), ToolKind::Delegate);
        assert_eq!(tool_kind("vision_analyze"), ToolKind::Other);
    }
}
