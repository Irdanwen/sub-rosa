//! One invocation of `subrosa-code run`: the backend, the proxy, the runtime,
//! one turn, then everything stopped and a last line saying how it ended.

use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use serde_json::{json, Value};

use super::{
    args::{PromptSource, RunArgs},
    budget::{round_usd, BudgetMeter},
    gateway::Gateway,
    state::{self, RunLock, RunState},
};
use crate::carpe_diem::{cache_stats, local_session, settings, sidecar};
use crate::code::event::{
    ApprovalDecision, ApprovalKind, CodeEvent, Engine, LineWriter, Resolver, RunMode, RunStatus,
    TurnStatus,
};
use crate::code::hermes_adapter::HermesAdapter;
use crate::hermes_bridge::headless::{self, HeadlessOptions};

pub const EXIT_COMPLETED: i32 = 0;
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_BUDGET: i32 = 3;
pub const EXIT_INTERRUPTED: i32 = 130;

/// How often the ledger is read for `usage` and the budget while a turn runs.
const METER_EVERY: Duration = Duration::from_millis(500);
/// How long an interrupted turn gets to close on its own.
const INTERRUPT_GRACE: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// The answer a question gets when no one is there to answer it.
const UNATTENDED_ANSWER: &str = "No one can answer during this run. Proceed with your best judgment and say in your final answer what you assumed.";
const PLAN_PREFIX: &str =
    "Plan mode: read what you need, change nothing, and answer with a numbered plan.\n\n";
/// The variable naming the key for a headless run (any build), ahead of the
/// keychain: a CI runner or a server has no keychain to read.
const KEY_ENV: &str = "SUBROSA_DEV_API_KEY";
/// A `june` backend binary to run instead of this build's default.
const BACKEND_BIN_ENV: &str = "SUBROSA_JUNE_API_BIN";
/// A file that receives every raw gateway frame, one per line (debugging and
/// recording adapter fixtures; it holds the conversation in clear).
const TRACE_ENV: &str = "SUBROSA_CODE_TRACE";

/// How a run ended.
#[derive(Debug)]
struct Finish {
    status: RunStatus,
    reason: Option<String>,
}

impl Finish {
    fn failed(reason: impl Into<String>) -> Self {
        Self {
            status: RunStatus::Failed,
            reason: Some(reason.into()),
        }
    }
}

/// Writes numbered lines to stdout (or a buffer, in tests).
struct Emitter<W: Write> {
    lines: LineWriter,
    out: W,
}

impl<W: Write> Emitter<W> {
    fn emit(&mut self, event: CodeEvent) {
        let line = self.lines.line(event);
        // A closed stdout must not stop the run: the state file still
        // records how it ended.
        let _ = serde_json::to_writer(&mut self.out, &line);
        let _ = self.out.write_all(b"\n");
        let _ = self.out.flush();
    }
}

pub(super) async fn run(args: RunArgs) -> i32 {
    let Some(data_dir) = args.data_dir.clone().or_else(default_data_dir) else {
        eprintln!("The app's data folder cannot be found here; pass --data-dir.");
        return EXIT_USAGE;
    };
    let prompt = match read_prompt(&args.prompt) {
        Ok(prompt) => prompt,
        Err(message) => {
            eprintln!("{message}");
            return EXIT_USAGE;
        }
    };
    let _lock = match RunLock::acquire(&data_dir) {
        Ok(lock) => lock,
        Err(message) => {
            eprintln!("{message}");
            return EXIT_FAILED;
        }
    };
    let (mut state, resumed) = match prepare_state(&args, &data_dir) {
        Ok(prepared) => prepared,
        Err(message) => {
            eprintln!("{message}");
            return EXIT_USAGE;
        }
    };
    let mut out = Emitter {
        lines: LineWriter::new(state.run_id.clone(), state.last_seq),
        out: std::io::stdout(),
    };

    let finish = {
        let mut session = Session::default();
        let finish = drive(
            &mut out,
            &mut state,
            &mut session,
            resumed,
            &args,
            &data_dir,
            &prompt,
        )
        .await;
        session.stop().await;
        finish
    };
    local_session::clear();

    if let Some(reason) = finish.reason.as_deref() {
        eprintln!("{reason}");
    }
    state.status = Some(finish.status);
    state.spent_usd = round_usd(state.spent_usd);
    let turns = state.turns;
    out.emit(CodeEvent::RunFinished {
        status: finish.status,
        reason: finish.reason,
        cost_usd: Some(state.spent_usd),
        turns,
    });
    state.last_seq = out.lines.last_seq();
    if let Err(error) = state::save(&data_dir, &mut state) {
        eprintln!("The run's state could not be saved: {error}");
    }
    match finish.status {
        RunStatus::Completed => EXIT_COMPLETED,
        RunStatus::Failed => EXIT_FAILED,
        RunStatus::BudgetExceeded => EXIT_BUDGET,
        RunStatus::Interrupted => EXIT_INTERRUPTED,
    }
}

/// Everything a run started, stopped in reverse order whatever happened.
#[derive(Default)]
struct Session {
    backend: Option<Child>,
    proxy: Option<headless::HeadlessProxy>,
    runtime: Option<headless::HeadlessRuntime>,
    gateway: Option<Gateway>,
}

impl Session {
    async fn stop(&mut self) {
        if let Some(gateway) = self.gateway.take() {
            gateway.close().await;
        }
        if let Some(mut runtime) = self.runtime.take() {
            runtime.shutdown();
        }
        self.proxy = None;
        if let Some(mut backend) = self.backend.take() {
            let _ = backend.kill();
            let _ = backend.wait();
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(mut backend) = self.backend.take() {
            let _ = backend.kill();
            let _ = backend.wait();
        }
    }
}

#[allow(clippy::too_many_lines)]
async fn drive<W: Write>(
    out: &mut Emitter<W>,
    state: &mut RunState,
    session: &mut Session,
    resumed: bool,
    args: &RunArgs,
    data_dir: &Path,
    prompt: &str,
) -> Finish {
    let mut budget = BudgetMeter::new(state.budget_usd, state.spent_usd, cache_stats::snapshot());
    if budget.exhausted(cache_stats::snapshot()) {
        return Finish {
            status: RunStatus::BudgetExceeded,
            reason: Some(format!(
                "The run budget of ${:.2} was already reached by earlier turns; raise it with --budget to go on.",
                state.budget_usd
            )),
        };
    }
    // Re-validated on every invocation: a folder can vanish or turn into a
    // symlink between two turns.
    let dir = match crate::hermes_working_dir::validate_working_dir_at(
        &state.dir.to_string_lossy(),
        Some(data_dir),
    ) {
        Ok(valid) => valid.path,
        Err(error) => return Finish::failed(error.message),
    };
    let jail = headless::sandbox_available();
    if state.mode == RunMode::Plan && !jail {
        return Finish::failed(
            "Plan mode keeps the folder read-only with the macOS write jail (Seatbelt), which is not available here. Run in build mode, or on a Mac.",
        );
    }
    if !jail {
        eprintln!("Running WITHOUT an OS sandbox: the agent can write anywhere you can.");
    }

    settings::load_from_config_dir(&default_config_dir().unwrap_or_else(|| data_dir.to_path_buf()));
    let Some((base_url, key)) = resolve_key() else {
        return Finish::failed(format!(
            "No Carpe Diem key: set {KEY_ENV}, or store a key in Sub Rosa."
        ));
    };

    match start_backend(data_dir, &base_url, key.expose_str()).await {
        Ok(child) => session.backend = Some(child),
        Err(message) => return Finish::failed(message),
    }
    drop(key);
    let proxy = match headless::start_provider_proxy(state.model.clone()).await {
        Ok(proxy) => proxy,
        Err(error) => return Finish::failed(error.message),
    };
    let runtime = match headless::start_runtime(HeadlessOptions {
        data_dir,
        working_dir: &dir,
        write_grant: state.mode == RunMode::Build,
        model: &state.model,
        proxy_port: proxy.port,
        proxy_token: &proxy.token,
    })
    .await
    {
        Ok(runtime) => runtime,
        Err(error) => return Finish::failed(error.message),
    };
    session.proxy = Some(proxy);
    let sandboxed = runtime.sandboxed;
    let gateway_path = runtime.gateway_path();
    let runtime_port = runtime.port;
    session.runtime = Some(runtime);
    let gateway = match Gateway::connect(runtime_port, &gateway_path).await {
        Ok(gateway) => gateway,
        Err(error) => {
            return Finish::failed(format!(
                "The agent runtime's gateway could not be reached: {error}"
            ))
        }
    };
    let gateway = session.gateway.insert(gateway);

    let runtime_session = match open_session(gateway, state, &dir, resumed).await {
        Ok(id) => id,
        Err(message) => return Finish::failed(message),
    };
    if let Err(error) = state::save(data_dir, state) {
        return Finish::failed(format!("The run's state could not be saved: {error}"));
    }
    out.emit(CodeEvent::RunStarted {
        engine: Engine::Hermes,
        model: state.model.clone(),
        mode: state.mode,
        dir: dir.to_string_lossy().into_owned(),
        budget_usd: Some(state.budget_usd),
        spent_usd: resumed.then_some(round_usd(state.spent_usd)),
        resumed,
        sandboxed,
        session_id: state.hermes_session_id.clone(),
    });

    let mut adapter = HermesAdapter::new();
    adapter.watch_session(runtime_session.clone());
    state.turns += 1;
    out.emit(adapter.begin_turn(format!("turn-{}", state.turns)));
    let text = match state.mode {
        RunMode::Plan => format!("{PLAN_PREFIX}{prompt}"),
        RunMode::Build => prompt.to_string(),
    };
    if let Err(error) = gateway
        .request(
            "prompt.submit",
            json!({ "session_id": runtime_session, "text": text }),
            REQUEST_TIMEOUT,
        )
        .await
    {
        if let Some(event) = adapter.end_turn(TurnStatus::Failed) {
            out.emit(event);
        }
        return Finish::failed(error.message);
    }

    let mut trace = open_trace();
    let mut meter = tokio::time::interval(METER_EVERY);
    let mut stop_requested: Option<RunStatus> = None;
    let mut stop_deadline: Option<Instant> = None;
    let mut signal = Box::pin(shutdown_signal());
    let mut last_turn_status = TurnStatus::Completed;
    let mut last_error: Option<String> = None;

    while adapter.turn_open() {
        tokio::select! {
            frame = gateway.next_event() => {
                let Some(frame) = frame else {
                    let message = "The agent runtime closed its gateway in the middle of the turn.";
                    last_error = Some(message.to_string());
                    out.emit(CodeEvent::Error {
                        message: message.into(),
                        code: Some("hermes_gateway_closed".into()),
                        recoverable: false,
                    });
                    if let Some(event) = adapter.end_turn(TurnStatus::Failed) {
                        out.emit(event);
                    }
                    last_turn_status = TurnStatus::Failed;
                    break;
                };
                if let Some(file) = trace.as_mut() {
                    let _ = writeln!(file, "{frame}");
                }
                for event in adapter.adapt(&frame) {
                    match &event {
                        CodeEvent::TurnFinished { status, .. } => last_turn_status = *status,
                        CodeEvent::Error { message, .. } => last_error = Some(message.clone()),
                        _ => {}
                    }
                    let request = match &event {
                        CodeEvent::ApprovalRequested { request_id, kind, .. } => {
                            Some((request_id.clone(), *kind))
                        }
                        _ => None,
                    };
                    out.emit(event);
                    if let Some((request_id, kind)) = request {
                        let decision =
                            answer_request(gateway, &runtime_session, &request_id, kind, args.approvals).await;
                        out.emit(CodeEvent::ApprovalResolved {
                            request_id,
                            decision,
                            by: Resolver::Policy,
                        });
                    }
                }
            }
            _ = meter.tick() => {
                let stats = cache_stats::snapshot();
                state.spent_usd = budget.spent_usd(stats);
                if let Some(usage) = budget.report(stats) {
                    out.emit(usage);
                }
                if stop_requested.is_none() {
                    if budget.exhausted(stats) {
                        stop_requested = Some(RunStatus::BudgetExceeded);
                    } else if budget.unpriced(stats) {
                        out.emit(CodeEvent::Error {
                            message: "The operator reported no price for this model's completions, so the run budget cannot be enforced; the run stops.".into(),
                            code: Some("budget_unenforceable".into()),
                            recoverable: false,
                        });
                        stop_requested = Some(RunStatus::Failed);
                    }
                    if stop_requested.is_some() {
                        interrupt(gateway, &runtime_session).await;
                        stop_deadline = Some(Instant::now() + INTERRUPT_GRACE);
                    }
                }
                if stop_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                    if let Some(event) = adapter.end_turn(TurnStatus::Interrupted) {
                        out.emit(event);
                    }
                    last_turn_status = TurnStatus::Interrupted;
                }
            }
            () = &mut signal, if stop_requested.is_none() => {
                stop_requested = Some(RunStatus::Interrupted);
                interrupt(gateway, &runtime_session).await;
                stop_deadline = Some(Instant::now() + INTERRUPT_GRACE);
            }
        }
    }

    // The last completion is metered when its body ends, a moment before or
    // after the runtime closes the turn.
    tokio::time::sleep(Duration::from_millis(400)).await;
    let stats = cache_stats::snapshot();
    state.spent_usd = budget.spent_usd(stats);
    if let Some(usage) = budget.report(stats) {
        out.emit(usage);
    }

    match stop_requested {
        Some(RunStatus::BudgetExceeded) => Finish {
            status: RunStatus::BudgetExceeded,
            reason: Some(format!(
                "The run budget of ${:.2} was reached (spent ${:.4}); the turn was stopped.",
                budget.limit_usd(),
                state.spent_usd
            )),
        },
        Some(RunStatus::Interrupted) => Finish {
            status: RunStatus::Interrupted,
            reason: Some("The run was interrupted.".into()),
        },
        Some(status) => Finish {
            status,
            reason: Some("The run budget cannot be enforced on this model.".into()),
        },
        None => match last_turn_status {
            TurnStatus::Completed => Finish {
                status: RunStatus::Completed,
                reason: None,
            },
            TurnStatus::Interrupted => Finish {
                status: RunStatus::Interrupted,
                reason: Some("The agent runtime interrupted the turn.".into()),
            },
            TurnStatus::Failed => {
                Finish::failed(last_error.unwrap_or_else(|| "The turn failed.".to_string()))
            }
        },
    }
}

/// Creates the run's Hermes session, or reopens it, and returns the runtime
/// session id the gateway speaks of.
async fn open_session(
    gateway: &mut Gateway,
    state: &mut RunState,
    dir: &Path,
    resumed: bool,
) -> Result<String, String> {
    if let (true, Some(stored)) = (resumed, state.hermes_session_id.clone()) {
        let reopened = gateway
            .request(
                "session.resume",
                json!({ "session_id": stored, "cols": 96 }),
                REQUEST_TIMEOUT,
            )
            .await
            .map_err(|error| {
                format!("The run's session could not be reopened: {}", error.message)
            })?;
        return string_field(&reopened, &["session_id"])
            .ok_or_else(|| "The agent runtime did not reopen the run's session.".to_string());
    }
    let created = gateway
        .request(
            "session.create",
            json!({
                "title": format!("Code run {}", state.run_id),
                "cols": 96,
                "model": state.model,
                "cwd": dir.to_string_lossy(),
            }),
            REQUEST_TIMEOUT,
        )
        .await
        .map_err(|error| {
            format!(
                "The agent runtime did not create a session: {}",
                error.message
            )
        })?;
    let runtime = string_field(&created, &["session_id", "id"])
        .ok_or_else(|| "The agent runtime did not create a session.".to_string())?;
    state.hermes_session_id =
        Some(string_field(&created, &["stored_session_id"]).unwrap_or_else(|| runtime.clone()));
    Ok(runtime)
}

/// Answers what the runtime waits on, by the run's standing policy.
async fn answer_request(
    gateway: &mut Gateway,
    session_id: &str,
    request_id: &str,
    kind: ApprovalKind,
    approvals: ApprovalDecision,
) -> ApprovalDecision {
    let (method, params, decision) = match kind {
        ApprovalKind::Command => {
            let choice = if approvals == ApprovalDecision::Once {
                "once"
            } else {
                "deny"
            };
            (
                "approval.respond",
                json!({ "session_id": session_id, "choice": choice }),
                approvals,
            )
        }
        ApprovalKind::Clarify => (
            "clarify.respond",
            json!({ "request_id": request_id, "answer": UNATTENDED_ANSWER }),
            ApprovalDecision::Answered,
        ),
        ApprovalKind::Sudo => (
            "sudo.respond",
            json!({ "request_id": request_id, "password": "" }),
            ApprovalDecision::Deny,
        ),
        ApprovalKind::Secret => (
            "secret.respond",
            json!({ "request_id": request_id, "value": "" }),
            ApprovalDecision::Deny,
        ),
    };
    if let Err(error) = gateway.request(method, params, REQUEST_TIMEOUT).await {
        eprintln!("{method} failed: {}", error.message);
    }
    decision
}

async fn interrupt(gateway: &mut Gateway, session_id: &str) {
    if let Err(error) = gateway
        .request(
            "session.interrupt",
            json!({ "session_id": session_id }),
            REQUEST_TIMEOUT,
        )
        .await
    {
        eprintln!("The turn could not be interrupted: {}", error.message);
    }
}

/// Ctrl-C, or SIGTERM where there is one.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = terminate.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// A new run's state, or a resumed one's with the overrides it allows.
fn prepare_state(args: &RunArgs, data_dir: &Path) -> Result<(RunState, bool), String> {
    if let Some(run_id) = &args.resume {
        let mut state = state::load(data_dir, run_id)?;
        if let Some(dir) = &args.dir {
            let asked = canonical_dir(dir, data_dir)?;
            if asked != state.dir {
                return Err(format!(
                    "The run `{run_id}` works in {}, not {}.",
                    state.dir.display(),
                    asked.display()
                ));
            }
        }
        if let Some(model) = &args.model {
            if model != &state.model {
                return Err(format!(
                    "The run `{run_id}` runs on {}; start a new run to change the model.",
                    state.model
                ));
            }
        }
        if let Some(mode) = args.mode {
            state.mode = mode;
        }
        if let Some(budget) = args.budget_usd {
            state.budget_usd = budget;
        }
        return Ok((state, true));
    }
    let (Some(dir), Some(model), Some(budget)) = (&args.dir, &args.model, args.budget_usd) else {
        return Err("A new run needs --dir, --model and --budget.".into());
    };
    Ok((
        RunState::new(
            state::new_run_id(),
            canonical_dir(dir, data_dir)?,
            model.clone(),
            args.mode.unwrap_or(RunMode::Build),
            budget,
        ),
        false,
    ))
}

fn canonical_dir(dir: &Path, data_dir: &Path) -> Result<PathBuf, String> {
    let absolute = if dir.is_absolute() {
        dir.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(dir)
    };
    crate::hermes_working_dir::validate_working_dir_at(&absolute.to_string_lossy(), Some(data_dir))
        .map(|valid| valid.path)
        .map_err(|error| error.message)
}

fn read_prompt(source: &PromptSource) -> Result<String, String> {
    let text = match source {
        PromptSource::Text(text) => text.clone(),
        PromptSource::File(path) => std::fs::read_to_string(path)
            .map_err(|error| format!("{} cannot be read: {error}", path.display()))?,
        PromptSource::Stdin => {
            let mut text = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut text)
                .map_err(|error| format!("stdin cannot be read: {error}"))?;
            text
        }
    };
    if text.trim().is_empty() {
        return Err("The prompt is empty.".into());
    }
    Ok(text)
}

/// The key from the environment first (without touching the keychain, which
/// could prompt with no one to answer), else the app's own.
fn resolve_key() -> Option<(String, crate::redacted::Redacted<String>)> {
    if let Ok(key) = std::env::var(KEY_ENV) {
        let key = key.trim().to_string();
        if !key.is_empty() {
            return Some((
                settings::file_base_url(),
                crate::redacted::Redacted::new(key),
            ));
        }
    }
    settings::credentials()
}

/// Starts this build's `june` backend on a free port, hands it its secrets on
/// stdin, waits for `/livez`, and points this process's client at it.
async fn start_backend(data_dir: &Path, base_url: &str, key: &str) -> Result<Child, String> {
    let port = sidecar::free_port().map_err(|error| format!("No free local port: {error}"))?;
    let token = local_session::new_bearer_token();
    let mut command = sidecar::backend_program(resource_dir());
    if let Some(bin) = std::env::var_os(BACKEND_BIN_ENV).filter(|bin| !bin.is_empty()) {
        let cwd = command.get_current_dir().map(Path::to_path_buf);
        command = Command::new(bin);
        command.arg("serve");
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
    }
    sidecar::configure_backend(&mut command, port, base_url);
    let log_path = data_dir.join(headless::CODE_CLI_DIR).join("june-api.log");
    let _ = std::fs::create_dir_all(data_dir.join(headless::CODE_CLI_DIR));
    // Never stdout: it carries the run's events.
    match crate::app_paths::open_capped_log(&log_path, 4 * 1024 * 1024)
        .and_then(|out| out.try_clone().map(|err| (out, err)))
    {
        Ok((out, err)) => {
            command.stdout(Stdio::from(out)).stderr(Stdio::from(err));
        }
        Err(_) => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    let mut child = sidecar::spawn_with_secrets(command, &token, key)
        .map_err(|error| format!("The local backend could not start: {error}"))?;
    let started = Instant::now();
    loop {
        if sidecar::probe(port).await {
            break;
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "The local backend stopped ({status}); see {}.",
                log_path.display()
            ));
        }
        if started.elapsed() > sidecar::HEALTH_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "The local backend did not answer in time; see {}.",
                log_path.display()
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    local_session::publish(local_session::LocalSession {
        api_url: format!("http://127.0.0.1:{port}"),
        bearer_token: crate::redacted::Redacted::new(token),
        user_id: sidecar::LOCAL_USER_ID.to_string(),
    });
    Ok(child)
}

/// Where a release build's `config.toml` sits next to the executable.
fn resource_dir() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        return None;
    }
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let bundle_resources = exe_dir.parent().map(|contents| contents.join("Resources"));
    match bundle_resources {
        Some(resources) if resources.join("config.toml").exists() => Some(resources),
        _ => Some(exe_dir),
    }
}

fn open_trace() -> Option<std::fs::File> {
    let path = std::env::var_os(TRACE_ENV).filter(|path| !path.is_empty())?;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    })
}

/// This build's data folder, as the app computes it (`app_paths::app_data_dir`).
#[must_use]
pub fn default_data_dir() -> Option<PathBuf> {
    let base = platform_data_base()?;
    Some(crate::app_paths::app_data_dir_for_build(
        base.join(crate::carpe_diem::branding::BUNDLE_IDENTIFIER),
        cfg!(debug_assertions),
        crate::app_paths::use_prod_data_dir(),
    ))
}

/// The app's config folder (`carpe-diem.json`), which the app does not split
/// by build.
fn default_config_dir() -> Option<PathBuf> {
    let base = if cfg!(any(target_os = "macos", windows)) {
        platform_data_base()?
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .or_else(|| home().map(|home| home.join(".config")))?
    };
    Some(base.join(crate::carpe_diem::branding::BUNDLE_IDENTIFIER))
}

/// Tauri's `data_dir()`: Application Support, Roaming AppData, or the XDG
/// data folder.
fn platform_data_base() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        return home().map(|home| home.join("Library").join("Application Support"));
    }
    if cfg!(windows) {
        return std::env::var_os("APPDATA").map(PathBuf::from);
    }
    std::env::var_os("XDG_DATA_HOME")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| home().map(|home| home.join(".local").join("share")))
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::code::cli::args::{parse, Invocation};

    fn run_args(args: &[&str]) -> RunArgs {
        match parse(std::iter::once("run").chain(args.iter().copied())).unwrap() {
            Invocation::Run(args) => args,
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_new_run_gets_a_canonical_folder_and_build_by_default() {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let args = run_args(&[
            "--dir",
            &work.path().to_string_lossy(),
            "--model",
            "kimi-k2-7-code",
            "--budget",
            "0.02",
            "--prompt",
            "p",
        ]);
        let (state, resumed) = prepare_state(&args, data.path()).unwrap();
        assert!(!resumed);
        assert_eq!(state.dir, work.path().canonicalize().unwrap());
        assert_eq!(state.mode, RunMode::Build);
        assert_eq!(state.budget_usd, 0.02);
        assert!(state.hermes_session_id.is_none());
    }

    #[test]
    fn a_resume_keeps_the_runs_folder_and_model_and_may_change_mode_and_budget() {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let mut saved = RunState::new(
            "run_resume".into(),
            work.path().canonicalize().unwrap(),
            "kimi-k2-7-code".into(),
            RunMode::Plan,
            0.5,
        );
        saved.hermes_session_id = Some("stored-1".into());
        saved.spent_usd = 0.1;
        saved.last_seq = 12;
        state::save(data.path(), &mut saved).unwrap();

        let (state, resumed) = prepare_state(
            &run_args(&[
                "--resume",
                "run_resume",
                "--mode",
                "build",
                "--budget",
                "1",
                "--prompt",
                "go",
            ]),
            data.path(),
        )
        .unwrap();
        assert!(resumed);
        assert_eq!(state.mode, RunMode::Build);
        assert_eq!(state.budget_usd, 1.0);
        assert_eq!(state.spent_usd, 0.1);
        assert_eq!(state.last_seq, 12);
        assert_eq!(state.hermes_session_id.as_deref(), Some("stored-1"));

        let wrong_dir = run_args(&[
            "--resume",
            "run_resume",
            "--dir",
            &other.path().to_string_lossy(),
            "--prompt",
            "go",
        ]);
        assert!(prepare_state(&wrong_dir, data.path())
            .unwrap_err()
            .contains("works in"));
        let wrong_model = run_args(&[
            "--resume",
            "run_resume",
            "--model",
            "glm-5-2",
            "--prompt",
            "go",
        ]);
        assert!(prepare_state(&wrong_model, data.path())
            .unwrap_err()
            .contains("new run"));
    }

    #[test]
    fn the_apps_own_data_folder_cannot_be_the_runs_folder() {
        let data = tempfile::tempdir().unwrap();
        let inside = data.path().join("inside");
        std::fs::create_dir_all(&inside).unwrap();
        let args = run_args(&[
            "--dir",
            &inside.to_string_lossy(),
            "--model",
            "m",
            "--budget",
            "1",
            "--prompt",
            "p",
        ]);
        assert!(prepare_state(&args, data.path()).is_err());
    }

    #[test]
    fn an_emitter_writes_one_numbered_json_line_per_event() {
        let mut emitter = Emitter {
            lines: LineWriter::new("run_x", 4),
            out: Vec::new(),
        };
        emitter.emit(CodeEvent::TurnStarted {
            turn_id: "turn-1".into(),
        });
        emitter.emit(CodeEvent::TurnFinished {
            turn_id: "turn-1".into(),
            status: TurnStatus::Completed,
        });
        let text = String::from_utf8(emitter.out).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["seq"], 5);
        assert_eq!(lines[1]["seq"], 6);
        assert_eq!(lines[1]["type"], "turn.finished");
        assert_eq!(lines[0]["run_id"], "run_x");
    }

    #[test]
    fn a_prompt_comes_from_text_or_a_file_and_is_never_empty() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("prompt.md");
        std::fs::write(&file, "crée hello.py").unwrap();
        assert_eq!(
            read_prompt(&PromptSource::File(file)).unwrap(),
            "crée hello.py"
        );
        assert!(read_prompt(&PromptSource::Text("  ".into())).is_err());
        assert!(read_prompt(&PromptSource::File(dir.path().join("missing"))).is_err());
    }

    #[test]
    fn the_default_data_folder_is_the_apps_for_this_build() {
        let Some(dir) = default_data_dir() else {
            return;
        };
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with(crate::carpe_diem::branding::BUNDLE_IDENTIFIER));
        if cfg!(debug_assertions) && !crate::app_paths::use_prod_data_dir() {
            assert!(name.ends_with("-dev"));
        }
    }
}
