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

use crate::domain::types::{AppError, MemoryDto, MemorySource};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager, State};

pub mod extract;
pub mod recall;

const SETTINGS_FILE: &str = "memory.json";
const MAX_MEMORY_CHARS: usize = 2_000;
/// Importance assigned to memories the user types in by hand: important by
/// definition (the user bothered), but below the extractor's 1-2 "essential"
/// tier so a hand-written trivia note cannot crowd out core facts.
const MANUAL_IMPORTANCE: i64 = 3;

static SETTINGS: OnceLock<Mutex<MemorySettings>> = OnceLock::new();

/// Non-secret memory settings persisted to `memory.json`. Missing fields
/// (older installs) default to on — memory is opt-out, like Venice's.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct MemorySettings {
    pub enabled: bool,
    pub auto_extract: bool,
}

impl Default for MemorySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            auto_extract: true,
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
/// extraction paths call this outside command context).
pub fn settings() -> MemorySettings {
    *mirror().lock().unwrap_or_else(|poison| poison.into_inner())
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
    if !settings().enabled {
        return None;
    }
    let memories = repos.top_memories(INJECTED_MEMORY_LIMIT).await.ok()?;
    format_memory_block(&memories)
}

/// [`prompt_block`] for callers that only hold an [`AppHandle`] (the Hermes
/// spawn path). Best-effort: any storage error yields `None`.
pub async fn prompt_block_for_app(app: &AppHandle) -> Option<String> {
    if !settings().enabled {
        return None;
    }
    let repos = crate::commands::repositories(app).await.ok()?;
    prompt_block(&repos).await
}

fn format_memory_block(memories: &[MemoryDto]) -> Option<String> {
    if memories.is_empty() {
        return None;
    }
    let mut block = String::from(
        "User memory: durable facts remembered from the user's previous conversations \
         (managed by the user in Settings). Use them so the user never has to repeat \
         themselves. What the user says now always overrides a remembered fact, and you \
         should not recite this list unprompted.\n",
    );
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
    };
    persist(&state.config_path, &next)?;
    replace_mirror(next);
    Ok(next)
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
        };
        let block = format_memory_block(&[memory]).expect("block");
        assert!(block.starts_with("User memory:"));
        assert!(block.contains("- Répond toujours en français."));
        assert!(block.contains("overrides a remembered fact"));
    }
}
