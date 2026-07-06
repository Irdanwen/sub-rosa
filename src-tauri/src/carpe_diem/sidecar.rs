//! `june-api` sidecar manager — the core of the Sub Rosa fork.
//!
//! June already resolves the backend URL and bearer token from process env at
//! runtime (`JUNE_API_URL`, `OS_JUNE_LOCAL_DEV*`). This module turns the
//! Carpe Diem settings into a locally running `june-api` and points the client
//! at it, entirely at runtime:
//!
//! 1. read the base URL + API key from [`super::settings`];
//! 2. pick a free TCP port and generate a random bearer token;
//! 3. `set_var` the client-facing env (URL + local-dev bearer) in-process,
//!    which the June client reads on its next request (values are not cached);
//! 4. run `june-api` in local mode with the Carpe Diem upstream config —
//!    **desktop**: spawned as a child process with `JUNE__…` env;
//!    **mobile (iOS)**: subprocesses are forbidden, so the same server runs
//!    in-process on a Tokio task via the `june-embed` crate;
//! 5. poll `/livez` until ready, tracking status for the UI.
//!
//! The sidecar restarts when the key/URL change and is stopped on app exit.

use serde::Serialize;
#[cfg(desktop)]
use std::path::PathBuf;
#[cfg(desktop)]
use std::process::{Child, Command};
use std::{
    net::TcpListener,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

use super::settings;

/// Handle to the running backend. Killing it stops the backend: on desktop we
/// kill the child process, on mobile we resolve the in-process server's
/// graceful-shutdown future by dropping/sending on the oneshot.
#[cfg(desktop)]
type Backend = Child;
#[cfg(mobile)]
type Backend = tokio::sync::oneshot::Sender<()>;

/// Serializes a whole (re)start so two rapid settings changes can't spawn two
/// backends and orphan one. `spawn_sidecar` has no `.await`, so holding a plain
/// mutex across it is safe; restarts are infrequent and brief.
fn restart_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Local-dev user id handed to `june-api` (must start with `usr_`).
const LOCAL_USER_ID: &str = "usr_local";
/// Emitted to the frontend whenever the sidecar status changes.
pub const SIDECAR_STATUS_EVENT: &str = "carpe-diem://sidecar-status";
/// How long to wait for `/livez` before declaring the sidecar failed. Generous
/// in debug because the fallback `cargo run` path may compile `june-api` first.
#[cfg(debug_assertions)]
const HEALTH_TIMEOUT: Duration = Duration::from_secs(150);
#[cfg(not(debug_assertions))]
const HEALTH_TIMEOUT: Duration = Duration::from_secs(40);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SidecarStatus {
    /// No API key yet — the app should show onboarding.
    Unconfigured,
    /// Spawned, waiting for `/livez`.
    Starting,
    /// Healthy and serving on the loopback port.
    Ready,
    /// Spawn or health check failed.
    Failed,
}

struct Process {
    child: Option<Backend>,
    port: u16,
    status: SidecarStatus,
    message: Option<String>,
    /// Bumped on every (re)start so a stale health check can't overwrite the
    /// status of a newer sidecar.
    generation: u64,
}

impl Default for Process {
    fn default() -> Self {
        Self {
            child: None,
            port: 0,
            status: SidecarStatus::Unconfigured,
            message: None,
            generation: 0,
        }
    }
}

/// Managed Tauri state wrapping the running sidecar process.
pub struct SidecarState(Mutex<Process>);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatusDto {
    pub status: SidecarStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub has_api_key: bool,
}

/// Registers state and starts the sidecar (if a key is configured) at app boot.
pub fn setup(app: &mut tauri::App) {
    app.manage(SidecarState(Mutex::new(Process::default())));
    let handle = app.handle().clone();
    // Spawn off the setup thread: starting the backend must not block the UI.
    tauri::async_runtime::spawn(async move {
        start_or_mark_unconfigured(&handle);
    });
}

/// Restart the sidecar after the Carpe Diem settings change. Runs in the
/// background so the triggering IPC command returns promptly.
pub fn on_settings_changed(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        start_or_mark_unconfigured(&app);
    });
}

/// Kill the child on app exit.
pub fn shutdown(app: &AppHandle) {
    stop_child(app);
}

/// Mobile resume hook: iOS can reclaim the loopback listener while the app
/// is suspended, leaving `JUNE_API_URL` pointing at a dead port ("error
/// sending request" on the next call). On foreground, probe `/livez` and
/// restart the embedded server if it stopped answering.
#[cfg(mobile)]
pub fn ensure_alive(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let port = app
            .try_state::<SidecarState>()
            .and_then(|state| state.0.lock().ok().map(|process| process.port))
            .unwrap_or(0);
        if port == 0 {
            return;
        }
        let alive = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .ok();
        let Some(client) = alive else { return };
        let url = format!("http://127.0.0.1:{port}/livez");
        let healthy = matches!(
            client.get(&url).send().await,
            Ok(response) if response.status().is_success()
        );
        if !healthy {
            on_settings_changed(&app);
        }
    });
}

#[tauri::command]
pub fn carpe_diem_sidecar_status(state: State<'_, SidecarState>) -> SidecarStatusDto {
    let has_api_key = settings::is_configured();
    match state.0.lock() {
        Ok(process) => SidecarStatusDto {
            status: process.status,
            port: (process.port != 0).then_some(process.port),
            message: process.message.clone(),
            has_api_key,
        },
        Err(_) => SidecarStatusDto {
            status: SidecarStatus::Failed,
            port: None,
            message: Some("Sidecar state was poisoned.".to_string()),
            has_api_key,
        },
    }
}

/// Manually (re)start the sidecar — used by the "retry" affordance in the UI.
#[tauri::command]
pub fn carpe_diem_restart_sidecar(app: AppHandle) {
    on_settings_changed(&app);
}

// --- internals -------------------------------------------------------------

fn start_or_mark_unconfigured(app: &AppHandle) {
    // One restart at a time: guards against two concurrent settings changes
    // each spawning a backend and orphaning one (and racing the process env).
    let _guard = restart_lock()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if !settings::is_configured() {
        stop_child(app);
        set_status(app, SidecarStatus::Unconfigured, None, None);
        return;
    }
    spawn_sidecar(app);
}

fn spawn_sidecar(app: &AppHandle) {
    stop_child(app);

    let Some(key) = settings::api_key() else {
        set_status(app, SidecarStatus::Unconfigured, None, None);
        return;
    };
    let base_url = settings::base_url();

    let port = match free_port() {
        Ok(port) => port,
        Err(error) => {
            set_status(
                app,
                SidecarStatus::Failed,
                None,
                Some(format!("Couldn't reserve a local port: {error}")),
            );
            return;
        }
    };
    let token = uuid::Uuid::new_v4().to_string();

    match start_backend(app, port, &token, &base_url, &key) {
        Ok(backend) => {
            // Only after a successful start do we point the June client at the
            // new backend. june_api_url() / access_token() read these on every
            // request and are not cached, so this takes effect for the next
            // call. Set here (not before spawn) so a failed spawn never leaves
            // JUNE_API_URL aimed at a dead port. `start_or_mark_unconfigured`
            // holds the restart lock, so these writes are never concurrent.
            std::env::set_var("JUNE_API_URL", format!("http://127.0.0.1:{port}"));
            std::env::set_var("OS_JUNE_LOCAL_DEV", "1");
            std::env::set_var("OS_JUNE_LOCAL_DEV_BEARER_TOKEN", &token);
            std::env::set_var("OS_JUNE_LOCAL_DEV_USER_ID", LOCAL_USER_ID);
            let generation = store_child(app, backend, port);
            set_status(app, SidecarStatus::Starting, Some(port), None);
            spawn_health_check(app.clone(), port, generation);
        }
        Err(error) => {
            set_status(
                app,
                SidecarStatus::Failed,
                Some(port),
                Some(format!("Couldn't start the local backend: {error}")),
            );
        }
    }
}

/// Desktop backend: spawn the `june-api` binary as a child process.
#[cfg(desktop)]
fn start_backend(
    app: &AppHandle,
    port: u16,
    token: &str,
    base_url: &str,
    key: &str,
) -> std::io::Result<Backend> {
    build_command(app, port, token, base_url, key).spawn()
}

/// Mobile backend: run the same server in-process (`june-embed`) on a Tokio
/// task. The returned oneshot sender is the kill switch — dropping it (or
/// sending on it) resolves the server's graceful-shutdown future.
#[cfg(mobile)]
fn start_backend(
    app: &AppHandle,
    port: u16,
    token: &str,
    base_url: &str,
    key: &str,
) -> std::io::Result<Backend> {
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let options = june_embed::EmbedOptions {
        port,
        bearer_token: token.to_string(),
        user_id: LOCAL_USER_ID.to_string(),
        upstream_base_url: base_url.to_string(),
        upstream_api_key: key.to_string(),
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Resolve on either an explicit stop or the sender being dropped by a
        // restart — both mean "this backend generation is done".
        let shutdown = async move {
            let _ = shutdown_rx.await;
        };
        if let Err(error) = june_embed::serve(options, shutdown).await {
            // Bind/config errors surface here (there is no spawn error on the
            // in-process path). The health-check timeout would eventually flag
            // it, but reporting now gives the UI a real message immediately.
            set_status(
                &app,
                SidecarStatus::Failed,
                Some(port),
                Some(format!("Couldn't start the local backend: {error}")),
            );
        }
    });
    Ok(shutdown_tx)
}

/// Common `JUNE__…` env for the child: local mode + Carpe Diem upstream.
#[cfg(desktop)]
fn apply_june_api_env(command: &mut Command, port: u16, token: &str, base_url: &str, key: &str) {
    command
        .env("JUNE__SERVER__HOST", "127.0.0.1")
        .env("JUNE__SERVER__PORT", port.to_string())
        .env("JUNE__LOCAL_DEV__ENABLED", "true")
        .env("JUNE__LOCAL_DEV__BEARER_TOKEN", token)
        .env("JUNE__LOCAL_DEV__USER_ID", LOCAL_USER_ID)
        .env("JUNE__UPSTREAMS__VENICE__BASE_URL", base_url)
        .env("JUNE__UPSTREAMS__VENICE__API_KEY", key);
    // Both build_command variants funnel through here — keeps the june-api
    // child from opening a terminal window on Windows.
    crate::win_console::hide_console(command);
}

#[cfg(all(desktop, debug_assertions))]
fn build_command(_app: &AppHandle, port: u16, token: &str, base_url: &str, key: &str) -> Command {
    let api_dir = dev_june_api_dir();
    let prebuilt = api_dir.join("target/debug/june");
    let mut command = if prebuilt.exists() {
        let mut command = Command::new(prebuilt);
        command.arg("serve");
        command
    } else {
        // First run without a prebuilt binary: cargo compiles then serves.
        let mut command = Command::new("cargo");
        command.args(["run", "-p", "june", "--", "serve"]);
        command
    };
    // CWD = june-api so Figment finds `config.toml` (pricing fallback catalog).
    command.current_dir(&api_dir);
    apply_june_api_env(&mut command, port, token, base_url, key);
    command
}

#[cfg(all(desktop, not(debug_assertions)))]
fn build_command(app: &AppHandle, port: u16, token: &str, base_url: &str, key: &str) -> Command {
    // Release: run the bundled `june-api` sidecar shipped next to the app
    // binary (declared as `externalBin`; see Phase 5). CWD is set to the
    // resource dir so the bundled `config.toml` is found.
    let binary = bundled_sidecar_path(app);
    let mut command = Command::new(binary);
    command.arg("serve");
    if let Some(dir) = bundled_sidecar_cwd(app) {
        command.current_dir(dir);
    }
    apply_june_api_env(&mut command, port, token, base_url, key);
    command
}

#[cfg(all(desktop, debug_assertions))]
fn dev_june_api_dir() -> PathBuf {
    // <repo>/src-tauri -> <repo>/june-api
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|repo| repo.join("june-api"))
        .unwrap_or_else(|| PathBuf::from("june-api"))
}

#[cfg(all(desktop, not(debug_assertions)))]
fn bundled_sidecar_path(_app: &AppHandle) -> PathBuf {
    // Tauri places `externalBin` next to the main executable. The plain name
    // (without the target-triple suffix) is what ships inside the bundle.
    let name = if cfg!(windows) {
        "june-api.exe"
    } else {
        "june-api"
    };
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        .unwrap_or_else(|| PathBuf::from(name))
}

#[cfg(all(desktop, not(debug_assertions)))]
fn bundled_sidecar_cwd(app: &AppHandle) -> Option<PathBuf> {
    // Bundled `config.toml` lives under the resource dir (see Phase 5).
    app.path().resource_dir().ok()
}

fn free_port() -> std::io::Result<u16> {
    // Bind to port 0, read the assigned port, then drop the listener. A small
    // race exists before the child binds, but the child binds immediately.
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    Ok(port)
}

fn spawn_health_check(app: AppHandle, port: u16, generation: u64) {
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .ok();
        let url = format!("http://127.0.0.1:{port}/livez");
        let started = Instant::now();
        loop {
            if is_stale(&app, generation) {
                return;
            }
            if let Some(client) = &client {
                if let Ok(response) = client.get(&url).send().await {
                    if response.status().is_success() {
                        if !is_stale(&app, generation) {
                            set_status(&app, SidecarStatus::Ready, Some(port), None);
                        }
                        return;
                    }
                }
            }
            if started.elapsed() > HEALTH_TIMEOUT {
                if !is_stale(&app, generation) {
                    set_status(
                        &app,
                        SidecarStatus::Failed,
                        Some(port),
                        Some("The local backend didn't become ready in time.".to_string()),
                    );
                }
                return;
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
    });
}

/// Stop a backend handle: kill + reap the child process on desktop, resolve
/// the in-process server's shutdown future on mobile.
#[cfg(desktop)]
fn kill_backend(mut backend: Backend) {
    let _ = backend.kill();
    let _ = backend.wait();
}

#[cfg(mobile)]
fn kill_backend(backend: Backend) {
    // Sending (or just dropping the sender) resolves the graceful-shutdown
    // future inside `june_embed::serve`.
    let _ = backend.send(());
}

fn store_child(app: &AppHandle, child: Backend, port: u16) -> u64 {
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut process) = state.0.lock() {
            process.generation += 1;
            // Reap any backend we're replacing (should be None after
            // stop_child; this guards the belt-and-suspenders case of a
            // leftover handle).
            if let Some(previous) = process.child.take() {
                kill_backend(previous);
            }
            process.child = Some(child);
            process.port = port;
            process.status = SidecarStatus::Starting;
            process.message = None;
            return process.generation;
        }
    }
    0
}

fn stop_child(app: &AppHandle) {
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut process) = state.0.lock() {
            // Bump generation so any in-flight health check for the old child
            // becomes stale and won't report Ready after we've killed it.
            process.generation += 1;
            if let Some(child) = process.child.take() {
                kill_backend(child);
            }
        }
    }
}

fn is_stale(app: &AppHandle, generation: u64) -> bool {
    app.try_state::<SidecarState>()
        .and_then(|state| {
            state
                .0
                .lock()
                .ok()
                .map(|process| process.generation != generation)
        })
        .unwrap_or(true)
}

fn set_status(app: &AppHandle, status: SidecarStatus, port: Option<u16>, message: Option<String>) {
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut process) = state.0.lock() {
            process.status = status;
            if let Some(port) = port {
                process.port = port;
            }
            process.message = message.clone();
        }
    }
    let _ = app.emit(
        SIDECAR_STATUS_EVENT,
        SidecarStatusDto {
            status,
            port,
            message,
            has_api_key: settings::is_configured(),
        },
    );
}
