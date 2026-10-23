//! The agent runtime without the app (ADR-0123).
//!
//! The headless code CLI (`subrosa-code`, `crate::code::cli`) runs Hermes the
//! way the app does, minus a window and an `AppHandle`: the same installed
//! runtime, the same rendered config, the same guard plugin, the same Seatbelt
//! profile, the same isolated environment, and a provider proxy that forwards
//! chat completions through the same code as the app's. What the app reads
//! from its handle (data folder, runtime folder) arrives here as paths.
//!
//! Two things differ on purpose:
//! - The CLI has its own Hermes home (`<data>/code-cli/hermes`): the app
//!   rewrites its `config.yaml` with its own proxy port at every spawn, and a
//!   second writer there would point one runtime at the other's proxy.
//! - The proxy serves only the model listing and chat completions. The notes,
//!   memories, media and connector routes read the app's database through
//!   its handle; a code run has no use for them, and the CLI registers none of
//!   the MCP servers that call them.
//!
//! The app's own spawn calls [`runtime_current`] and
//! [`write_sandbox_profile`] too, so the two paths cannot drift on the jail.

use std::{
    io,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Arc,
};

use tokio::sync::oneshot;

use crate::domain::types::AppError;

/// Where the CLI keeps what is its own, under the data folder.
pub(crate) const CODE_CLI_DIR: &str = "code-cli";

/// Toolsets a code run has no use for. Hermes' `coding_context: focus` already
/// narrows the schema in a code workspace; this list covers a folder that is
/// not one yet, and the toolsets that need a person (clarify) or the app
/// (memory, cron, messaging).
const CODE_DISABLED_TOOLSETS: &str = "  disabled_toolsets: [browser, clarify, memory, session_search, cronjob, image_gen, video_gen, video, tts, computer_use, homeassistant, spotify, kanban, discord, discord_admin, x_search]\n";

/// What a code run's SOUL.md says after the identity paragraph.
const CODE_SOUL_MD: &str = r#"
This session is a code run started from the command line. No one watches it live and no one can answer a question in the middle of it: work from the request and the folder, make reasonable choices on your own, and say in your final answer what you chose and why. Keep the final answer short: what changed, what you ran to check it, and what is left.
"#;

/// The plan-mode line appended to the environment notes.
const PLAN_MODE_HINT: &str = "This is a plan run: the working folder is read-only for this session, and the write-jail denies writes inside it. Read the code, then answer with a step-by-step plan; do not try to change files.";

/// Whether the installed runtime under `runtime_dir` is the pinned commit with
/// the fork's patches (`runtime.json`, written by the installer).
pub(super) fn runtime_current(runtime_dir: &Path) -> bool {
    let Ok(metadata) = std::fs::read_to_string(runtime_dir.join("runtime.json")) else {
        return false;
    };
    metadata.contains(&format!(
        r#""commit":"{}""#,
        super::HERMES_AGENT_INSTALL_COMMIT
    )) && metadata.contains(&format!(r#""patches":"{}""#, super::HERMES_MANAGED_PATCHES))
}

/// Builds the Seatbelt profile for a runtime whose home is `hermes_home` and
/// writes it to `profile_path`, which must sit outside every write root so the
/// jailed agent cannot rewrite the policy that governs it. `None` means "spawn
/// unsandboxed", which the caller reports.
#[cfg(target_os = "macos")]
pub(super) fn write_sandbox_profile(
    profile_path: &Path,
    runtime_dir: &Path,
    hermes_home: &Path,
    agent_cli_access: bool,
    working_dir: Option<&Path>,
) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let profile = super::build_sandbox_profile(
        &home,
        &super::sandbox_write_roots(hermes_home, runtime_dir),
        &super::sandbox_config_write_path(hermes_home),
        &super::sandbox_config_temp_prefix(hermes_home),
        agent_cli_access,
        working_dir,
    );
    if std::fs::create_dir_all(profile_path.parent()?).is_err() {
        return None;
    }
    match std::fs::write(profile_path, profile) {
        Ok(()) => Some(profile_path.to_path_buf()),
        Err(error) => {
            eprintln!("Could not write Hermes sandbox profile, spawning unsandboxed: {error}");
            None
        }
    }
}

/// Whether a sandboxed spawn engages the jail on this machine: macOS, with
/// `sandbox-exec`, and the escape hatch not set.
pub(crate) fn sandbox_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        !super::env_flag_enabled(super::JUNE_HERMES_DISABLE_SANDBOX_ENV)
            && Path::new(super::SANDBOX_EXEC_PATH).exists()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// The runtime the app installed under `data_dir`, or the developer override.
/// The CLI never installs one: a missing or stale runtime is an error that
/// says how to get one.
pub(crate) fn runtime_command(data_dir: &Path) -> Result<PathBuf, AppError> {
    if let Ok(command) = std::env::var(super::JUNE_HERMES_COMMAND_ENV) {
        let command = command.trim();
        if !command.is_empty() {
            return Ok(PathBuf::from(command));
        }
    }
    let runtime_dir = data_dir.join("hermes-runtime");
    let command = super::hermes_venv_command(&runtime_dir.join("hermes-agent").join("venv"));
    if command.exists() && runtime_current(&runtime_dir) {
        return Ok(command);
    }
    Err(AppError::new(
        "hermes_runtime_missing",
        format!(
            "The agent runtime is not installed in {}, or it is not the version this build pins. Open Sub Rosa once so it installs it, or point --data-dir at the app's data folder.",
            data_dir.display()
        ),
    ))
}

/// A read-only run (no write grant) must be jailed: the jail is what keeps
/// the folder read-only.
fn require_jail_for_read_only(write_grant: bool, sandboxed: bool) -> Result<(), AppError> {
    if write_grant || sandboxed {
        return Ok(());
    }
    Err(AppError::new(
        "hermes_bridge_sandbox_required",
        "This run must keep the folder read-only, and the macOS write jail could not be set up, so it was not started.",
    ))
}

/// What a headless runtime is started with.
pub(crate) struct HeadlessOptions<'a> {
    pub data_dir: &'a Path,
    /// Validated and canonical (`hermes_working_dir::validate_working_dir_at`).
    pub working_dir: &'a Path,
    /// `false` for a plan run: the folder is not granted to the jail.
    pub write_grant: bool,
    pub model: &'a str,
    pub proxy_port: u16,
    pub proxy_token: &'a str,
}

/// A running headless runtime. Dropping it reaps the whole process group.
pub(crate) struct HeadlessRuntime {
    child: Option<Child>,
    pub port: u16,
    pub token: String,
    pub sandboxed: bool,
}

impl HeadlessRuntime {
    /// The gateway socket's path and query, for `agent_browser::ws::connect`.
    pub(crate) fn gateway_path(&self) -> String {
        format!("/api/ws?token={}", urlencoding::encode(&self.token))
    }

    /// Stops the runtime and every process it started.
    pub(crate) fn shutdown(&mut self) {
        if let Some(mut child) = self.child.take() {
            #[cfg(unix)]
            super::kill_process_group(child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for HeadlessRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// The Hermes home of the code CLI under `data_dir`.
pub(crate) fn code_hermes_home(data_dir: &Path) -> PathBuf {
    data_dir.join(CODE_CLI_DIR).join("hermes")
}

/// Writes the home's config, guard and soul, then spawns the dashboard (whose
/// `/api/ws` is the gateway) in the working folder and waits for it.
pub(crate) async fn start_runtime(
    options: HeadlessOptions<'_>,
) -> Result<HeadlessRuntime, AppError> {
    let hermes_home = code_hermes_home(options.data_dir);
    std::fs::create_dir_all(hermes_home.join("workspace"))
        .map_err(|error| AppError::new("hermes_bridge_home_failed", error.to_string()))?;
    let command = runtime_command(options.data_dir)?;
    std::fs::write(
        hermes_home.join(super::HERMES_CONFIG_FILE),
        render_code_config(options.model, options.proxy_port, options.proxy_token),
    )
    .map_err(|error| AppError::new("hermes_bridge_config_failed", error.to_string()))?;
    super::guard::install_headless(&hermes_home)?;

    let sandbox_profile = if sandbox_available() {
        write_sandbox_profile_for_cli(&options, &hermes_home)
    } else {
        None
    };
    let sandboxed = sandbox_profile.is_some();
    // A run without the folder grant (plan mode) is read-only only because of
    // the jail: if the profile could not be written, refuse to start rather
    // than spawn an agent that can write the folder after all.
    require_jail_for_read_only(options.write_grant, sandboxed)?;
    std::fs::write(hermes_home.join("SOUL.md"), render_code_soul(sandboxed))
        .map_err(|error| AppError::new("hermes_bridge_soul_failed", error.to_string()))?;

    let port = super::pick_port()?;
    let token = super::random_token();
    let port_string = port.to_string();
    let hermes_args = [
        "dashboard",
        "--no-open",
        "--host",
        "127.0.0.1",
        "--port",
        port_string.as_str(),
    ];
    let mut cmd = match &sandbox_profile {
        Some(profile) => {
            let mut cmd = Command::new(super::SANDBOX_EXEC_PATH);
            cmd.arg("-f").arg(profile).arg(&command).args(hermes_args);
            cmd
        }
        None => {
            let mut cmd = Command::new(&command);
            cmd.args(hermes_args);
            cmd
        }
    };
    cmd.stdin(Stdio::null());
    match super::open_dashboard_log(&hermes_home) {
        Some((out, err)) => {
            cmd.stdout(out).stderr(err);
        }
        None => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    let hint = environment_hint(sandboxed, options.write_grant, options.working_dir);
    super::apply_isolated_hermes_env(&mut cmd, &hermes_home, &token, hint.as_deref());
    cmd.current_dir(options.working_dir);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        cmd.process_group(0);
    }
    let child = cmd.spawn().map_err(|error| {
        AppError::new(
            "hermes_bridge_start_failed",
            format!("Could not start the agent runtime. {error}"),
        )
    })?;
    let mut runtime = HeadlessRuntime {
        child: Some(child),
        port,
        token,
        sandboxed,
    };
    let base_url = format!("http://127.0.0.1:{port}");
    if let Err(error) = super::wait_for_hermes(&base_url, &runtime.token).await {
        runtime.shutdown();
        return Err(error);
    }
    Ok(runtime)
}

/// The CLI's profile sits in `<data>/code-cli/`, beside the home it governs
/// and outside it, so the jail cannot reach it.
#[cfg(target_os = "macos")]
fn write_sandbox_profile_for_cli(
    options: &HeadlessOptions<'_>,
    hermes_home: &Path,
) -> Option<PathBuf> {
    write_sandbox_profile(
        &options
            .data_dir
            .join(CODE_CLI_DIR)
            .join("hermes-sandbox.sb"),
        &options.data_dir.join("hermes-runtime"),
        hermes_home,
        false,
        options.write_grant.then_some(options.working_dir),
    )
}

#[cfg(not(target_os = "macos"))]
fn write_sandbox_profile_for_cli(
    _options: &HeadlessOptions<'_>,
    _hermes_home: &Path,
) -> Option<PathBuf> {
    None
}

/// The app's config with the code run's toolsets and the coding posture.
/// Pure so the rendered YAML can be asserted.
fn render_code_config(model: &str, proxy_port: u16, proxy_token: &str) -> String {
    let base_url = format!("http://127.0.0.1:{proxy_port}/v1");
    let config = super::render_hermes_config(
        model,
        &base_url,
        proxy_token,
        // The sandboxed cron toolsets alone: the app's MCP servers are not
        // registered in this home.
        &super::CRON_SANDBOXED_TOOLSETS.join(", "),
        &[],
        None,
        None,
        None,
        None,
        None,
    )
    .replacen(super::RUNTIME_DISABLED_TOOLSETS, CODE_DISABLED_TOOLSETS, 1)
    .replacen("agent:\n", "agent:\n  coding_context: focus\n", 1);
    config + &super::guard::config_block(crate::protected_mode::restrictions().memory_off)
}

/// The app's identity paragraph, then what a code run is, then the sandbox
/// section when the jail is on.
fn render_code_soul(sandboxed: bool) -> String {
    let identity = super::JUNE_SOUL_MD
        .split("\n\n")
        .next()
        .unwrap_or(super::JUNE_SOUL_MD);
    let sandbox = if sandboxed {
        super::JUNE_SOUL_SANDBOX_MD
    } else {
        ""
    };
    format!("{identity}\n{CODE_SOUL_MD}{sandbox}")
}

fn environment_hint(sandboxed: bool, write_grant: bool, working_dir: &Path) -> Option<String> {
    if write_grant {
        return super::environment_hint_for_spawn(false, sandboxed, Some(working_dir));
    }
    Some(format!(
        "Working folder for this session: {}. It is your current directory. {PLAN_MODE_HINT}",
        working_dir.display()
    ))
}

/// The provider proxy of a headless run. Dropping it stops the listener.
pub(crate) struct HeadlessProxy {
    pub port: u16,
    pub token: String,
    _shutdown: oneshot::Sender<()>,
}

/// Starts a loopback proxy that advertises `model` and forwards chat
/// completions to the sidecar, through the same code as the app's proxy.
pub(crate) async fn start_provider_proxy(model: String) -> Result<HeadlessProxy, AppError> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| AppError::new("june_provider_proxy_failed", error.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|error| AppError::new("june_provider_proxy_failed", error.to_string()))?
        .port();
    let token = super::random_token();
    let (shutdown, mut shutdown_rx) = oneshot::channel::<()>();
    let shared = Arc::new((token.clone(), model));
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) => {
                        let shared = shared.clone();
                        tokio::spawn(async move {
                            let _ = handle_connection(stream, &shared.0, &shared.1).await;
                        });
                    }
                    Err(_) => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
                },
            }
        }
    });
    Ok(HeadlessProxy {
        port,
        token,
        _shutdown: shutdown,
    })
}

async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    token: &str,
    model: &str,
) -> io::Result<()> {
    let request = match super::read_http_request(&mut stream).await {
        Ok(request) => request,
        Err(error) => {
            return super::write_json_response(
                &mut stream,
                400,
                serde_json::json!({ "error": { "message": error.to_string() } }),
            )
            .await;
        }
    };
    if !super::provider_proxy_authorized(&request, token) {
        return super::write_json_response(
            &mut stream,
            401,
            serde_json::json!({ "error": { "message": "Unauthorized" } }),
        )
        .await;
    }
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/v1/models") => {
            super::write_json_response(
                &mut stream,
                200,
                super::provider_models_body(model.to_string(), None),
            )
            .await
        }
        ("POST", "/v1/chat/completions") => {
            super::provider_proxy::forward_chat_completions(&mut stream, &request.body, None).await
        }
        _ => {
            super::write_json_response(
                &mut stream,
                404,
                serde_json::json!({ "error": { "message": "This route is not available in a code run." } }),
            )
            .await
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn the_code_config_keeps_the_app_config_and_narrows_the_toolsets() {
        let config = render_code_config("kimi-k2-7-code", 4321, "tok");
        let parsed: serde_yaml::Value = serde_yaml::from_str(&config).unwrap();
        assert_eq!(parsed["model"]["default"], "kimi-k2-7-code");
        assert_eq!(parsed["model"]["base_url"], "http://127.0.0.1:4321/v1");
        assert_eq!(parsed["agent"]["coding_context"], "focus");
        assert_eq!(parsed["agent"]["max_turns"], 200);
        let disabled = parsed["agent"]["disabled_toolsets"].as_sequence().unwrap();
        assert!(disabled.iter().any(|t| t == "clarify"));
        assert!(disabled.iter().any(|t| t == "browser"));
        assert_eq!(parsed["approvals"]["mode"], "manual");
        assert_eq!(parsed["display"]["busy_input_mode"], "queue");
        assert!(parsed["plugins"]["enabled"]
            .as_sequence()
            .unwrap()
            .iter()
            .any(|p| p == "subrosa_guard"));
        // No MCP server of the app: they read the app's database.
        assert!(parsed["mcp_servers"].as_mapping().unwrap().is_empty());
        assert!(!config.contains("june_context"));
    }

    #[test]
    fn the_code_soul_says_sub_rosa_and_mentions_the_jail_only_when_on() {
        let jailed = render_code_soul(true);
        assert!(jailed.starts_with("You are Sub Rosa"));
        assert!(jailed.contains("code run started from the command line"));
        assert!(jailed.contains("Seatbelt"));
        assert!(!render_code_soul(false).contains("Seatbelt"));
    }

    #[test]
    fn a_plan_run_is_told_its_folder_is_read_only() {
        let dir = Path::new("/work/repo");
        let plan = environment_hint(true, false, dir).unwrap();
        assert!(plan.contains("/work/repo"));
        assert!(plan.contains("read-only"));
        let build = environment_hint(true, true, dir).unwrap();
        assert!(build.contains("allows writes inside it"));
    }

    #[test]
    fn a_runtime_is_current_only_with_the_pinned_commit_and_patches() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!runtime_current(dir.path()));
        std::fs::write(
            dir.path().join("runtime.json"),
            format!(
                r#"{{"commit":"{}","patches":"{}"}}"#,
                super::super::HERMES_AGENT_INSTALL_COMMIT,
                super::super::HERMES_MANAGED_PATCHES
            ),
        )
        .unwrap();
        assert!(runtime_current(dir.path()));
        std::fs::write(
            dir.path().join("runtime.json"),
            r#"{"commit":"0000","patches":"cron-shadow"}"#,
        )
        .unwrap();
        assert!(!runtime_current(dir.path()));
    }

    #[test]
    fn a_missing_runtime_says_how_to_get_one() {
        let dir = tempfile::tempdir().unwrap();
        if std::env::var_os(super::super::JUNE_HERMES_COMMAND_ENV).is_some() {
            return;
        }
        let error = runtime_command(dir.path()).unwrap_err();
        assert_eq!(error.code, "hermes_runtime_missing");
        assert!(error.message.contains("Open Sub Rosa once"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_cli_profile_grants_the_folder_only_to_a_build_run() {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let home = code_hermes_home(data.path());
        for write_grant in [true, false] {
            let options = HeadlessOptions {
                data_dir: data.path(),
                working_dir: work.path(),
                write_grant,
                model: "m",
                proxy_port: 1,
                proxy_token: "t",
            };
            let path = write_sandbox_profile_for_cli(&options, &home).unwrap();
            assert!(
                !path.starts_with(&home),
                "the profile must sit outside the jail"
            );
            let profile = std::fs::read_to_string(path).unwrap();
            let granted = profile.contains(&format!("(subpath \"{}\")", work.path().display()));
            assert_eq!(granted, write_grant);
        }
    }

    #[test]
    fn a_read_only_run_is_never_started_without_the_jail() {
        assert!(require_jail_for_read_only(true, false).is_ok());
        assert!(require_jail_for_read_only(true, true).is_ok());
        assert!(require_jail_for_read_only(false, true).is_ok());
        let refused = require_jail_for_read_only(false, false).unwrap_err();
        assert_eq!(refused.code, "hermes_bridge_sandbox_required");
    }
}
