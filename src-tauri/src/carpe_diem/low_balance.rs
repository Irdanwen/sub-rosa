//! A heads-up when the Carpe Diem balance runs low, if the person asked for
//! one (Settings › Account, the Carpe Diem block).
//!
//! Nothing here polls. The app already reads the balance (`carpe_diem_get_credits`,
//! every minute while a window shows it, and at every launch and resume through
//! [`crate::background::sweep`]); each reading is handed to [`observe`], which
//! posts one notification when the balance crosses under the threshold and
//! stays quiet until it has climbed back over it by a tenth. Carpe Diem itself
//! sends partners no balance events (`docs/carpe-diem-partner-contract.md`).
//!
//! The notification says how much is left and nothing about where to buy:
//! some stores rule a purchase link out (`store-policy.ts`), and a sentence
//! pointing elsewhere is one.
use std::{path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::domain::types::AppError;

const FILE: &str = "carpe-diem-low-balance.json";
/// The thresholds offered, in credits (100 credits = $1).
pub const THRESHOLDS: [u32; 4] = [50, 100, 250, 500];

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LowBalance {
    /// Off when `None`, the default.
    pub threshold: Option<u32>,
    /// Already told for the current dip under the threshold.
    #[serde(default)]
    pub warned: bool,
}

static STATE: Mutex<Option<LowBalance>> = Mutex::new(None);

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
}

fn load(app: &AppHandle) -> LowBalance {
    path(app)
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<LowBalance>(&bytes).ok())
        .map(|state| LowBalance {
            threshold: state.threshold.filter(|t| THRESHOLDS.contains(t)),
            ..state
        })
        .unwrap_or_default()
}

fn save(app: &AppHandle, state: &LowBalance) -> Result<(), AppError> {
    let failed = || {
        AppError::new(
            "carpe_diem_settings_write",
            "Your settings could not be saved.",
        )
    };
    let path = path(app).ok_or_else(failed)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|_| failed())?;
    }
    let bytes = serde_json::to_vec(state).map_err(|_| failed())?;
    std::fs::write(path, bytes).map_err(|_| failed())
}

fn current(app: &AppHandle) -> LowBalance {
    let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
    *guard.get_or_insert_with(|| load(app))
}

/// Whether the person asked for the alert at all.
pub(crate) fn enabled(app: &AppHandle) -> bool {
    current(app).threshold.is_some()
}

/// One reading of the balance against the setting: the next state, and
/// whether to tell the person now. Pure, so the hysteresis is testable.
pub(crate) fn step(state: LowBalance, available: f64) -> (LowBalance, bool) {
    let Some(threshold) = state.threshold else {
        return (
            LowBalance {
                warned: false,
                ..state
            },
            false,
        );
    };
    if !available.is_finite() {
        return (state, false);
    }
    let threshold = f64::from(threshold);
    if available < threshold {
        (
            LowBalance {
                warned: true,
                ..state
            },
            !state.warned,
        )
    } else if available >= threshold + threshold / 10.0 {
        (
            LowBalance {
                warned: false,
                ..state
            },
            false,
        )
    } else {
        (state, false)
    }
}

/// Hands one balance reading to the alert. Best effort: a failure to save or
/// to post never reaches the caller, which only wanted the balance.
pub(crate) fn observe(app: &AppHandle, available: f64) {
    let notify = {
        let mut guard = STATE.lock().unwrap_or_else(|p| p.into_inner());
        let state = guard.get_or_insert_with(|| load(app));
        let (next, notify) = step(*state, available);
        if next != *state {
            *state = next;
            if save(app, &next).is_err() {
                tracing::warn!("low balance state not saved");
            }
        }
        notify
    };
    if notify {
        let credits = format!("{}", available.max(0.0).floor() as u64);
        let _ = app
            .notification()
            .builder()
            .title(crate::tr!("Your Carpe Diem balance is low"))
            .body(crate::tr!("{credits} credits left.", credits = credits))
            .show();
    }
}

#[tauri::command]
pub fn carpe_diem_low_balance(app: AppHandle) -> LowBalance {
    current(&app)
}

/// `None` turns the alert off. A new threshold starts unwarned, so a balance
/// already under it is said at the next reading.
#[tauri::command]
pub fn carpe_diem_set_low_balance(
    app: AppHandle,
    threshold: Option<u32>,
) -> Result<LowBalance, AppError> {
    if threshold.is_some_and(|t| !THRESHOLDS.contains(&t)) {
        return Err(AppError::new(
            "carpe_diem_low_balance_invalid",
            "Choose one of the thresholds offered.",
        ));
    }
    let next = LowBalance {
        threshold,
        warned: false,
    };
    save(&app, &next)?;
    *STATE.lock().unwrap_or_else(|p| p.into_inner()) = Some(next);
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ON: LowBalance = LowBalance {
        threshold: Some(100),
        warned: false,
    };

    #[test]
    fn it_tells_once_per_dip_and_again_only_after_a_real_climb() {
        let (state, told) = step(ON, 120.0);
        assert!(!told);
        let (state, told) = step(state, 99.0);
        assert!(told, "crossing under tells");
        let (state, told) = step(state, 40.0);
        assert!(!told, "further down stays quiet");
        // Back over the line by less than a tenth: a top-up of a few credits
        // or a refund rounding is not a new dip.
        let (state, told) = step(state, 105.0);
        assert!(!told && state.warned);
        let (state, told) = step(state, 95.0);
        assert!(!told, "no second alert for the same dip");
        let (state, _) = step(state, 110.0);
        assert!(!state.warned, "a tenth over the line rearms it");
        let (_, told) = step(state, 80.0);
        assert!(told);
    }

    #[test]
    fn off_says_nothing_and_a_reading_that_does_not_read_changes_nothing() {
        let off = LowBalance::default();
        assert_eq!(step(off, 0.0), (off, false));
        let warned = LowBalance { warned: true, ..ON };
        assert_eq!(step(warned, f64::NAN), (warned, false));
    }

    #[test]
    fn only_the_offered_thresholds_are_kept_from_disk() {
        let state: LowBalance = serde_json::from_str(r#"{"threshold":100}"#).unwrap();
        assert_eq!(state, ON);
        assert!(THRESHOLDS.contains(&50) && !THRESHOLDS.contains(&7));
    }
}
