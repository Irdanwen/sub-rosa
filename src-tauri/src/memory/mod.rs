//! Cross-conversation user memory (fork addition).
//!
//! Durable facts about the user ("prefers French", "works on the Lexion
//! project") extracted from agent chats or added manually, stored in the
//! local SQLite `memories` table, and injected into the system prompt of
//! future conversations — desktop (Hermes SOUL.md) and mobile (agent-lite)
//! alike. Everything persists on the user's disk only; the extraction call
//! travels through the same chat-completions proxy as any chat message.
//!
//! Two non-secret toggles persist to `memory.json` in the app config dir
//! (same pattern as `carpe_diem::settings`):
//! - `enabled` — master switch: no injection, no extraction, no recall.
//! - `auto_extract` — automatic extraction after chat turns; manual adds
//!   still work when this is off.
//! - `reference_chat_history` — excerpts of the user's other chats ride along
//!   with a turn, and a `search_past_chats` tool reaches further back
//!   ([`past_chats`], ADR-0081). Only meaningful while `enabled` is on.
//!
//! Protected mode can hold memory or past chats off (ADR-0084 addendum):
//! [`settings`], which every seam reads, answers with them off while it does,
//! whatever the file says, and the file keeps the person's own choice.

use crate::domain::types::{AppError, MemoryDto, MemorySource};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager, State};

pub mod consolidate;
pub mod extract;
pub mod past_chats;
pub mod recall;
pub mod sources;

const SETTINGS_FILE: &str = "memory.json";
const MAX_MEMORY_CHARS: usize = 2_000;
/// Importance assigned to memories the user types in by hand: important by
/// definition (the user bothered), but below the extractor's 1-2 "essential"
/// tier so a hand-written trivia note cannot crowd out core facts.
const MANUAL_IMPORTANCE: i64 = 3;

static SETTINGS: OnceLock<Mutex<MemorySettings>> = OnceLock::new();

/// Non-secret memory settings persisted to `memory.json`. Missing fields
/// (older installs) default to on — memory is opt-out, like Venice's.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct MemorySettings {
    pub enabled: bool,
    pub auto_extract: bool,
    /// The model the extraction prompt runs on. `None` means the chat's own
    /// model, which is what it always was; a smaller one is cheaper and
    /// extraction is a classification task, not a conversation (ADR-0009
    /// called this "a later knob").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extraction_model: Option<String>,
    /// Whether the user's other chats are consulted ("reference chat
    /// history"). On by default with memory itself (ADR-0081).
    pub reference_chat_history: bool,
    /// Protected mode holds memory or past chats off right now. Reported to
    /// the settings screens, never read from or written to the file.
    #[serde(skip_deserializing, skip_serializing_if = "is_false")]
    pub held_by_protected_mode: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl Default for MemorySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            auto_extract: true,
            extraction_model: None,
            reference_chat_history: true,
            held_by_protected_mode: false,
        }
    }
}

/// Managed state: only the on-disk path; live values sit in [`SETTINGS`].
pub struct MemoryState {
    config_path: PathBuf,
}

pub fn setup(app: &mut tauri::App) {
    let path = settings_path(app.handle());
    replace_mirror(load_from_disk(path.as_ref()));
    app.manage(MemoryState {
        config_path: path.unwrap_or_else(|| PathBuf::from(SETTINGS_FILE)),
    });
    // Catch up on vectors for memories whose embedding call failed earlier
    // (offline adds, key set after the fact). No-op when nothing is pending.
    recall::spawn_backfill(app.handle());
}

/// Current settings snapshot, readable from any thread (the injection and
/// extraction paths call this outside command context). These are the
/// settings in force: protected mode's switches applied over the file's.
pub fn settings() -> MemorySettings {
    in_force(stored(), crate::protected_mode::restrictions())
}

/// What the file says, before protected mode.
fn stored() -> MemorySettings {
    mirror()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone()
}

fn in_force(
    mut settings: MemorySettings,
    restrictions: crate::protected_mode::Restrictions,
) -> MemorySettings {
    if restrictions.memory_off && settings.enabled {
        settings.enabled = false;
        settings.held_by_protected_mode = true;
    }
    if restrictions.past_chats_off && settings.reference_chat_history {
        settings.reference_chat_history = false;
        settings.held_by_protected_mode = true;
    }
    settings
}

// --- Prompt injection --------------------------------------------------------

/// How many memories ride along in every system prompt. Anything beyond the
/// top of the ranking stays reachable through on-demand recall (the
/// `june_context` MCP on desktop, the `search_memories` tool on mobile).
pub const INJECTED_MEMORY_LIMIT: i64 = 20;

/// The "known facts" block injected into both chat pipelines (Hermes SOUL.md
/// and the agent-lite system prompt). `None` when memory is disabled, off, or
/// empty, so callers add nothing rather than an empty header.
pub async fn prompt_block(repos: &crate::db::repositories::Repositories) -> Option<String> {
    format_memory_block(&static_memories(repos).await?)
}

/// The memories of the static block; `None` when memory is off.
async fn static_memories(repos: &crate::db::repositories::Repositories) -> Option<Vec<MemoryDto>> {
    if !settings().enabled {
        return None;
    }
    repos.top_memories(INJECTED_MEMORY_LIMIT).await.ok()
}

/// The most important memories always ride along in a turn's block.
const CORE_MEMORIES: i64 = 8;
/// Memories chosen for what this turn is about, on top of the core.
const TURN_MEMORIES: usize = 12;
/// The most a turn waits for its memories before falling back to the
/// static block: a chat's first word must not wait on recall.
const TURN_RECALL_BUDGET: std::time::Duration = std::time::Duration::from_millis(2_500);

/// The memories of [`prompt_block`], chosen for the turn (ADR-0065). The
/// block itself is [`sources::block_for_turn`], which also records them.
///
/// While everything remembered fits in the static block, that block is the
/// answer and nothing is fetched. Past that, the static top-N left out
/// whatever was not "important" in general even when it was exactly what
/// this message is about. So the block becomes the core (most important) plus
/// the memories recall finds for the message and the relevance screen keeps.
/// Recall that is slow or fails falls back to the static block. `None` when
/// memory is off.
pub async fn memories_for_turn(
    repos: &crate::db::repositories::Repositories,
    message: &str,
) -> Option<Vec<MemoryDto>> {
    if !settings().enabled {
        return None;
    }
    let mut all = repos.top_memories(INJECTED_MEMORY_LIMIT + 1).await.ok()?;
    if all.len() as i64 <= INJECTED_MEMORY_LIMIT || message.trim().is_empty() {
        all.truncate(INJECTED_MEMORY_LIMIT as usize);
        return Some(all);
    }
    let relevant = tokio::time::timeout(
        TURN_RECALL_BUDGET,
        recall::recall(repos, message, TURN_MEMORIES),
    )
    .await;
    let Ok(Ok(relevant)) = relevant else {
        return static_memories(repos).await;
    };
    let mut chosen = repos.top_memories(CORE_MEMORIES).await.ok()?;
    for memory in relevant {
        if !chosen.iter().any(|m| m.id == memory.id) {
            chosen.push(memory);
        }
    }
    Some(chosen)
}

/// The block of [`memories_for_turn`], without recording which went out
/// (agent-lite goes through [`sources::block_for_turn`], which does).
pub async fn prompt_block_for_turn(
    repos: &crate::db::repositories::Repositories,
    message: &str,
) -> Option<String> {
    format_memory_block(&memories_for_turn(repos, message).await?)
}

/// [`prompt_block`] for callers that only hold an [`AppHandle`] (the Hermes
/// spawn path). Best-effort: any storage error yields `None`. What it hands
/// the SOUL is noted as the runtime's injection, so a chat can later say which
/// memories it was given ([`sources::note_soul_injection`]).
pub async fn prompt_block_for_app(app: &AppHandle) -> Option<String> {
    let repos = crate::commands::repositories(app).await.ok()?;
    let memories = static_memories(&repos).await.unwrap_or_default();
    sources::note_soul_injection(memories.iter().map(|memory| memory.id.clone()).collect());
    format_memory_block(&memories)
}

/// The line that opens the memory block. The web client reads it from the
/// export in `agent_lite::web_client_export`, so both say the same.
pub(crate) const MEMORY_BLOCK_HEADER: &str =
    "User memory: durable facts remembered from the user's previous conversations \
     (managed by the user in Settings). Use them so the user never has to repeat \
     themselves. What the user says now always overrides a remembered fact, and you \
     should not recite this list unprompted.\n";

pub(crate) fn format_memory_block(memories: &[MemoryDto]) -> Option<String> {
    if memories.is_empty() {
        return None;
    }
    let mut block = String::from(MEMORY_BLOCK_HEADER);
    for memory in memories {
        block.push_str("- ");
        block.push_str(&memory.text);
        block.push('\n');
    }
    Some(block)
}

// --- IPC commands ----------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMemorySettingsRequest {
    pub enabled: bool,
    pub auto_extract: bool,
    #[serde(default)]
    pub extraction_model: Option<String>,
    /// Absent from callers that predate it, which keeps the stored value.
    #[serde(default)]
    pub reference_chat_history: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddMemoryRequest {
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMemoryRequest {
    pub memory_id: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub disabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteMemoryRequest {
    pub memory_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryListResponse {
    pub items: Vec<MemoryDto>,
    pub settings: MemorySettings,
}

#[tauri::command]
pub fn memory_get_settings() -> MemorySettings {
    settings()
}

#[tauri::command]
pub fn memory_set_settings(
    state: State<'_, MemoryState>,
    request: SetMemorySettingsRequest,
) -> Result<MemorySettings, AppError> {
    let next = MemorySettings {
        enabled: request.enabled,
        auto_extract: request.auto_extract,
        extraction_model: request
            .extraction_model
            .map(|model| model.trim().to_string())
            .filter(|model| !model.is_empty()),
        reference_chat_history: request
            .reference_chat_history
            .unwrap_or_else(|| stored().reference_chat_history),
        held_by_protected_mode: false,
    };
    persist(&state.config_path, &next)?;
    replace_mirror(next.clone());
    Ok(in_force(next, crate::protected_mode::restrictions()))
}

#[tauri::command]
pub async fn memory_list(app: AppHandle) -> Result<MemoryListResponse, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    Ok(MemoryListResponse {
        items: repos.list_memories().await?,
        settings: settings(),
    })
}

#[tauri::command]
pub async fn memory_add(app: AppHandle, request: AddMemoryRequest) -> Result<MemoryDto, AppError> {
    let text = validate_memory_text(&request.text)?;
    let repos = crate::commands::repositories(&app).await?;
    if repos.memory_with_text_exists(&text).await? {
        return Err(AppError::new(
            "memory_duplicate",
            "That memory is already saved.",
        ));
    }
    let memory = repos
        .insert_memory(&text, MemorySource::Manual, MANUAL_IMPORTANCE)
        .await?;
    recall::spawn_backfill(&app);
    Ok(memory)
}

#[tauri::command]
pub async fn memory_update(
    app: AppHandle,
    request: UpdateMemoryRequest,
) -> Result<MemoryDto, AppError> {
    let text = match &request.text {
        Some(text) => Some(validate_memory_text(text)?),
        None => None,
    };
    let repos = crate::commands::repositories(&app).await?;
    repos
        .update_memory(&request.memory_id, text.as_deref(), request.disabled)
        .await
}

#[tauri::command]
pub async fn memory_delete(app: AppHandle, request: DeleteMemoryRequest) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    repos.delete_memory(&request.memory_id).await
}

/// "Forget everything" — deletes every memory. Disabling memory does NOT do
/// this (mirroring the Venice behavior); the user must ask explicitly.
#[tauri::command]
pub async fn memory_clear(app: AppHandle) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    repos.delete_all_memories().await?;
    Ok(())
}

// --- internals --------------------------------------------------------------

fn validate_memory_text(raw: &str) -> Result<String, AppError> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(AppError::new(
            "memory_text_required",
            "Enter the fact to remember.",
        ));
    }
    if text.chars().count() > MAX_MEMORY_CHARS {
        return Err(AppError::new(
            "memory_text_too_long",
            "Keep a memory under 2000 characters.",
        ));
    }
    Ok(text.to_string())
}

fn mirror() -> &'static Mutex<MemorySettings> {
    SETTINGS.get_or_init(|| Mutex::new(MemorySettings::default()))
}

fn replace_mirror(settings: MemorySettings) {
    let mut current = mirror().lock().unwrap_or_else(|poison| poison.into_inner());
    *current = settings;
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(SETTINGS_FILE))
}

fn load_from_disk(path: Option<&PathBuf>) -> MemorySettings {
    let Some(path) = path else {
        return MemorySettings::default();
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<MemorySettings>(&raw).ok())
        .unwrap_or_default()
}

fn persist(path: &PathBuf, settings: &MemorySettings) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| AppError::new("memory_settings_save", error.to_string()))?;
    }
    let serialized = serde_json::to_string_pretty(settings)
        .map_err(|error| AppError::new("memory_settings_save", error.to_string()))?;
    fs::write(path, serialized)
        .map_err(|error| AppError::new("memory_settings_save", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_to_fully_enabled() {
        let defaults = MemorySettings::default();
        assert!(defaults.enabled);
        assert!(defaults.auto_extract);
    }

    #[test]
    fn missing_settings_fields_default_on() {
        let parsed: MemorySettings = serde_json::from_str("{}").expect("parse");
        assert_eq!(parsed, MemorySettings::default());
        let parsed: MemorySettings = serde_json::from_str(r#"{"enabled":false}"#).expect("parse");
        assert!(!parsed.enabled);
        assert!(parsed.auto_extract);
        assert!(parsed.reference_chat_history);
    }

    #[test]
    fn reference_chat_history_round_trips_through_the_file() {
        let dir = std::env::temp_dir().join(format!("memory-settings-{}", uuid::Uuid::new_v4()));
        let path = dir.join(SETTINGS_FILE);
        let off = MemorySettings {
            reference_chat_history: false,
            ..MemorySettings::default()
        };
        persist(&path, &off).expect("persist");
        assert_eq!(load_from_disk(Some(&path)), off);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn protected_mode_holds_memory_and_past_chats_off_without_touching_the_file() {
        use crate::protected_mode::Restrictions;
        let mine = MemorySettings::default();
        assert_eq!(in_force(mine.clone(), Restrictions::default()), mine);
        let held = in_force(
            mine.clone(),
            Restrictions {
                memory_off: true,
                ..Restrictions::default()
            },
        );
        assert!(!held.enabled);
        assert!(held.held_by_protected_mode);
        let past = in_force(
            mine.clone(),
            Restrictions {
                past_chats_off: true,
                ..Restrictions::default()
            },
        );
        assert!(past.enabled);
        assert!(!past.reference_chat_history);
        assert!(past.held_by_protected_mode);
        // What is already off is the person's own choice, not a hold.
        let own = MemorySettings {
            enabled: false,
            ..MemorySettings::default()
        };
        let own = in_force(
            own,
            Restrictions {
                memory_off: true,
                ..Restrictions::default()
            },
        );
        assert!(!own.held_by_protected_mode);
        // The hold is reported, never stored, and never read back.
        let json = serde_json::to_value(&held).unwrap();
        assert_eq!(json["heldByProtectedMode"], serde_json::json!(true));
        let read: MemorySettings =
            serde_json::from_str(r#"{"enabled":true,"heldByProtectedMode":true}"#).unwrap();
        assert!(!read.held_by_protected_mode);
        assert!(serde_json::to_value(&mine)
            .unwrap()
            .get("heldByProtectedMode")
            .is_none());
    }

    #[test]
    fn validate_memory_text_trims_and_bounds() {
        assert_eq!(
            validate_memory_text("  speaks French  ").unwrap(),
            "speaks French"
        );
        assert!(validate_memory_text("   ").is_err());
        assert!(validate_memory_text(&"x".repeat(2_001)).is_err());
    }

    #[test]
    fn load_from_disk_falls_back_to_default_when_missing() {
        let missing = PathBuf::from("/nonexistent/memory.json");
        assert_eq!(load_from_disk(Some(&missing)), MemorySettings::default());
    }

    #[test]
    fn memory_block_lists_facts_and_hides_when_empty() {
        assert_eq!(format_memory_block(&[]), None);

        let memory = MemoryDto {
            id: "m1".to_string(),
            text: "Répond toujours en français.".to_string(),
            source: MemorySource::Auto,
            importance: 1,
            disabled: false,
            has_embedding: false,
            created_at: "2026-07-10T00:00:00.000Z".to_string(),
            updated_at: "2026-07-10T00:00:00.000Z".to_string(),
            scope: None,
        };
        let block = format_memory_block(&[memory]).expect("block");
        assert!(block.starts_with("User memory:"));
        assert!(block.contains("- Répond toujours en français."));
        assert!(block.contains("overrides a remembered fact"));
    }
}
