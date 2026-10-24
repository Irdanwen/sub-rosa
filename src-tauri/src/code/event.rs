//! The code event contract (ADR-0123).
//!
//! One neutral model of what a run of code work does, whatever runs it:
//! Hermes through its gateway today, Claude Code and opencode through ACP
//! later. Each engine gets an adapter that turns its own wire into these
//! events; everything downstream (the headless CLI's JSONL, the bench, the
//! Code surface) reads only these.
//!
//! The shape follows `codex exec --json`: one JSON object per line, a `type`
//! naming a dotted event, the run and turn as brackets around the items. The
//! TypeScript mirror is `src/lib/code/events.ts`; the two are held together by
//! a fixture this module writes and the frontend tests read
//! (`src/lib/code/fixtures/code-events.v1.json`).
//!
//! Compatibility: the schema version changes only when an existing field or
//! type changes meaning or disappears. A new event type or a new optional
//! field is additive within a version, so a consumer skips a `type` it does
//! not know instead of failing.

use serde::{Deserialize, Serialize};

/// The version every line carries in `schema`.
pub const CODE_EVENT_SCHEMA_VERSION: u32 = 1;

/// One line of a run's event stream.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CodeEventLine {
    /// [`CODE_EVENT_SCHEMA_VERSION`] at the time the line was written.
    pub schema: u32,
    pub run_id: String,
    /// Position of the line in the run, from 1. A resumed run continues the
    /// count, so `(run_id, seq)` identifies a line across invocations.
    pub seq: u64,
    /// RFC 3339, UTC.
    pub at: String,
    #[serde(flatten)]
    pub event: CodeEvent,
}

/// What can happen in a run.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CodeEvent {
    /// The run is ready to take its first turn.
    #[serde(rename = "run.started")]
    RunStarted {
        engine: Engine,
        model: String,
        mode: RunMode,
        dir: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        budget_usd: Option<f64>,
        /// Spent by earlier invocations of the same run, before this one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        spent_usd: Option<f64>,
        resumed: bool,
        /// Whether the engine's writes are confined by the OS (Seatbelt).
        sandboxed: bool,
        /// The engine's own session, for a later resume.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
    /// The last line of a run.
    #[serde(rename = "run.finished")]
    RunFinished {
        status: RunStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        /// Cumulative, every invocation of the run included.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
        /// `cost_usd` leaves out a completion the operator may have billed:
        /// one cut before its usage arrived, or still under way at the end.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        cost_incomplete: bool,
        turns: u32,
    },
    #[serde(rename = "turn.started")]
    TurnStarted { turn_id: String },
    #[serde(rename = "turn.finished")]
    TurnFinished { turn_id: String, status: TurnStatus },
    /// A piece of text the model is writing.
    #[serde(rename = "message.delta")]
    MessageDelta {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
        channel: MessageChannel,
        text: String,
    },
    /// The whole text of a message, authoritative over its deltas.
    #[serde(rename = "message.completed")]
    MessageCompleted {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
        text: String,
        /// Commentary sealed in the middle of a turn, not its answer.
        interim: bool,
    },
    #[serde(rename = "tool.started")]
    ToolStarted {
        call_id: String,
        name: String,
        kind: ToolKind,
        /// The engine's own one-line description ("Writing hello.py"), for
        /// display only: an engine that does not send the arguments at the
        /// start fills `detail` at completion instead.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(default, skip_serializing_if = "ToolDetail::is_empty")]
        detail: ToolDetail,
    },
    #[serde(rename = "tool.progress")]
    ToolProgress { call_id: String, text: String },
    #[serde(rename = "tool.completed")]
    ToolCompleted {
        call_id: String,
        name: String,
        kind: ToolKind,
        ok: bool,
        #[serde(default, skip_serializing_if = "ToolDetail::is_empty")]
        detail: ToolDetail,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
    },
    /// What a shell tool printed, or a chunk of a background process's
    /// output (`process_id`, no `call_id`).
    #[serde(rename = "terminal.output")]
    TerminalOutput {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        /// The engine's id of a background process the agent started.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        process_id: Option<String>,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i64>,
        /// The text was cut to the line's budget.
        truncated: bool,
    },
    /// The engine waits on a decision.
    #[serde(rename = "approval.requested")]
    ApprovalRequested {
        request_id: String,
        kind: ApprovalKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        command: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        choices: Vec<String>,
    },
    #[serde(rename = "approval.resolved")]
    ApprovalResolved {
        request_id: String,
        decision: ApprovalDecision,
        by: Resolver,
    },
    /// The run's task list, whole, each time it changes.
    #[serde(rename = "todo.updated")]
    TodoUpdated { items: Vec<TodoItem> },
    /// Reserved for the step timeline (P1): what one modifying call changed.
    /// No adapter emits it yet.
    #[serde(rename = "step.recorded")]
    StepRecorded {
        step_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        files: Vec<String>,
    },
    /// Cumulative metering of the run, as the operator reported it.
    #[serde(rename = "usage")]
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        cached_tokens: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        budget_usd: Option<f64>,
    },
    #[serde(rename = "error")]
    Error {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        recoverable: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Engine {
    Hermes,
    ClaudeCode,
    Opencode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    /// May change the folder.
    Build,
    /// Reads and proposes; the folder stays as it was.
    Plan,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Completed,
    Failed,
    /// Stopped cleanly because the run budget was reached.
    BudgetExceeded,
    Interrupted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageChannel {
    Answer,
    Reasoning,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Edit,
    Shell,
    Search,
    Delegate,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalKind {
    /// A command the engine's own rules flagged.
    Command,
    /// A question to the person.
    Clarify,
    Sudo,
    Secret,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Once,
    Session,
    Always,
    Deny,
    /// A question answered with text.
    Answered,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Resolver {
    User,
    /// The run's standing policy decided, no one was asked.
    Policy,
}

/// What a tool call touched, as far as the engine said.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ToolDetail {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<LineRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit: Option<EditDetail>,
}

impl ToolDetail {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

/// Lines of a file, 1-based and inclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineRange {
    pub start: u32,
    pub end: u32,
}

/// What a modification did and what checked it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EditDetail {
    /// How the old text was found (`exact`, or the tolerant strategy that
    /// matched). Optional: Hermes v0.19 does not report it yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strategy: Option<String>,
    /// The formatter that ran on the file afterwards, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formatter: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<Diagnostic>,
    pub added: u32,
    pub removed: u32,
    /// Unified diff, when the engine gave one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    /// Every file the call changed, when it changed more than `path`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub severity: DiagnosticSeverity,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub content: String,
    pub status: TodoStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

impl CodeEvent {
    /// The `type` this event serializes under.
    #[must_use]
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::RunStarted { .. } => "run.started",
            Self::RunFinished { .. } => "run.finished",
            Self::TurnStarted { .. } => "turn.started",
            Self::TurnFinished { .. } => "turn.finished",
            Self::MessageDelta { .. } => "message.delta",
            Self::MessageCompleted { .. } => "message.completed",
            Self::ToolStarted { .. } => "tool.started",
            Self::ToolProgress { .. } => "tool.progress",
            Self::ToolCompleted { .. } => "tool.completed",
            Self::TerminalOutput { .. } => "terminal.output",
            Self::ApprovalRequested { .. } => "approval.requested",
            Self::ApprovalResolved { .. } => "approval.resolved",
            Self::TodoUpdated { .. } => "todo.updated",
            Self::StepRecorded { .. } => "step.recorded",
            Self::Usage { .. } => "usage",
            Self::Error { .. } => "error",
        }
    }
}

/// Every `type` of schema 1, in the order the TypeScript mirror lists them.
pub const CODE_EVENT_TYPES: [&str; 16] = [
    "run.started",
    "run.finished",
    "turn.started",
    "turn.finished",
    "message.delta",
    "message.completed",
    "tool.started",
    "tool.progress",
    "tool.completed",
    "terminal.output",
    "approval.requested",
    "approval.resolved",
    "todo.updated",
    "step.recorded",
    "usage",
    "error",
];

/// Numbers the lines of one run.
#[derive(Debug)]
pub struct LineWriter {
    run_id: String,
    seq: u64,
}

impl LineWriter {
    /// `last_seq` is the last line an earlier invocation of the run wrote.
    #[must_use]
    pub fn new(run_id: impl Into<String>, last_seq: u64) -> Self {
        Self {
            run_id: run_id.into(),
            seq: last_seq,
        }
    }

    #[must_use]
    pub fn last_seq(&self) -> u64 {
        self.seq
    }

    pub fn line(&mut self, event: CodeEvent) -> CodeEventLine {
        self.seq += 1;
        CodeEventLine {
            schema: CODE_EVENT_SCHEMA_VERSION,
            run_id: self.run_id.clone(),
            seq: self.seq,
            at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            event,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
pub(crate) mod tests {
    use super::*;
    use std::path::PathBuf;

    /// One of each event, with every optional field the type has filled in at
    /// least once: the corpus both languages agree on.
    pub(crate) fn sample_events() -> Vec<CodeEvent> {
        let edit = EditDetail {
            strategy: Some("exact".into()),
            formatter: Some("rustfmt".into()),
            diagnostics: vec![Diagnostic {
                severity: DiagnosticSeverity::Warning,
                message: "unused import `TransactionBehavior`".into(),
                line: Some(4),
                source: Some("clippy".into()),
            }],
            added: 14,
            removed: 3,
            diff: Some("@@ -1 +1 @@\n-a\n+b\n".into()),
            files: vec!["src/db/migrations.rs".into(), "src/db/mod.rs".into()],
        };
        vec![
            CodeEvent::RunStarted {
                engine: Engine::Hermes,
                model: "kimi-k2-7-code".into(),
                mode: RunMode::Build,
                dir: "/work/repo".into(),
                budget_usd: Some(2.0),
                spent_usd: Some(0.25),
                resumed: true,
                sandboxed: true,
                session_id: Some("20261023_101500_ab12cd".into()),
            },
            CodeEvent::TurnStarted {
                turn_id: "turn-1".into(),
            },
            CodeEvent::MessageDelta {
                message_id: Some("m-1".into()),
                channel: MessageChannel::Reasoning,
                text: "Reading the migrations first.".into(),
            },
            CodeEvent::MessageDelta {
                message_id: None,
                channel: MessageChannel::Answer,
                text: "Done".into(),
            },
            CodeEvent::ToolStarted {
                call_id: "call-1".into(),
                name: "read_file".into(),
                kind: ToolKind::Read,
                label: Some("Reading src/db/migrations.rs".into()),
                detail: ToolDetail {
                    path: Some("src/db/migrations.rs".into()),
                    lines: Some(LineRange { start: 1, end: 140 }),
                    ..ToolDetail::default()
                },
            },
            CodeEvent::ToolProgress {
                call_id: "call-1".into(),
                text: "reading 140 lines".into(),
            },
            CodeEvent::ToolCompleted {
                call_id: "call-2".into(),
                name: "patch".into(),
                kind: ToolKind::Edit,
                ok: true,
                detail: ToolDetail {
                    path: Some("src/db/migrations.rs".into()),
                    edit: Some(edit),
                    ..ToolDetail::default()
                },
                summary: Some("2 files changed".into()),
                error: None,
                duration_ms: Some(42),
            },
            CodeEvent::ToolCompleted {
                call_id: "call-3".into(),
                name: "terminal".into(),
                kind: ToolKind::Shell,
                ok: false,
                detail: ToolDetail {
                    command: Some("cargo test".into()),
                    ..ToolDetail::default()
                },
                summary: None,
                error: Some("exit code 101".into()),
                duration_ms: None,
            },
            CodeEvent::ToolStarted {
                call_id: "call-4".into(),
                name: "search_files".into(),
                kind: ToolKind::Search,
                label: None,
                detail: ToolDetail {
                    query: Some("CREATE VIRTUAL TABLE".into()),
                    ..ToolDetail::default()
                },
            },
            CodeEvent::ToolStarted {
                call_id: "call-5".into(),
                name: "delegate_task".into(),
                kind: ToolKind::Delegate,
                label: None,
                detail: ToolDetail::default(),
            },
            CodeEvent::ToolStarted {
                call_id: "call-6".into(),
                name: "web_extract".into(),
                kind: ToolKind::Other,
                label: None,
                detail: ToolDetail::default(),
            },
            CodeEvent::TerminalOutput {
                call_id: Some("call-3".into()),
                process_id: None,
                text: "test result: FAILED. 22 passed; 1 failed\n".into(),
                exit_code: Some(101),
                truncated: false,
            },
            CodeEvent::TerminalOutput {
                call_id: None,
                process_id: Some("proc_1a2b".into()),
                text: "  VITE v6 ready in 412 ms\n".into(),
                exit_code: None,
                truncated: false,
            },
            CodeEvent::ApprovalRequested {
                request_id: "ap-1".into(),
                kind: ApprovalKind::Command,
                command: Some("rm -rf target/debug/incremental".into()),
                description: Some("recursive delete".into()),
                choices: vec![
                    "once".into(),
                    "session".into(),
                    "always".into(),
                    "deny".into(),
                ],
            },
            CodeEvent::ApprovalResolved {
                request_id: "ap-1".into(),
                decision: ApprovalDecision::Deny,
                by: Resolver::Policy,
            },
            CodeEvent::ApprovalRequested {
                request_id: "cl-1".into(),
                kind: ApprovalKind::Clarify,
                command: None,
                description: Some("Which branch?".into()),
                choices: Vec::new(),
            },
            CodeEvent::ApprovalResolved {
                request_id: "cl-1".into(),
                decision: ApprovalDecision::Answered,
                by: Resolver::User,
            },
            CodeEvent::TodoUpdated {
                items: vec![
                    TodoItem {
                        id: Some("1".into()),
                        content: "Reproduce under load".into(),
                        status: TodoStatus::Completed,
                    },
                    TodoItem {
                        id: None,
                        content: "Serialize the FTS creation".into(),
                        status: TodoStatus::InProgress,
                    },
                    TodoItem {
                        id: Some("3".into()),
                        content: "Run the suite 50 times".into(),
                        status: TodoStatus::Pending,
                    },
                    TodoItem {
                        id: Some("4".into()),
                        content: "Drop the retry".into(),
                        status: TodoStatus::Cancelled,
                    },
                ],
            },
            CodeEvent::StepRecorded {
                step_id: "step-3".into(),
                call_id: Some("call-2".into()),
                files: vec!["src/db/migrations.rs".into()],
            },
            CodeEvent::Usage {
                input_tokens: 48_210,
                output_tokens: 1_904,
                cached_tokens: 40_960,
                cost_usd: Some(0.0123),
                budget_usd: Some(2.0),
            },
            CodeEvent::MessageCompleted {
                message_id: Some("m-1".into()),
                text: "The creation now runs under a lock.".into(),
                interim: false,
            },
            CodeEvent::Error {
                message: "The operator refused the request.".into(),
                code: Some("upstream_provider_failed".into()),
                recoverable: false,
            },
            CodeEvent::TurnFinished {
                turn_id: "turn-1".into(),
                status: TurnStatus::Completed,
            },
            CodeEvent::RunFinished {
                status: RunStatus::BudgetExceeded,
                reason: Some("The run budget of $2.00 was reached.".into()),
                cost_usd: Some(2.01),
                cost_incomplete: true,
                turns: 1,
            },
        ]
    }

    /// The corpus as lines, with a fixed clock so the fixture is stable.
    fn sample_lines() -> Vec<CodeEventLine> {
        sample_events()
            .into_iter()
            .enumerate()
            .map(|(index, event)| CodeEventLine {
                schema: CODE_EVENT_SCHEMA_VERSION,
                run_id: "run_0192b6c8d1e47a3fb1c2d3e4f5a6b7c8".into(),
                seq: index as u64 + 1,
                at: "2026-10-23T10:15:00.000Z".into(),
                event,
            })
            .collect()
    }

    pub(crate) fn fixture_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../src/lib/code/fixtures")
            .join(name)
    }

    /// Compares `value` to the committed fixture, or rewrites it when
    /// `UPDATE_CODE_EVENT_FIXTURES=1`. The comparison is of the JSON, not the
    /// text: the committed file is formatted by Biome (`pnpm biome format
    /// --write src/lib/code/fixtures` after a rewrite).
    pub(crate) fn assert_fixture(name: &str, value: &serde_json::Value) {
        let path = fixture_path(name);
        if std::env::var_os("UPDATE_CODE_EVENT_FIXTURES").is_some() {
            let rendered = serde_json::to_string_pretty(value).unwrap() + "\n";
            std::fs::write(&path, rendered).unwrap();
            return;
        }
        let committed: Option<serde_json::Value> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok());
        assert!(
            committed.as_ref() == Some(value),
            "{} is out of date with the Rust contract; rerun with UPDATE_CODE_EVENT_FIXTURES=1 and commit it",
            path.display()
        );
    }

    #[test]
    fn the_shared_fixture_matches_the_rust_contract() {
        let lines = sample_lines();
        let value = serde_json::json!({
            "schema": CODE_EVENT_SCHEMA_VERSION,
            "types": CODE_EVENT_TYPES,
            "lines": lines,
        });
        assert_fixture("code-events.v1.json", &value);
    }

    #[test]
    fn the_corpus_covers_every_type_once_at_least() {
        let seen: std::collections::BTreeSet<&str> =
            sample_events().iter().map(CodeEvent::type_name).collect();
        let all: std::collections::BTreeSet<&str> = CODE_EVENT_TYPES.into_iter().collect();
        assert_eq!(seen, all);
    }

    #[test]
    fn a_line_round_trips_and_names_its_type_at_the_top_level() {
        for line in sample_lines() {
            let text = serde_json::to_string(&line).unwrap();
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(value["type"], line.event.type_name());
            assert_eq!(value["schema"], CODE_EVENT_SCHEMA_VERSION);
            let back: CodeEventLine = serde_json::from_str(&text).unwrap();
            assert_eq!(back, line);
        }
    }

    #[test]
    fn empty_details_and_absent_options_stay_off_the_wire() {
        let text = serde_json::to_string(&CodeEvent::ToolStarted {
            call_id: "c".into(),
            name: "web_extract".into(),
            kind: ToolKind::Other,
            label: None,
            detail: ToolDetail::default(),
        })
        .unwrap();
        assert_eq!(
            text,
            r#"{"type":"tool.started","call_id":"c","name":"web_extract","kind":"other"}"#
        );
    }

    #[test]
    fn the_writer_numbers_lines_after_an_earlier_invocation() {
        let mut writer = LineWriter::new("run_x", 7);
        let line = writer.line(CodeEvent::TurnStarted {
            turn_id: "turn-2".into(),
        });
        assert_eq!(line.seq, 8);
        assert_eq!(writer.last_seq(), 8);
        assert!(line.at.ends_with('Z'));
    }
}
