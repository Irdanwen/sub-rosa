//! Finding the person's browser and starting it for the agent.
//!
//! Nothing is downloaded: the agent uses a Chromium-family browser already
//! on the machine (Chrome, Edge, Brave, Chromium), started by the app
//! process itself, outside the agent runtime's write jail (ADR-0006), with a
//! profile directory of its own under the app's data. The person's own
//! profile, its cookies and its saved passwords are never opened; a site the
//! agent should be signed in to is one the person signs in to inside that
//! window, once.
//!
//! The DevTools port is chosen by the browser (`--remote-debugging-port=0`):
//! a free port picked at random, bound to loopback, and written with the
//! endpoint's path into `DevToolsActivePort` in the profile, where this reads
//! it. Nothing guesses a port, and no fixed port is ever open.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use super::cdp::agent_error;
use crate::domain::types::AppError;

/// A browser this machine has.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledBrowser {
    pub id: String,
    pub name: String,
    #[serde(skip)]
    pub executable: PathBuf,
}

/// Where each browser lives, in the order one is picked when the person has
/// not chosen.
///
/// Arc is left out on purpose. It is Chromium inside, but nothing it
/// documents promises that `--user-data-dir` gives a separate profile rather
/// than the person's own (whose cookies and passwords this design never
/// opens), it crashes when a tab is created over DevTools
/// (`Target.createTarget`, which `cdp::attach_to_page` falls back to), and its
/// updater relaunches it without the flags. Not installed here to try, so it
/// stays out until someone verifies all three (ADR-0094, addendum).
pub(super) fn candidates() -> Vec<(&'static str, &'static str, PathBuf)> {
    let mut out = Vec::new();
    #[cfg(target_os = "macos")]
    {
        let mut roots = vec![PathBuf::from("/Applications")];
        if let Some(home) = std::env::var_os("HOME") {
            roots.push(PathBuf::from(home).join("Applications"));
        }
        for root in roots {
            for (id, name, bundle, binary) in [
                (
                    "chrome",
                    "Google Chrome",
                    "Google Chrome.app",
                    "Google Chrome",
                ),
                (
                    "edge",
                    "Microsoft Edge",
                    "Microsoft Edge.app",
                    "Microsoft Edge",
                ),
                ("brave", "Brave", "Brave Browser.app", "Brave Browser"),
                ("chromium", "Chromium", "Chromium.app", "Chromium"),
            ] {
                out.push((
                    id,
                    name,
                    root.join(bundle)
                        .join("Contents")
                        .join("MacOS")
                        .join(binary),
                ));
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        let roots: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
            .iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .collect();
        for root in roots {
            for (id, name, relative) in [
                (
                    "chrome",
                    "Google Chrome",
                    "Google\\Chrome\\Application\\chrome.exe",
                ),
                (
                    "edge",
                    "Microsoft Edge",
                    "Microsoft\\Edge\\Application\\msedge.exe",
                ),
                (
                    "brave",
                    "Brave",
                    "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
                ),
                ("chromium", "Chromium", "Chromium\\Application\\chrome.exe"),
            ] {
                out.push((id, name, root.join(relative)));
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        for (id, name, path) in [
            ("chrome", "Google Chrome", "/usr/bin/google-chrome"),
            ("edge", "Microsoft Edge", "/usr/bin/microsoft-edge"),
            ("brave", "Brave", "/usr/bin/brave-browser"),
            ("chromium", "Chromium", "/usr/bin/chromium"),
            ("chromium", "Chromium", "/usr/bin/chromium-browser"),
        ] {
            out.push((id, name, PathBuf::from(path)));
        }
    }
    out
}

/// The browsers found, one per kind.
pub fn installed() -> Vec<InstalledBrowser> {
    let mut found: Vec<InstalledBrowser> = Vec::new();
    for (id, name, executable) in candidates() {
        if found.iter().any(|browser| browser.id == id) || !executable.is_file() {
            continue;
        }
        found.push(InstalledBrowser {
            id: id.to_string(),
            name: name.to_string(),
            executable,
        });
    }
    found
}

/// The person's choice when it is installed, else the first found.
pub fn pick(preferred: Option<&str>) -> Option<InstalledBrowser> {
    let all = installed();
    preferred
        .and_then(|id| all.iter().find(|browser| browser.id == id).cloned())
        .or_else(|| all.into_iter().next())
}

/// Reads `DevToolsActivePort`: the port on the first line, the browser
/// endpoint's path on the second.
pub fn parse_devtools_active_port(contents: &str) -> Option<(u16, String)> {
    let mut lines = contents.lines();
    let port = lines
        .next()?
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)?;
    let path = lines.next()?.trim().to_string();
    path.starts_with("/devtools/browser/")
        .then_some((port, path))
}

/// A started browser.
pub struct Launched {
    /// None when the browser handed off to an instance of the same profile
    /// that was already running (left over from an earlier session).
    pub child: Option<tokio::process::Child>,
    pub port: u16,
    pub path: String,
}

const PORT_FILE: &str = "DevToolsActivePort";
const START_WAIT: Duration = Duration::from_secs(20);

pub async fn launch(executable: &Path, profile_dir: &Path) -> Result<Launched, AppError> {
    launch_with(executable, profile_dir, &[]).await
}

/// `extra` is for the opt-in test that drives a real browser headless; the
/// app's browser is always a window the person can see.
pub async fn launch_with(
    executable: &Path,
    profile_dir: &Path,
    extra: &[&str],
) -> Result<Launched, AppError> {
    std::fs::create_dir_all(profile_dir)
        .map_err(|error| agent_error("browser_profile_failed", error.to_string()))?;
    let port_file = profile_dir.join(PORT_FILE);
    // A file left by a browser that is gone would point at a dead port.
    let previous = std::fs::read_to_string(&port_file).ok();
    let _ = std::fs::remove_file(&port_file);

    let mut command = std::process::Command::new(executable);
    command
        .arg("--remote-debugging-port=0")
        .arg("--remote-debugging-address=127.0.0.1")
        .arg(format!("--user-data-dir={}", profile_dir.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-features=Translate,MediaRouter")
        .args(extra)
        .arg("--new-window")
        .arg("about:blank")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    crate::child_env::scrub(&mut command);
    let mut command = tokio::process::Command::from(command);
    command.kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| agent_error("browser_launch_failed", error.to_string()))?;

    let deadline = tokio::time::Instant::now() + START_WAIT;
    loop {
        if let Some((port, path)) = std::fs::read_to_string(&port_file)
            .ok()
            .as_deref()
            .and_then(parse_devtools_active_port)
        {
            return Ok(Launched {
                child: Some(child),
                port,
                path,
            });
        }
        if let Ok(Some(_)) = child.try_wait() {
            // Handed off to a running instance of this same profile: its
            // file is the one removed above, still describing it.
            if let Some((port, path)) = previous.as_deref().and_then(parse_devtools_active_port) {
                return Ok(Launched {
                    child: None,
                    port,
                    path,
                });
            }
            return Err(agent_error(
                "browser_launch_failed",
                "The browser closed as soon as it started. Close any window of the agent browser and try again.",
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = child.start_kill();
            return Err(agent_error(
                "browser_launch_failed",
                "The browser did not open its DevTools port in time.",
            ));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
