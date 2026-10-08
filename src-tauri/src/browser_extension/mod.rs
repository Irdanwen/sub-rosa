//! The browser extension's way into the desktop app (ADR-0100).
//!
//! The extension (`browser-extension/`) reads a page on a click and asks the
//! app about it. It talks to nothing else: no server, no open port. The path
//! is Chrome-style native messaging, which every target browser speaks:
//!
//! ```text
//! extension ──stdin/stdout──▶ relay (this binary, started by the browser)
//!            ──socket/pipe──▶ the running app (`server`) ──▶ agent-lite turn
//! ```
//!
//! - [`host_manifest`] registers the relay with each browser, per user, from
//!   Settings › Browser extension, never at install.
//! - [`relay`] is the binary in host mode: no window, no Tauri, a byte pump.
//! - [`pairing`] is the explicit consent: a code shown in the app, typed in
//!   the extension, traded for a token bound to the extension's origin.
//! - [`session`] decides what one frame means, purely; [`server`] does it.
//!
//! Desktop only: a phone has no browser that loads extensions this way.

pub mod endpoint;
pub mod host_manifest;
pub mod pairing;
pub mod protocol;
pub mod relay;
mod server;
pub mod session;

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};

use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::domain::types::AppError;
use host_manifest::Browser;
use pairing::PairingBook;
use session::{Decision, Session};

pub use relay::{invoked_as_host, run as run_host};

const STATE_FILE: &str = "browser-extension.json";
/// Tells an open Settings page that a browser paired or was forgotten.
pub const CHANGED_EVENT: &str = "browser-extension://changed";

struct State {
    dir: PathBuf,
    book: PairingBook,
}

static STATE: LazyLock<Mutex<Option<State>>> = LazyLock::new(|| Mutex::new(None));

fn lock() -> MutexGuard<'static, Option<State>> {
    STATE.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn read_book(dir: &Path) -> PairingBook {
    std::fs::read(dir.join(STATE_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_book(dir: &Path, book: &PairingBook) {
    let result = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let staging = dir.join(format!("{STATE_FILE}.part"));
        std::fs::write(&staging, serde_json::to_vec_pretty(book)?)?;
        std::fs::rename(staging, dir.join(STATE_FILE))
    })();
    if let Err(error) = result {
        tracing::warn!("browser extension pairings could not be saved: {error}");
    }
}

/// Runs `f` on the loaded book, saving it when `f` says it changed.
fn with_book<R>(
    app: &AppHandle,
    f: impl FnOnce(&mut PairingBook) -> (R, bool),
) -> Result<R, AppError> {
    let mut guard = lock();
    if guard.is_none() {
        let dir = crate::app_paths::app_data_dir(app).map_err(|_| unavailable())?;
        let book = read_book(&dir);
        *guard = Some(State { dir, book });
    }
    let Some(state) = guard.as_mut() else {
        return Err(unavailable());
    };
    let (result, changed) = f(&mut state.book);
    if changed {
        write_book(&state.dir, &state.book);
    }
    Ok(result)
}

fn unavailable() -> AppError {
    AppError::new(
        "browser_extension_unavailable",
        "The browser extension settings could not be read.",
    )
}

/// One frame from one connection, decided under the book's lock.
fn decide(app: &AppHandle, session: &mut Session, frame: &[u8]) -> Decision {
    let version = app.package_info().version.to_string();
    let decided = with_book(app, |book| {
        let decision = session.decide(book, frame, Utc::now(), &version, pairing::fresh_token);
        let changed = decision.book_changed;
        (decision, changed)
    });
    match decided {
        Ok(decision) => {
            if decision.book_changed {
                let _ = app.emit(CHANGED_EVENT, ());
            }
            decision
        }
        Err(error) => Decision {
            action: session::Action::Reply(protocol::Response::error(
                None,
                &error.code,
                &error.message,
            )),
            book_changed: false,
        },
    }
}

/// At launch: a browser registered before gets its manifest rewritten (the
/// app may have moved or been updated) and the endpoint opens. Nothing
/// happens for someone who never connected a browser.
pub fn setup(app: &tauri::App) {
    let handle = app.handle().clone();
    let registered =
        with_book(&handle, |book| (book.registered.clone(), false)).unwrap_or_default();
    if registered.is_empty() {
        return;
    }
    if let (Ok(exe), Ok(dir)) = (
        std::env::current_exe(),
        crate::app_paths::app_data_dir(&handle),
    ) {
        for browser in registered {
            if let Err(error) = host_manifest::install(browser, &exe, &dir) {
                tracing::warn!(
                    "browser extension host for {} not refreshed: {error}",
                    browser.id()
                );
            }
        }
    }
    server::ensure_listening(&handle);
}

/// A copy of the app run from a quarantined download is started from a
/// random read-only folder that disappears; a browser could never find it
/// again.
fn is_translocated(exe: &Path) -> bool {
    exe.to_string_lossy().contains("/AppTranslocation/")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDto {
    pub id: Browser,
    pub label: &'static str,
    pub found: bool,
    pub registered: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedBrowserDto {
    pub id: String,
    pub browser: String,
    pub paired_at: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCodeDto {
    pub code: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserExtensionStatusDto {
    pub browsers: Vec<BrowserDto>,
    pub paired: Vec<PairedBrowserDto>,
    pub pairing: Option<PairingCodeDto>,
    pub listening: bool,
}

fn status(app: &AppHandle) -> Result<BrowserExtensionStatusDto, AppError> {
    with_book(app, |book| {
        let now = Utc::now();
        let dto = BrowserExtensionStatusDto {
            browsers: Browser::ALL
                .into_iter()
                .map(|browser| BrowserDto {
                    id: browser,
                    label: browser.label(),
                    found: host_manifest::is_installed(browser),
                    registered: book.registered.contains(&browser),
                })
                .collect(),
            paired: book
                .browsers
                .iter()
                .map(|entry| PairedBrowserDto {
                    id: entry.id.clone(),
                    browser: entry.browser.clone(),
                    paired_at: entry.paired_at.clone(),
                    last_seen_at: entry.last_seen_at.clone(),
                })
                .collect(),
            pairing: book.pending(now).map(|pending| PairingCodeDto {
                code: pending.code.clone(),
                expires_at: pending.expires_at.to_rfc3339(),
            }),
            listening: server::is_listening(),
        };
        (dto, false)
    })
}

#[tauri::command]
pub async fn browser_extension_status(
    app: AppHandle,
) -> Result<BrowserExtensionStatusDto, AppError> {
    status(&app)
}

/// Registers the host with the chosen browsers (every one found, when none
/// is named), opens the endpoint, and shows a pairing code.
#[tauri::command]
pub async fn browser_extension_connect(
    app: AppHandle,
    browsers: Option<Vec<Browser>>,
) -> Result<BrowserExtensionStatusDto, AppError> {
    let chosen: Vec<Browser> = match browsers {
        Some(list) if !list.is_empty() => list,
        _ => Browser::ALL
            .into_iter()
            .filter(|browser| host_manifest::is_installed(*browser))
            .collect(),
    };
    if chosen.is_empty() {
        return Err(AppError::new(
            "browser_extension_no_browser",
            "No supported browser was found. Open Chrome, Edge, Brave or Firefox once, then try again.",
        ));
    }
    let exe = std::env::current_exe().map_err(|_| registration_failed())?;
    if is_translocated(&exe) {
        return Err(AppError::new(
            "browser_extension_translocated",
            "Move Sub Rosa to your Applications folder and open it from there, then try again.",
        ));
    }
    let dir = crate::app_paths::app_data_dir(&app).map_err(|_| unavailable())?;
    for browser in &chosen {
        if let Err(error) = host_manifest::install(*browser, &exe, &dir) {
            tracing::warn!(
                "browser extension host for {} not registered: {error}",
                browser.id()
            );
            return Err(registration_failed());
        }
    }
    with_book(&app, |book| {
        for browser in &chosen {
            if !book.registered.contains(browser) {
                book.registered.push(*browser);
            }
        }
        book.begin(pairing::fresh_code(), Utc::now());
        ((), true)
    })?;
    server::ensure_listening(&app);
    status(&app)
}

fn registration_failed() -> AppError {
    AppError::new(
        "browser_extension_register_failed",
        "Sub Rosa could not set up your browser to reach it.",
    )
}

#[tauri::command]
pub async fn browser_extension_cancel_pairing(
    app: AppHandle,
) -> Result<BrowserExtensionStatusDto, AppError> {
    with_book(&app, |book| {
        book.cancel();
        ((), false)
    })?;
    status(&app)
}

/// Forgets one paired browser: its token stops working at once.
#[tauri::command]
pub async fn browser_extension_forget(
    app: AppHandle,
    id: String,
) -> Result<BrowserExtensionStatusDto, AppError> {
    with_book(&app, |book| ((), book.forget(&id)))?;
    status(&app)
}

/// Undoes everything: every manifest removed, every pairing forgotten.
#[tauri::command]
pub async fn browser_extension_disconnect(
    app: AppHandle,
) -> Result<BrowserExtensionStatusDto, AppError> {
    let dir = crate::app_paths::app_data_dir(&app).map_err(|_| unavailable())?;
    for browser in Browser::ALL {
        if let Err(error) = host_manifest::uninstall(browser, &dir) {
            tracing::warn!(
                "browser extension host for {} not removed: {error}",
                browser.id()
            );
        }
    }
    with_book(&app, |book| {
        book.browsers.clear();
        book.registered.clear();
        book.cancel();
        ((), true)
    })?;
    status(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_translocated_copy_is_refused() {
        assert!(is_translocated(Path::new(
            "/private/var/folders/x/AppTranslocation/ABC/d/Sub Rosa.app/Contents/MacOS/os-june"
        )));
        assert!(!is_translocated(Path::new(
            "/Applications/Sub Rosa.app/Contents/MacOS/os-june"
        )));
    }

    #[test]
    fn the_book_survives_a_restart_without_its_code() {
        let dir = tempfile::tempdir().unwrap();
        let mut book = PairingBook::default();
        book.registered.push(Browser::Edge);
        book.begin("123456".into(), Utc::now());
        write_book(dir.path(), &book);
        let back = read_book(dir.path());
        assert_eq!(back.registered, vec![Browser::Edge]);
        assert!(back.pending(Utc::now()).is_none());
        // A missing or broken file is an empty book, not an error.
        std::fs::write(dir.path().join(STATE_FILE), b"{").unwrap();
        assert_eq!(read_book(dir.path()), PairingBook::default());
    }
}
