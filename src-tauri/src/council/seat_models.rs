//! Which model a seat runs on, when the user has said.
//!
//! Seats are assigned automatically ([`super::seats::assign_models`]): the
//! configured model first, then whatever the catalog offers, one family per
//! seat. That is a good default and it is not an opinion. Someone who knows
//! that one model argues well and another flatters wants to say so, and until
//! now the roster was the app's to decide.
//!
//! A pin is per seat and optional. Unpinned seats keep the automatic
//! assignment, so pinning one seat does not turn the whole roster into a form
//! to fill in. Two rules survive the user:
//!
//! - **The family rule still reports.** Pinning two seats onto one family is
//!   allowed and named: the plan's `reusedFamilies` covers pinned seats exactly
//!   as it covers automatic ones, and the sitting already warns when two seats
//!   share weights. Diversity is the point of a council, so it is measured,
//!   not enforced by refusing the user.
//! - **A verdict never runs on the author's weights** (ADR-0034). That is an
//!   invariant, not a preference, so a pin that collides with the model the
//!   work was written on is dropped for that sitting and the seat is assigned
//!   around it. The pin stays saved; it simply does not apply to a sitting it
//!   would corrupt.
//!
//! A pinned model that has left the catalog is ignored the same way, because a
//! seat on a model the operator no longer serves is a sitting that fails at the
//! first call.

use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager, State};

use crate::domain::types::AppError;

const SETTINGS_FILE: &str = "council.json";

/// A model id is short. This is a bound on text arriving over IPC, not a limit
/// anyone will meet.
const MAX_MODEL_CHARS: usize = 256;

static SETTINGS: OnceLock<Mutex<SeatModels>> = OnceLock::new();

/// Seat id to model id. Absent means "assign this one automatically", which is
/// why a cleared pin is a removal rather than an empty string.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct SeatModels {
    pub seats: BTreeMap<String, String>,
}

/// Managed state: only the on-disk path; live values sit in [`SETTINGS`].
pub struct SeatModelState {
    config_path: PathBuf,
}

pub fn setup(app: &mut tauri::App) {
    let path = settings_path(app.handle());
    replace_mirror(load_from_disk(path.as_deref()));
    app.manage(SeatModelState {
        config_path: path.unwrap_or_else(|| PathBuf::from(SETTINGS_FILE)),
    });
}

/// Current pins, readable from any thread: the roster is built outside command
/// context.
pub fn pins() -> SeatModels {
    mirror()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone()
}

/// The pin for one seat, if it survives this catalog and this sitting.
///
/// `catalog` empty means the catalog could not be read, in which case a pin is
/// no more suspect than the automatic choice and is honoured.
pub fn pinned_model(
    pins: &SeatModels,
    seat_id: &str,
    catalog: &[String],
    avoid_family: Option<&str>,
) -> Option<String> {
    let model = pins.seats.get(seat_id)?.trim();
    if model.is_empty() {
        return None;
    }
    if !catalog.is_empty() && !catalog.iter().any(|id| id == model) {
        return None;
    }
    if let Some(avoided) = avoid_family {
        if super::seats::model_family(model).eq_ignore_ascii_case(avoided) {
            return None;
        }
    }
    Some(model.to_string())
}

fn mirror() -> &'static Mutex<SeatModels> {
    SETTINGS.get_or_init(|| Mutex::new(SeatModels::default()))
}

fn replace_mirror(next: SeatModels) {
    let mut guard = mirror().lock().unwrap_or_else(|poison| poison.into_inner());
    *guard = next;
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(SETTINGS_FILE))
}

fn load_from_disk(path: Option<&Path>) -> SeatModels {
    path.and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_default()
}

fn persist(path: &Path, settings: &SeatModels) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| AppError::new("council_settings_failed", error.to_string()))?;
    }
    let body = serde_json::to_string_pretty(settings)
        .map_err(|error| AppError::new("council_settings_failed", error.to_string()))?;
    std::fs::write(path, body)
        .map_err(|error| AppError::new("council_settings_failed", error.to_string()))
}

// --- IPC -------------------------------------------------------------------

#[tauri::command]
pub fn council_get_seat_models() -> SeatModels {
    pins()
}

/// Pins a seat to a model, or clears it when `model` is empty. Returns the
/// whole map so the caller never has to guess what it now holds.
#[tauri::command]
pub fn council_set_seat_model(
    state: State<'_, SeatModelState>,
    seat_id: String,
    model: String,
) -> Result<SeatModels, AppError> {
    let seat_id = seat_id.trim();
    if super::seats::template_for(seat_id).is_none() {
        return Err(AppError::new(
            "council_seat_unknown",
            format!("There is no seat called {seat_id}."),
        ));
    }
    let model = model.trim();
    if model.chars().count() > MAX_MODEL_CHARS {
        return Err(AppError::new(
            "council_model_invalid",
            "That is not a model id.",
        ));
    }

    let mut next = pins();
    if model.is_empty() {
        next.seats.remove(seat_id);
    } else {
        next.seats.insert(seat_id.to_string(), model.to_string());
    }
    persist(&state.config_path, &next)?;
    replace_mirror(next.clone());
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pins_with(seat: &str, model: &str) -> SeatModels {
        let mut pins = SeatModels::default();
        pins.seats.insert(seat.to_string(), model.to_string());
        pins
    }

    #[test]
    fn a_pin_is_used_when_the_catalog_still_serves_it() {
        let pins = pins_with("shape", "zai-org-glm-5-2");
        let catalog = vec!["zai-org-glm-5-2".to_string(), "kimi-k2-6".to_string()];
        assert_eq!(
            pinned_model(&pins, "shape", &catalog, None).as_deref(),
            Some("zai-org-glm-5-2")
        );
        // Another seat is unaffected: pinning one is not pinning all.
        assert!(pinned_model(&pins, "risk", &catalog, None).is_none());
    }

    #[test]
    fn a_pin_the_operator_no_longer_serves_is_dropped() {
        // Seating a council on a model that 404s is a sitting that dies at the
        // first call, which is worse than the automatic choice it replaced.
        let pins = pins_with("shape", "retired-model-1");
        let catalog = vec!["zai-org-glm-5-2".to_string()];
        assert!(pinned_model(&pins, "shape", &catalog, None).is_none());
        // An unreadable catalog is not evidence against the pin.
        assert_eq!(
            pinned_model(&pins, "shape", &[], None).as_deref(),
            Some("retired-model-1")
        );
    }

    #[test]
    fn a_pin_never_puts_a_judge_on_the_authors_weights() {
        // ADR-0034: a reviewer sharing weights with the author shares its blind
        // spots. That is an invariant, so the pin loses for this sitting.
        let pins = pins_with("conformance", "zai-org-glm-5-2");
        let catalog = vec!["zai-org-glm-5-2".to_string()];
        assert!(pinned_model(&pins, "conformance", &catalog, Some("glm")).is_none());
        // ...and applies for a sitting judging work written elsewhere.
        assert_eq!(
            pinned_model(&pins, "conformance", &catalog, Some("kimi")).as_deref(),
            Some("zai-org-glm-5-2")
        );
    }

    #[test]
    fn a_blank_pin_reads_as_no_pin() {
        let pins = pins_with("shape", "   ");
        assert!(pinned_model(&pins, "shape", &[], None).is_none());
    }
}
