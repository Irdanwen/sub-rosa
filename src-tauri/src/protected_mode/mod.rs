//! Protected mode: the local equivalent of parental controls (ADR-0084).
//!
//! While it is on, behind a PIN of four to six digits:
//! - every model picker leaves out adult and uncensored families
//!   ([`guards::is_adult_model`]), and the request paths refuse them
//!   ([`guard_media_request`], [`check_model`]), so a remembered choice or a
//!   crafted call cannot reach one either;
//! - every Studio picture request leaves with `safe_mode: true`, forced in the
//!   media proxy rather than asked of the webview;
//! - both chat shells carry a protective instruction, at the memory seams of
//!   ADR-0081 (the desktop SOUL's personal section, the phone's per-turn
//!   system prompt);
//! - the parental-control switches ([`restrictions`]: quiet hours, memory,
//!   image and video generation, voice, past chats) take effect, and changing
//!   them takes the PIN too;
//! - turning it off takes the PIN.
//!
//! Stored in `protected-mode.json` next to the other settings files, on this
//! device only. It guards against casual change by someone using the app, not
//! against someone who can edit the app's files: the ADR is explicit about it.

pub mod guards;
pub mod pin;
pub mod restrictions;

use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Instant,
};
use tauri::{AppHandle, Manager, State};

pub use guards::{is_adult_model, is_adult_model_id};
pub use restrictions::Restrictions;

const SETTINGS_FILE: &str = "protected-mode.json";

static SETTINGS: OnceLock<Mutex<ProtectedModeSettings>> = OnceLock::new();

/// The settings file. The PIN is never stored, only its hash.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProtectedModeSettings {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pin: Option<pin::PinHash>,
    /// Kept while protected mode is off, so turning it back on restores
    /// them, but in force only while it is on.
    pub restrictions: Restrictions,
}

/// What the webview may know: whether it is on, its switches, and whether
/// quiet hours are on right now. Never the hash.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedModeStatus {
    pub enabled: bool,
    pub restrictions: Restrictions,
    pub quiet_now: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedModePinRequest {
    pub pin: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectedModeRestrictionsRequest {
    pub pin: String,
    pub restrictions: Restrictions,
}

/// Whether protected mode is on right now. Read on every guarded request.
pub fn is_on() -> bool {
    current().enabled
}

/// Refuses an adult model while protected mode is on.
pub fn check_model(model: Option<&str>) -> Result<(), AppError> {
    guards::check_model(model, is_on())
}

/// The switches in force: the stored ones while protected mode is on, none
/// while it is off.
pub fn restrictions() -> Restrictions {
    restrictions_of(&current())
}

fn restrictions_of(settings: &ProtectedModeSettings) -> Restrictions {
    if settings.enabled {
        settings.restrictions
    } else {
        Restrictions::default()
    }
}

/// What the chat proxy asks of every request: no adult model, and not
/// during quiet hours.
pub fn check_chat(model: Option<&str>) -> Result<(), AppError> {
    check_model(model)?;
    restrictions::check_chat(&restrictions(), restrictions::local_minute())
}

/// Refuses a voice conversation while protected mode turns voice off, or
/// during quiet hours (ADR-0084 addendum, ADR-0093).
pub fn check_voice() -> Result<(), AppError> {
    restrictions::check_voice(&restrictions(), restrictions::local_minute())
}

/// The media proxy's body as it may leave (see [`guards::guard_media_body`]),
/// after the quiet hours and the image and video switch.
pub fn guard_media_request(
    path: &str,
    body: Option<&serde_json::Value>,
) -> Result<Option<serde_json::Value>, AppError> {
    restrictions::check_media(
        path,
        body.is_some(),
        &restrictions(),
        restrictions::local_minute(),
    )?;
    guards::guard_media_body(path, body, is_on())
}

/// The protective block for the prompt seams, or `None` while off.
pub fn prompt_block() -> Option<String> {
    guards::prompt_block(is_on())
}

/// The phone's system prompt with the protective block when it is on. It
/// applies after the prompt is chosen, so a custom assistant carries it too.
pub fn guard_system_prompt(prompt: String) -> String {
    guards::guard_system_prompt(prompt, is_on())
}

/// The Studio catalog without adult families while protected mode is on,
/// flagged so the webview drops the unlisted passthroughs it adds itself.
pub fn filter_media_catalog(
    catalog: crate::carpe_diem::media::MediaCatalogDto,
) -> crate::carpe_diem::media::MediaCatalogDto {
    filter_media_catalog_with(catalog, is_on())
}

fn filter_media_catalog_with(
    mut catalog: crate::carpe_diem::media::MediaCatalogDto,
    enabled: bool,
) -> crate::carpe_diem::media::MediaCatalogDto {
    if enabled {
        catalog
            .models
            .retain(|model| !is_adult_model(&model.id, &model.name, &model.traits));
        catalog.protected_mode = true;
    }
    catalog
}

/// The chat catalog without adult families while protected mode is on.
pub fn filter_chat_models(models: &mut Vec<crate::providers::VeniceModelDto>) {
    if is_on() {
        models.retain(|model| !is_adult_model(&model.id, &model.name, &model.traits));
    }
}

// --- Settings ----------------------------------------------------------------

pub struct ProtectedModeState {
    config_path: PathBuf,
}

pub fn setup(app: &mut tauri::App) {
    let path = app
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(SETTINGS_FILE));
    replace_mirror(load_from_disk(path.as_deref()));
    app.manage(ProtectedModeState {
        config_path: path.unwrap_or_else(|| PathBuf::from(SETTINGS_FILE)),
    });
}

#[tauri::command]
pub fn protected_mode_status() -> ProtectedModeStatus {
    status_of(&current())
}

/// Turns protected mode on with a new PIN. The chat default drops an adult
/// model, so the next chat does not start on one.
#[tauri::command]
pub async fn protected_mode_enable(
    app: AppHandle,
    state: State<'_, ProtectedModeState>,
    providers: State<'_, crate::providers::ProviderSettingsState>,
    request: ProtectedModePinRequest,
) -> Result<ProtectedModeStatus, AppError> {
    let current = current();
    let next = tauri::async_runtime::spawn_blocking(move || turned_on(&current, &request.pin))
        .await
        .map_err(|_| save_failed())??;
    persist(&state.config_path, &next)?;
    replace_mirror(next.clone());
    crate::providers::drop_adult_generation_model(&providers)?;
    after_change(&app).await;
    Ok(status_of(&next))
}

/// Turns protected mode off. Takes the PIN.
#[tauri::command]
pub async fn protected_mode_disable(
    app: AppHandle,
    state: State<'_, ProtectedModeState>,
    request: ProtectedModePinRequest,
) -> Result<ProtectedModeStatus, AppError> {
    if !is_on() {
        return Ok(status_of(&current()));
    }
    verify_pin(request.pin).await?;
    let next = turned_off(&current());
    persist(&state.config_path, &next)?;
    replace_mirror(next.clone());
    after_change(&app).await;
    Ok(status_of(&next))
}

/// Changes the switches. Takes the PIN while protected mode is on; while it
/// is off there is no PIN, and the switches wait for the next "turn on".
#[tauri::command]
pub async fn protected_mode_set_restrictions(
    app: AppHandle,
    state: State<'_, ProtectedModeState>,
    request: ProtectedModeRestrictionsRequest,
) -> Result<ProtectedModeStatus, AppError> {
    restrictions::validate(&request.restrictions)?;
    verify_pin(request.pin).await?;
    let next = ProtectedModeSettings {
        restrictions: request.restrictions,
        ..current()
    };
    persist(&state.config_path, &next)?;
    replace_mirror(next.clone());
    after_change(&app).await;
    Ok(status_of(&next))
}

/// The model switch of an open desktop chat goes from the webview to the
/// runtime directly, so it asks here first (the chat proxy still refuses an
/// adult model on every request that follows).
#[tauri::command]
pub fn protected_mode_check_model(model: String) -> Result<(), AppError> {
    check_model(Some(&model))
}

/// Checks the PIN without changing anything, for a screen that asks for it
/// before a protected change.
#[tauri::command]
pub async fn protected_mode_verify(
    request: ProtectedModePinRequest,
) -> Result<ProtectedModeStatus, AppError> {
    verify_pin(request.pin).await?;
    Ok(status_of(&current()))
}

/// Ok when protected mode is off, or when `candidate` is its PIN.
async fn verify_pin(candidate: String) -> Result<(), AppError> {
    let settings = current();
    tauri::async_runtime::spawn_blocking(move || {
        check_pin(&settings, &candidate, &pin::THROTTLE, Instant::now())
    })
    .await
    .map_err(|_| wrong_pin())?
}

/// The settings protected mode turns on with: a new PIN, hashed. Refused
/// while it is already on, so a second "turn on" cannot replace the PIN.
fn turned_on(
    current: &ProtectedModeSettings,
    candidate: &str,
) -> Result<ProtectedModeSettings, AppError> {
    if current.enabled {
        return Err(AppError::new(
            "protected_mode_already_on",
            "Protected mode is already on.",
        ));
    }
    pin::validate(candidate)?;
    Ok(ProtectedModeSettings {
        enabled: true,
        pin: Some(pin::hash(candidate)?),
        restrictions: current.restrictions,
    })
}

/// Off forgets the PIN: the next "turn on" sets a new one. The switches stay,
/// out of force, for that next time.
fn turned_off(current: &ProtectedModeSettings) -> ProtectedModeSettings {
    ProtectedModeSettings {
        restrictions: current.restrictions,
        ..ProtectedModeSettings::default()
    }
}

/// Ok when `settings` is off, or when `candidate` is its PIN. A wrong PIN
/// counts toward the lockout; a lockout refuses before any hashing.
fn check_pin(
    settings: &ProtectedModeSettings,
    candidate: &str,
    throttle: &Mutex<pin::Throttle>,
    now: Instant,
) -> Result<(), AppError> {
    if !settings.enabled {
        return Ok(());
    }
    let lock = || throttle.lock().unwrap_or_else(|poison| poison.into_inner());
    lock().check(now)?;
    let ok = settings
        .pin
        .as_ref()
        .is_some_and(|stored| pin::matches(candidate, stored));
    lock().record(ok, now);
    if ok {
        Ok(())
    } else {
        Err(wrong_pin())
    }
}

fn wrong_pin() -> AppError {
    AppError::new("protected_mode_wrong_pin", "That PIN is not right.")
}

/// The desktop SOUL's personal section carries the protective block and the
/// memory it injects, so it is rewritten in place like a personalization
/// change (ADR-0081), and the runtime's guard ledger learns the memory and
/// past-chat switches at once. The phone rebuilds its prompt every turn and
/// needs nothing.
async fn after_change(app: &AppHandle) {
    #[cfg(desktop)]
    {
        crate::personalization::refresh_soul(app).await;
        if let Err(error) = crate::hermes_bridge::guard::publish(app).await {
            tracing::warn!(code = %error.code, "the runtime guard did not learn the protected switches");
        }
    }
    #[cfg(not(desktop))]
    let _ = app;
}

fn status_of(settings: &ProtectedModeSettings) -> ProtectedModeStatus {
    let restrictions = restrictions_of(settings);
    ProtectedModeStatus {
        enabled: settings.enabled,
        restrictions: settings.restrictions,
        quiet_now: restrictions.quiet_at(restrictions::local_minute()),
    }
}

fn current() -> ProtectedModeSettings {
    mirror()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone()
}

fn mirror() -> &'static Mutex<ProtectedModeSettings> {
    SETTINGS.get_or_init(|| Mutex::new(ProtectedModeSettings::default()))
}

fn replace_mirror(settings: ProtectedModeSettings) {
    let mut current = mirror().lock().unwrap_or_else(|poison| poison.into_inner());
    *current = settings;
}

/// A file that is on without a usable PIN would lock the switch for good, so
/// it reads as off. Anything unreadable reads as off too: failing open is the
/// honest outcome for a guard that a file edit can remove anyway.
fn load_from_disk(path: Option<&Path>) -> ProtectedModeSettings {
    let settings = path
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<ProtectedModeSettings>(&raw).ok())
        .unwrap_or_default();
    if settings.enabled && settings.pin.is_none() {
        return ProtectedModeSettings::default();
    }
    settings
}

fn save_failed() -> AppError {
    AppError::new(
        "protected_mode_save",
        "Could not save protected mode. Try again.",
    )
}

fn persist(path: &Path, settings: &ProtectedModeSettings) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| save_failed())?;
    }
    let serialized = serde_json::to_string_pretty(settings).map_err(|_| save_failed())?;
    fs::write(path, serialized).map_err(|_| save_failed())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::carpe_diem::media::{MediaCatalogDto, MediaModelDto};

    fn model(id: &str, name: &str, traits: &[&str]) -> MediaModelDto {
        MediaModelDto {
            id: id.to_string(),
            media_type: "image".to_string(),
            name: name.to_string(),
            tier: None,
            privacy: None,
            offline: false,
            voices: Vec::new(),
            constraints: None,
            model_sets: Vec::new(),
            traits: traits.iter().map(|t| t.to_string()).collect(),
            supports_vision: false,
            supports_reasoning_effort: false,
            context_tokens: None,
            pricing: None,
            cost_credits: None,
        }
    }

    fn catalog() -> MediaCatalogDto {
        MediaCatalogDto {
            backend: "carpe-diem".to_string(),
            price_multiplier: None,
            protected_mode: false,
            models: vec![
                model("gpt-image-2", "GPT Image 2", &[]),
                model("lustify-v8", "Lustify v8", &["most_uncensored"]),
                model("qwen-3-6-plus", "Qwen 3.6 Plus Uncensored", &[]),
                model("venice-uncensored", "Venice Uncensored", &[]),
            ],
        }
    }

    #[test]
    fn the_catalog_keeps_everything_while_off() {
        let kept = filter_media_catalog_with(catalog(), false);
        assert_eq!(kept.models.len(), 4);
        assert!(!kept.protected_mode);
    }

    #[test]
    fn the_catalog_loses_adult_families_while_on() {
        let kept = filter_media_catalog_with(catalog(), true);
        let ids: Vec<&str> = kept.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["gpt-image-2"]);
        assert!(kept.protected_mode);
        let json = serde_json::to_value(&kept).unwrap();
        assert_eq!(json["protectedMode"], serde_json::json!(true));
    }

    #[test]
    fn the_file_keeps_the_hash_never_the_pin() {
        let dir = std::env::temp_dir().join(format!("protected-mode-{}", uuid::Uuid::new_v4()));
        let path = dir.join(SETTINGS_FILE);
        let settings = ProtectedModeSettings {
            enabled: true,
            pin: Some(pin::hash_with("8642", 4, 1, 1).unwrap()),
            restrictions: Restrictions {
                memory_off: true,
                ..Restrictions::default()
            },
        };
        persist(&path, &settings).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("8642"));
        assert!(raw.contains("\"logN\""));
        let loaded = load_from_disk(Some(&path));
        assert_eq!(loaded, settings);
        assert!(pin::matches("8642", loaded.pin.as_ref().unwrap()));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_file_on_without_a_pin_or_unreadable_reads_as_off() {
        let dir = std::env::temp_dir().join(format!("protected-mode-{}", uuid::Uuid::new_v4()));
        let path = dir.join(SETTINGS_FILE);
        fs::create_dir_all(&dir).unwrap();
        fs::write(&path, r#"{"enabled":true}"#).unwrap();
        assert_eq!(
            load_from_disk(Some(&path)),
            ProtectedModeSettings::default()
        );
        fs::write(&path, "not json").unwrap();
        assert!(!load_from_disk(Some(&path)).enabled);
        assert!(!load_from_disk(None).enabled);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn turning_on_needs_a_valid_pin_and_happens_once() {
        let on = turned_on(&ProtectedModeSettings::default(), "2580").unwrap();
        assert!(on.enabled);
        assert!(pin::matches("2580", on.pin.as_ref().unwrap()));
        assert_eq!(
            turned_on(&ProtectedModeSettings::default(), "12")
                .unwrap_err()
                .code,
            "protected_mode_pin_format"
        );
        // A second "turn on" cannot replace the PIN of the first.
        assert_eq!(
            turned_on(&on, "1111").unwrap_err().code,
            "protected_mode_already_on"
        );
        assert_eq!(turned_off(&on), ProtectedModeSettings::default());
    }

    #[test]
    fn the_switches_outlive_off_but_are_in_force_only_while_on() {
        let switches = Restrictions {
            media_off: true,
            past_chats_off: true,
            ..Restrictions::default()
        };
        let on = ProtectedModeSettings {
            enabled: true,
            pin: Some(pin::hash_with("2580", 4, 1, 1).unwrap()),
            restrictions: switches,
        };
        assert_eq!(restrictions_of(&on), switches);
        let off = turned_off(&on);
        assert!(!off.enabled && off.pin.is_none());
        assert_eq!(off.restrictions, switches);
        assert_eq!(restrictions_of(&off), Restrictions::default());
        // Turning it on again brings them back.
        let again = turned_on(&off, "1357").unwrap();
        assert_eq!(restrictions_of(&again), switches);
    }

    #[test]
    fn turning_off_or_changing_a_protected_setting_needs_the_pin() {
        let throttle = Mutex::new(pin::Throttle::default());
        let now = Instant::now();
        let on = ProtectedModeSettings {
            enabled: true,
            pin: Some(pin::hash_with("2580", 4, 1, 1).unwrap()),
            restrictions: Restrictions::default(),
        };
        assert_eq!(
            check_pin(&on, "0000", &throttle, now).unwrap_err().code,
            "protected_mode_wrong_pin"
        );
        assert!(check_pin(&on, "2580", &throttle, now).is_ok());
        // Off asks for nothing.
        assert!(check_pin(&ProtectedModeSettings::default(), "", &throttle, now).is_ok());
        // On without a stored PIN (a damaged file) opens for nothing.
        let no_pin = ProtectedModeSettings {
            enabled: true,
            pin: None,
            restrictions: Restrictions::default(),
        };
        assert!(check_pin(&no_pin, "2580", &throttle, now).is_err());
    }

    #[test]
    fn a_lockout_refuses_even_the_right_pin_until_it_ends() {
        let throttle = Mutex::new(pin::Throttle::default());
        let now = Instant::now();
        let on = ProtectedModeSettings {
            enabled: true,
            pin: Some(pin::hash_with("2580", 4, 1, 1).unwrap()),
            restrictions: Restrictions::default(),
        };
        for _ in 0..5 {
            let _ = check_pin(&on, "9999", &throttle, now);
        }
        assert_eq!(
            check_pin(&on, "2580", &throttle, now).unwrap_err().code,
            "protected_mode_locked"
        );
        let later = now + std::time::Duration::from_secs(31);
        assert!(check_pin(&on, "2580", &throttle, later).is_ok());
    }

    #[test]
    fn the_status_never_carries_the_hash() {
        let settings = ProtectedModeSettings {
            enabled: true,
            pin: Some(pin::hash_with("1234", 4, 1, 1).unwrap()),
            restrictions: Restrictions::default(),
        };
        let json = serde_json::to_value(status_of(&settings)).unwrap();
        assert!(json.get("pin").is_none());
        assert!(!json.to_string().contains("salt"));
        assert_eq!(json["enabled"], serde_json::json!(true));
        assert_eq!(json["quietNow"], serde_json::json!(false));
        assert_eq!(json["restrictions"]["memoryOff"], serde_json::json!(false));
    }
}
