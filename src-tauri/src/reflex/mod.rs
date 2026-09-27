//! Reflexes: typed, one-pass decisions from a decision model (ADR-0064).
//!
//! The app makes many small decisions that are neither worth a language
//! model nor worth asking the person: is this passage about the question,
//! is this fact already known, which of these two events was the meeting.
//! Until now they were made by rules (a bm25 cut, a `LIKE`, a list of English
//! strings) or by paying a full model call. A **reflex** asks a decision model
//! instead (Carpe Diem's `/v1/decisions`, served by Jev): one call, several
//! typed questions over one state, a probability for each answer, in under a
//! second, for a fraction of a chat call.
//!
//! Three rules hold everywhere a reflex is used:
//!
//! - **It sorts, filters and decides; it never writes.** No reflex produces
//!   text a person reads, and none changes text a person wrote.
//! - **It is never a dependency.** Every call site keeps the path it had
//!   before, and takes it whenever the reflex is off, unreachable, paused by
//!   the breaker, or unsure.
//! - **What it was sent is visible.** Every call is a ledger row (ADR-0043),
//!   and a surface that shows what it sent (Ask your notes, ADR-0044) also
//!   shows what it screened.
//!
//! The provider marks the model "anonymized", not "private": the request
//! leaves the Carpe Diem enclave for the model's operator, without the
//! person's identity. Reflexes are on by default and Settings › Privacy says
//! exactly that, next to the switch that turns them off.

pub mod client;
pub mod question;
pub mod screen;

use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::domain::types::AppError;

const SETTINGS_FILE: &str = "reflex.json";

static SETTINGS: OnceLock<Mutex<ReflexSettings>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ReflexSettings {
    pub enabled: bool,
    /// Whether the one-time notice that reflexes are on has been read. Kept
    /// here rather than in the webview's storage, which a person can clear
    /// without meaning to be told again.
    pub notice_seen: bool,
}

impl Default for ReflexSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            notice_seen: false,
        }
    }
}

/// A change to the settings: only what is named changes, so the switch in
/// Settings cannot bring the notice back and the notice cannot flip the
/// switch by accident.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflexSettingsChange {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub notice_seen: Option<bool>,
}

impl ReflexSettings {
    fn with(mut self, change: &ReflexSettingsChange) -> Self {
        if let Some(enabled) = change.enabled {
            self.enabled = enabled;
        }
        if let Some(seen) = change.notice_seen {
            self.notice_seen = seen;
        }
        self
    }
}

pub struct ReflexState {
    config_path: PathBuf,
}

fn mirror() -> &'static Mutex<ReflexSettings> {
    SETTINGS.get_or_init(|| Mutex::new(ReflexSettings::default()))
}

pub fn settings() -> ReflexSettings {
    mirror()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone()
}

fn replace_mirror(next: ReflexSettings) {
    *mirror().lock().unwrap_or_else(|poison| poison.into_inner()) = next;
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(SETTINGS_FILE))
}

fn load_from_disk(path: Option<&PathBuf>) -> ReflexSettings {
    path.and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn persist(path: &PathBuf, settings: &ReflexSettings) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| AppError::new("reflex_settings_save", error.to_string()))?;
    }
    let text = serde_json::to_string_pretty(settings)
        .map_err(|error| AppError::new("reflex_settings_save", error.to_string()))?;
    fs::write(path, text).map_err(|error| AppError::new("reflex_settings_save", error.to_string()))
}

pub fn setup(app: &mut tauri::App) {
    let path = settings_path(app.handle());
    replace_mirror(load_from_disk(path.as_ref()));
    app.manage(ReflexState {
        config_path: path.unwrap_or_else(|| PathBuf::from(SETTINGS_FILE)),
    });
}

#[tauri::command]
pub fn reflex_settings() -> ReflexSettings {
    settings()
}

#[tauri::command]
pub fn set_reflex_settings(
    app: AppHandle,
    request: ReflexSettingsChange,
) -> Result<ReflexSettings, AppError> {
    let next = settings().with(&request);
    let state = app.state::<ReflexState>();
    persist(&state.config_path, &next)?;
    replace_mirror(next.clone());
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::{ReflexSettings, ReflexSettingsChange};

    #[test]
    fn reflexes_are_on_by_default_and_a_missing_field_keeps_the_default() {
        assert!(ReflexSettings::default().enabled);
        let parsed: ReflexSettings = serde_json::from_str("{}").unwrap();
        assert!(parsed.enabled);
        let off: ReflexSettings = serde_json::from_str(r#"{"enabled":false}"#).unwrap();
        assert!(!off.enabled);
        assert!(
            !off.notice_seen,
            "a file from before the notice has not seen it"
        );
    }

    #[test]
    fn a_change_touches_only_what_it_names() {
        let seen = ReflexSettings::default().with(&ReflexSettingsChange {
            enabled: None,
            notice_seen: Some(true),
        });
        assert!(seen.enabled && seen.notice_seen);
        let off: ReflexSettingsChange = serde_json::from_str(r#"{"enabled":false}"#).unwrap();
        let next = seen.with(&off);
        assert!(!next.enabled);
        assert!(
            next.notice_seen,
            "the switch does not bring the notice back"
        );
    }
}
