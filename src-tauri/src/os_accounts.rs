//! Local session state.
//!
//! Upstream June, this module was the OS Accounts client: PKCE login in the
//! browser, a keychain token store, refresh handling, and the balance and
//! subscription snapshot that gated the app. Sub Rosa has no hosted identity
//! at all. The user pastes a Carpe Diem key, the sidecar starts a backend on
//! loopback with a random bearer token, and that token is the only credential
//! a request ever carries. So all of it is gone.
//!
//! What remains is the seam the rest of the app calls through, kept at this
//! path and under these names on purpose: `june_api`, `dictation`,
//! `meeting_detection`, `audio::capture`, `providers` and `commands` all
//! reference `crate::os_accounts::*`, and leaving those call sites untouched
//! keeps upstream cherry-picks landing cleanly. See ADR 0017.
//!
//! The sidecar (`carpe_diem::sidecar`) is the only writer of the environment
//! read here; it sets `OS_JUNE_LOCAL_DEV*` once its backend is up.

use crate::domain::types::AppError;
use std::sync::OnceLock;

const LOCAL_DEV_ENV: &str = "OS_JUNE_LOCAL_DEV";
const LOCAL_DEV_BEARER_TOKEN_ENV: &str = "OS_JUNE_LOCAL_DEV_BEARER_TOKEN";
/// Used by `pnpm tauri:dev` against a hand-started `june-api`, which reads the
/// same default from `june-api/.env`.
const DEFAULT_LOCAL_DEV_BEARER_TOKEN: &str = "local-dev-token";

static ENV_LOADED: OnceLock<()> = OnceLock::new();

fn env_trimmed(key: &str) -> String {
    std::env::var(key)
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn env_truthy(key: &str) -> bool {
    matches!(
        env_trimmed(key).to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// True once the sidecar has published its bearer token, i.e. once there is a
/// backend to talk to.
pub(crate) fn local_dev_enabled() -> bool {
    load_local_env();
    env_truthy(LOCAL_DEV_ENV)
}

fn local_dev_bearer_token() -> String {
    load_local_env();
    let token = env_trimmed(LOCAL_DEV_BEARER_TOKEN_ENV);
    if token.is_empty() {
        DEFAULT_LOCAL_DEV_BEARER_TOKEN.to_string()
    } else {
        token
    }
}

/// Whether the app can currently reach a backend. Feature gates
/// (`meeting_detection`, `audio::capture`) use this to stay quiet when there
/// is nothing to send work to; upstream it meant "signed in".
pub(crate) fn cached_signed_in() -> bool {
    local_dev_enabled()
}

/// Bearer for every backend request: the token the sidecar generated for this
/// run. Fails closed while the sidecar is down rather than sending an
/// unauthenticated request.
pub async fn access_token() -> Result<String, AppError> {
    if local_dev_enabled() {
        return Ok(local_dev_bearer_token());
    }
    Err(AppError::new(
        "backend_not_ready",
        "The local backend is not running yet.",
    ))
}

/// Kept as a distinct entry point because `june_api` calls it on a 401 retry.
/// There is nothing to refresh: the token lives as long as the sidecar does,
/// so a 401 means the sidecar restarted and this hands back the current one.
pub async fn refresh_access_token() -> Result<String, AppError> {
    access_token().await
}

/// Loads a developer `.env` (repo root or `src-tauri/`) once per process, so
/// `pnpm tauri:dev` can point the app at a hand-started backend. A packaged
/// build finds no such file and reads only what the sidecar set.
pub fn load_local_env() {
    ENV_LOADED.get_or_init(|| {
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        if let Ok(current_dir) = std::env::current_dir() {
            candidates.push(current_dir.join(".env"));
            if let Some(parent) = current_dir.parent() {
                candidates.push(parent.join(".env"));
            }
        }
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        candidates.push(manifest_dir.join(".env"));
        if let Some(parent) = manifest_dir.parent() {
            candidates.push(parent.join(".env"));
        }
        for candidate in candidates {
            if candidate.exists() {
                let _ = dotenvy::from_path(&candidate);
                break;
            }
        }
    });
}

/// Opens a URL in the user's default browser. The webview installs no
/// new-window handler, so `target="_blank"` anchors are silently dropped and
/// every outbound link has to route through here.
pub(crate) fn open_in_browser(url: &str) -> Result<(), AppError> {
    let mut command = browser_open_command(url);
    let mut child = command
        .spawn()
        .map_err(|e| AppError::new("browser_open_failed", e.to_string()))?;
    // Reap the short-lived `open` process off-thread so it doesn't linger as
    // a zombie until the app exits.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn browser_open_command(url: &str) -> std::process::Command {
    let mut command = std::process::Command::new("open");
    command.arg(url);
    command
}

#[cfg(target_os = "windows")]
fn browser_open_command(url: &str) -> std::process::Command {
    let mut command = std::process::Command::new("explorer.exe");
    command.arg(url);
    command
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn browser_open_command(url: &str) -> std::process::Command {
    let mut command = std::process::Command::new("xdg-open");
    command.arg(url);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_bearer_default_matches_the_one_june_api_reads() {
        // `pnpm tauri:dev` against a hand-started backend sets the flag but
        // not the token; both sides fall back to this literal.
        assert_eq!(DEFAULT_LOCAL_DEV_BEARER_TOKEN, "local-dev-token");
    }

    #[test]
    fn env_truthy_accepts_the_documented_spellings_only() {
        for (value, expected) in [
            ("1", true),
            ("true", true),
            ("TRUE", true),
            ("yes", true),
            ("on", true),
            ("0", false),
            ("false", false),
            ("", false),
            ("maybe", false),
        ] {
            let key = "OS_JUNE_TEST_TRUTHY";
            // SAFETY: a key name no other test reads or writes.
            unsafe { std::env::set_var(key, value) };
            assert_eq!(env_truthy(key), expected, "value {value:?}");
            unsafe { std::env::remove_var(key) };
        }
    }
}
