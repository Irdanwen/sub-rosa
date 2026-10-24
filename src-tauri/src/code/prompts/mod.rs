//! What the agent is told about a code task, by model family (lot C1.4).
//!
//! One source for both surfaces: the app's Code mode adds [`code_block`] to
//! each message of a chat in Code mode (the `code_prompt_block` command, read
//! by `src/lib/code-mode.ts`), and the headless CLI writes it into the run's
//! `SOUL.md` (`hermes_bridge::headless::render_code_soul`). The app cannot use
//! `SOUL.md` for it: that file is shared by every session of the runtime, and
//! a chat may switch model between two messages, so the block follows the
//! session's model message by message.
//!
//! The block is assembled from markdown files beside this module:
//!
//! - the family's working style (`anthropic.md`, `gpt.md`, `codex.md`,
//!   `kimi.md`, `glm.md`, `deepseek.md`, `grok.md`, `generic.md`);
//! - the common notes (`code.md`, the `CODE_MD` block);
//! - the edit format the family was trained on: V4A (`patch` in patch mode)
//!   for the GPT and Codex models, search and replace for the others
//!   (docs/hermes-code-surface.md, section 7: the runtime offers both modes to
//!   every model, so only the prompt chooses);
//! - the surface (`app.md` for Code mode in a chat);
//! - when to stop (`done.md`, or `plan.md` for a read-only run). The bench
//!   found the agent still running checks a hundred tool calls after the task
//!   was done, so the stop rule comes last, where it weighs most.
//!
//! Bump [`CODE_PROMPT_VERSION`] whenever a file here changes: the bench
//! compares prompts by it.
//!
//! The family notes are adapted from opencode v1.19.4,
//! `packages/opencode/src/session/prompt/*.txt` (github.com/anomalyco/opencode,
//! tag v1.19.4), rewritten for Sub Rosa's runtime and tools:
//!
//! > MIT License. Copyright (c) 2025 opencode. Permission is hereby granted,
//! > free of charge, to any person obtaining a copy of this software and
//! > associated documentation files (the "Software"), to deal in the Software
//! > without restriction, including without limitation the rights to use,
//! > copy, modify, merge, publish, distribute, sublicense, and/or sell copies
//! > of the Software, and to permit persons to whom the Software is furnished
//! > to do so, subject to the following conditions: The above copyright
//! > notice and this permission notice shall be included in all copies or
//! > substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
//! > WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
//! > LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
//! > PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
//! > HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
//! > AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
//! > CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//! > SOFTWARE.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::domain::types::AppError;

/// The version of every text in this module. `src/lib/code-mode.ts` holds the
/// same string, and `src/test/code-prompts.test.ts` keeps the two equal.
pub(crate) const CODE_PROMPT_VERSION: &str = "code-prompt-v1";

/// The notes every family gets.
const CODE_MD: &str = include_str!("code.md");
const EDIT_REPLACE_MD: &str = include_str!("edit-replace.md");
const EDIT_V4A_MD: &str = include_str!("edit-v4a.md");
const DONE_MD: &str = include_str!("done.md");
const PLAN_MD: &str = include_str!("plan.md");
const APP_MD: &str = include_str!("app.md");

/// A model family: the models one prompt suits, because they were trained the
/// same way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Family {
    Anthropic,
    Gpt,
    Codex,
    Kimi,
    Glm,
    DeepSeek,
    Grok,
    Generic,
}

/// How the model is told to change a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EditFormat {
    /// `patch` with `mode: "patch"` and a V4A body.
    V4a,
    /// `patch` in its default replace mode.
    Replace,
}

impl Family {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::Gpt => "gpt",
            Self::Codex => "codex",
            Self::Kimi => "kimi",
            Self::Glm => "glm",
            Self::DeepSeek => "deepseek",
            Self::Grok => "grok",
            Self::Generic => "generic",
        }
    }

    /// The GPT and Codex models are trained on the `*** Begin Patch` format.
    pub(crate) fn edit_format(self) -> EditFormat {
        match self {
            Self::Gpt | Self::Codex => EditFormat::V4a,
            _ => EditFormat::Replace,
        }
    }

    fn style(self) -> &'static str {
        match self {
            Self::Anthropic => include_str!("anthropic.md"),
            Self::Gpt => include_str!("gpt.md"),
            Self::Codex => include_str!("codex.md"),
            Self::Kimi => include_str!("kimi.md"),
            Self::Glm => include_str!("glm.md"),
            Self::DeepSeek => include_str!("deepseek.md"),
            Self::Grok => include_str!("grok.md"),
            Self::Generic => include_str!("generic.md"),
        }
    }
}

impl EditFormat {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::V4a => "v4a",
            Self::Replace => "replace",
        }
    }

    fn notes(self) -> &'static str {
        match self {
            Self::V4a => EDIT_V4A_MD,
            Self::Replace => EDIT_REPLACE_MD,
        }
    }
}

/// The family of a Carpe Diem model id, as `/v1/models` lists it. Accepts the
/// reasoning-effort alias the desktop hands the runtime
/// (`kimi-k2-7-code@reasoning-effort=high`, ADR-0080) and the `e2ee-` builds
/// of the same models.
pub(crate) fn family_for_model(model: &str) -> Family {
    let bare = model.split('@').next().unwrap_or(model).trim();
    let lower = bare.to_ascii_lowercase();
    let id = lower.strip_prefix("e2ee-").unwrap_or(&lower);
    if id.contains("codex") {
        Family::Codex
    } else if id.starts_with("openai-gpt-") || id.starts_with("gpt-") {
        Family::Gpt
    } else if id.starts_with("claude-") {
        Family::Anthropic
    } else if id.starts_with("kimi-") {
        Family::Kimi
    } else if id.starts_with("glm-") || id.contains("-glm-") {
        Family::Glm
    } else if id.starts_with("deepseek-") {
        Family::DeepSeek
    } else if id.starts_with("grok-") {
        Family::Grok
    } else {
        Family::Generic
    }
}

/// Where the block is read.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Surface<'a> {
    /// A chat in Code mode on `folder`, in the app.
    App { folder: &'a str },
    /// A `subrosa-code run`; `plan` when the folder is read-only.
    Cli { plan: bool },
}

/// The whole block for `model` on `surface`.
pub(crate) fn code_block(model: &str, surface: Surface<'_>) -> String {
    let family = family_for_model(model);
    let format = family.edit_format();
    let mut parts: Vec<String> = vec![
        format!(
            "<!-- Sub Rosa {CODE_PROMPT_VERSION}, family {}, edits {} -->",
            family.as_str(),
            format.as_str()
        ),
        family.style().trim().to_string(),
        CODE_MD.trim().to_string(),
    ];
    let plan = matches!(surface, Surface::Cli { plan: true });
    if !plan {
        parts.push(format.notes().trim().to_string());
    }
    if let Surface::App { folder } = surface {
        parts.push(APP_MD.trim().replace("{folder}", folder));
    }
    parts.push(if plan { PLAN_MD } else { DONE_MD }.trim().to_string());
    parts.join("\n\n")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodePromptRequest {
    /// The chat's stored session id; absent for a chat whose first message
    /// is being sent.
    #[serde(default)]
    pub session_id: Option<String>,
    pub folder: String,
    /// The model, when the caller knows it better than the session row.
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodePrompt {
    pub block: String,
    pub model: String,
    pub family: &'static str,
    pub edit_format: &'static str,
    pub version: &'static str,
}

fn prompt_for(model: String, folder: &str) -> CodePrompt {
    let family = family_for_model(&model);
    CodePrompt {
        block: code_block(&model, Surface::App { folder }),
        family: family.as_str(),
        edit_format: family.edit_format().as_str(),
        version: CODE_PROMPT_VERSION,
        model,
    }
}

/// The Code mode block for the next message of a chat, for the model that
/// will answer it: the one the caller names, else the model the runtime
/// recorded for the session (Hermes keeps `sessions.model` current when a
/// chat switches model), else the chat default a new chat starts on.
#[tauri::command]
pub async fn code_prompt_block(
    app: AppHandle,
    request: CodePromptRequest,
) -> Result<CodePrompt, AppError> {
    let named = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string);
    let model = match named {
        Some(model) => model,
        None => match request.session_id.as_deref() {
            Some(session_id) => session_model(&app, session_id).await,
            None => None,
        }
        .unwrap_or_else(crate::providers::generation_model),
    };
    Ok(prompt_for(model, &request.folder))
}

/// The model `state.db` records for a session, read-only. `None` whenever the
/// row, the file or the column is missing: the caller has a default.
async fn session_model(app: &AppHandle, session_id: &str) -> Option<String> {
    let path = crate::commands::app_paths(app)
        .ok()?
        .data_dir
        .join("hermes")
        .join("state.db");
    session_model_at(&path, session_id).await
}

async fn session_model_at(path: &std::path::Path, session_id: &str) -> Option<String> {
    use sqlx::connection::Connection as _;
    if !path.exists() {
        return None;
    }
    let options = sqlx_sqlite::SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    let mut connection = sqlx_sqlite::SqliteConnection::connect_with(&options)
        .await
        .ok()?;
    let model: Option<Option<String>> =
        sqlx::query_scalar::query_scalar("SELECT model FROM sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(&mut connection)
            .await
            .ok();
    let _ = connection.close().await;
    model
        .flatten()
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const FAMILY_CASES: &str = include_str!("family-cases.json");
    /// Strings `.github/workflows/repository-hygiene.yml` rejects, and the
    /// identities the block must never take.
    const FORBIDDEN: &[&str] = &[
        "opensoftware.co",
        "os-june-releases",
        "You are June",
        "made by Open Software",
        "You are opencode",
        "You are OpenCode",
        "You are Hermes",
        "June",
        "opencode",
        "OpenCode",
        "TodoWrite",
        "apply_patch",
    ];

    fn every_block() -> Vec<String> {
        let models = [
            "claude-sonnet-5-5",
            "openai-gpt-55",
            "openai-gpt-53-codex",
            "kimi-k2-7-code",
            "e2ee-glm-5-2-p",
            "deepseek-v4-pro",
            "grok-4-7",
            "qwen3-coder-480b-a35b-instruct-turbo",
        ];
        let mut blocks = Vec::new();
        for model in models {
            blocks.push(code_block(
                model,
                Surface::App {
                    folder: "/work/repo",
                },
            ));
            blocks.push(code_block(model, Surface::Cli { plan: false }));
            blocks.push(code_block(model, Surface::Cli { plan: true }));
        }
        blocks
    }

    #[test]
    fn every_catalog_case_gets_its_family_and_edit_format() {
        let fixture: serde_json::Value = serde_json::from_str(FAMILY_CASES).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 20);
        for case in cases {
            let model = case["model"].as_str().unwrap();
            let family = family_for_model(model);
            assert_eq!(family.as_str(), case["family"], "{model}");
            assert_eq!(family.edit_format().as_str(), case["editFormat"], "{model}");
        }
    }

    #[test]
    fn every_family_is_reached_by_a_catalog_case() {
        let fixture: serde_json::Value = serde_json::from_str(FAMILY_CASES).unwrap();
        for family in [
            Family::Anthropic,
            Family::Gpt,
            Family::Codex,
            Family::Kimi,
            Family::Glm,
            Family::DeepSeek,
            Family::Grok,
            Family::Generic,
        ] {
            assert!(
                fixture["cases"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|case| case["family"] == family.as_str()),
                "{family:?}"
            );
        }
    }

    #[test]
    fn the_reasoning_effort_alias_and_case_do_not_change_the_family() {
        assert_eq!(
            family_for_model("kimi-k2-7-code@reasoning-effort=high"),
            Family::Kimi
        );
        assert_eq!(
            family_for_model("OpenAI-GPT-55@reasoning-effort=low"),
            Family::Gpt
        );
        assert_eq!(family_for_model(" claude-opus-5-5 "), Family::Anthropic);
        assert_eq!(family_for_model(""), Family::Generic);
    }

    #[test]
    fn gpt_and_codex_are_told_v4a_and_the_others_search_and_replace() {
        for model in ["openai-gpt-55", "openai-gpt-53-codex"] {
            let block = code_block(model, Surface::Cli { plan: false });
            assert!(block.contains(r#"`mode: "patch"`"#), "{model}");
            assert!(block.contains("*** Begin Patch"), "{model}");
            assert!(!block.contains("Do not use `mode: \"patch\"`"), "{model}");
        }
        for model in ["claude-sonnet-5-5", "kimi-k2-7-code", "e2ee-glm-5-2-p"] {
            let block = code_block(model, Surface::Cli { plan: false });
            assert!(block.contains("Do not use `mode: \"patch\"`"), "{model}");
            assert!(!block.contains("*** Begin Patch"), "{model}");
        }
    }

    #[test]
    fn every_block_carries_the_version_the_stop_rule_and_no_forbidden_string() {
        for block in every_block() {
            assert!(block.starts_with(&format!("<!-- Sub Rosa {CODE_PROMPT_VERSION},")));
            assert!(block.contains("## When you are done"));
            assert!(block.trim_end().ends_with('.'));
            for forbidden in FORBIDDEN {
                assert!(!block.contains(forbidden), "{forbidden:?} in a code block");
            }
            assert!(!block.contains('\u{2013}') && !block.contains('\u{2014}'));
            // Every tool the notes name is one the runtime has.
            for tool in [
                "`patch`",
                "`write_file`",
                "`read_file`",
                "`search_files`",
                "`terminal`",
            ] {
                assert!(block.contains(tool), "{tool} missing");
            }
        }
    }

    #[test]
    fn the_stop_rule_comes_last_and_a_plan_run_is_not_told_to_edit() {
        let build = code_block("kimi-k2-7-code", Surface::Cli { plan: false });
        let done = build.find("## When you are done").unwrap();
        assert!(build.find("## Editing files").unwrap() < done);
        assert!(build.contains("Check once."));
        let plan = code_block("kimi-k2-7-code", Surface::Cli { plan: true });
        assert!(plan.contains("This is a plan run"));
        assert!(!plan.contains("## Editing files"));
        assert!(!plan.contains("Check once."));
    }

    #[test]
    fn the_app_block_names_the_folder_the_review_and_overrides_the_long_task_note() {
        let block = code_block(
            "claude-sonnet-5-5",
            Surface::App {
                folder: "/Users/me/project",
            },
        );
        assert!(block.contains("Code mode is on for this chat."));
        assert!(block.contains("The working folder /Users/me/project is"));
        assert!(block.contains("keep or revert"));
        assert!(block.contains("long-running work note"));
        assert!(!block.contains("{folder}"));
        // The CLI is not a chat and has no review panel.
        let cli = code_block("claude-sonnet-5-5", Surface::Cli { plan: false });
        assert!(!cli.contains("Code mode is on"));
    }

    #[test]
    fn the_command_answers_with_the_family_it_used() {
        let prompt = prompt_for("openai-gpt-53-codex".into(), "/repo");
        assert_eq!(prompt.family, "codex");
        assert_eq!(prompt.edit_format, "v4a");
        assert_eq!(prompt.version, CODE_PROMPT_VERSION);
        assert!(prompt.block.contains("/repo"));
        let json = serde_json::to_value(&prompt).unwrap();
        assert_eq!(json["editFormat"], "v4a");
    }

    #[tokio::test]
    async fn the_session_model_is_read_from_the_runtime_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        assert_eq!(session_model_at(&path, "s1").await, None);
        let status = std::process::Command::new("sqlite3")
            .arg(&path)
            .arg(
                "CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT); \
                 INSERT INTO sessions VALUES ('s1', 'openai-gpt-55@reasoning-effort=high'), ('s2', NULL);",
            )
            .status();
        if !status.is_ok_and(|status| status.success()) {
            eprintln!("sqlite3 is not available; skipped");
            return;
        }
        assert_eq!(
            session_model_at(&path, "s1").await.as_deref(),
            Some("openai-gpt-55@reasoning-effort=high")
        );
        assert_eq!(session_model_at(&path, "s2").await, None);
        assert_eq!(session_model_at(&path, "nope").await, None);
    }
}
