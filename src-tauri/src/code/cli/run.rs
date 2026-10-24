//! One invocation of `subrosa-code run`: the backend, the proxy, the runtime,
//! one turn, then everything stopped and a last line saying how it ended.

use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tokio::sync::watch;

use super::{
    args::{PromptSource, RunArgs},
    budget::{round_usd, BudgetMeter},
    gateway::Gateway,
    state::{self, RunLock, RunState},
};
use crate::carpe_diem::{cache_stats, local_session, orphan, settings, sidecar};
use crate::code::event::{
    ApprovalDecision, ApprovalKind, CodeEvent, Engine, LineWriter, Resolver, RunMode, RunStatus,
    TurnStatus,
};
use crate::code::hermes_adapter::{self, HermesAdapter};
use crate::hermes_bridge::headless::{self, HeadlessOptions};
use crate::redacted::Redacted;

pub const EXIT_COMPLETED: i32 = 0;
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_BUDGET: i32 = 3;
pub const EXIT_INTERRUPTED: i32 = 130;

/// How often the ledger is read for `usage` and the budget while a turn runs.
const METER_EVERY: Duration = Duration::from_millis(500);
/// How long an interrupted turn gets to close on its own. A second Ctrl-C
/// (or SIGTERM) does not wait for it.
const INTERRUPT_GRACE: Duration = Duration::from_secs(15);
/// How long the end of a run waits for completions still streaming, so their
/// cost is counted rather than called incomplete.
const SETTLE_WAIT: Duration = Duration::from_secs(3);
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
/// recording adapter fixtures; it holds the conversation in clear, so it is
/// written owner-only).
const TRACE_ENV: &str = "SUBROSA_CODE_TRACE";
/// The records of the processes a run started (`carpe_diem::orphan`), so the
/// next run stops the ones a crashed run left behind.
const BACKEND_RECORD: &str = "june-api.pid";
const RUNTIME_RECORD: &str = "hermes.pid";

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

    fn interrupted(reason: &str) -> Self {
        Self {
            status: RunStatus::Interrupted,
            reason: Some(reason.to_string()),
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

/// Reads the key from [`KEY_ENV`] and takes it out of this process's
/// environment before anything else runs, so no child inherits it and no
/// other process of the user reads it back. Removing the variable is not
/// enough: `ps eww` and `KERN_PROCARGS2` (or `/proc/<pid>/environ`) read the
/// environment block the process started with, which `unsetenv` leaves in
/// place, so its bytes are overwritten first. Called from `main` before the
/// async runtime starts, while this is the only thread.
pub(super) fn take_env_key() -> Option<Redacted<String>> {
    let value = std::env::var(KEY_ENV).ok();
    scrub_env_var(KEY_ENV);
    value
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .map(Redacted::new)
}

fn scrub_env_var(name: &str) {
    #[cfg(unix)]
    if let Ok(c_name) = std::ffi::CString::new(name) {
        // SAFETY: getenv returns null or a pointer to the NUL-terminated
        // value inside this process's environment block, which is writable;
        // the bytes are overwritten in place, never past the terminator. Only
        // called while no other thread runs (see `take_env_key`).
        #[allow(unsafe_code)]
        unsafe {
            let value = libc::getenv(c_name.as_ptr());
            if !value.is_null() {
                std::ptr::write_bytes(value, 0, libc::strlen(value));
            }
        }
    }
    std::env::remove_var(name);
}

/// Ctrl-C and SIGTERM, counted. The first one stops the turn and lets it
/// close; the second stops the run at once.
fn listen_for_stops() -> watch::Receiver<u32> {
    let (sender, receiver) = watch::channel(0u32);
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let (Ok(mut interrupt), Ok(mut terminate)) = (
                signal(SignalKind::interrupt()),
                signal(SignalKind::terminate()),
            ) else {
                return;
            };
            loop {
                tokio::select! {
                    _ = interrupt.recv() => {}
                    _ = terminate.recv() => {}
                }
                sender.send_modify(|count| *count += 1);
            }
        }
        #[cfg(not(unix))]
        loop {
            if tokio::signal::ctrl_c().await.is_err() {
                return;
            }
            sender.send_modify(|count| *count += 1);
        }
    });
    receiver
}

/// Resolves when the run must stop at once: a second stop signal, or a first
/// one while no turn runs (there is nothing to close then).
async fn stop_at_once(mut stops: watch::Receiver<u32>, turn_running: Arc<AtomicBool>) {
    loop {
        if stops.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
        let count = *stops.borrow_and_update();
        if count >= 2 || (count >= 1 && !turn_running.load(Ordering::SeqCst)) {
            return;
        }
    }
}

/// What one invocation works with, owned here so that a run stopped at once
/// (its `drive` future dropped) can still close its turn, meter what it spent
/// and stop what it started.
struct Ctx<'a, W: Write> {
    out: Emitter<W>,
    state: RunState,
    session: Session,
    adapter: HermesAdapter,
    budget: BudgetMeter,
    resumed: bool,
    args: &'a RunArgs,
    data_dir: &'a Path,
    turn_running: Arc<AtomicBool>,
}

pub(super) async fn run(args: RunArgs, env_key: Option<Redacted<String>>) -> i32 {
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
    let stops = listen_for_stops();
    let _lock = match RunLock::acquire(&data_dir) {
        Ok(lock) => lock,
        Err(message) => {
            eprintln!("{message}");
            return EXIT_FAILED;
        }
    };
    reap_orphans(&data_dir);
    let (state, resumed) = match prepare_state(&args, &data_dir) {
        Ok(prepared) => prepared,
        Err(message) => {
            eprintln!("{message}");
            return EXIT_USAGE;
        }
    };
    let turn_running = Arc::new(AtomicBool::new(false));
    let mut ctx = Ctx {
        out: Emitter {
            lines: LineWriter::new(state.run_id.clone(), state.last_seq),
            out: std::io::stdout(),
        },
        budget: BudgetMeter::new(state.budget_usd, state.spent_usd, cache_stats::snapshot()),
        state,
        session: Session::new(&data_dir),
        adapter: HermesAdapter::new(),
        resumed,
        args: &args,
        data_dir: &data_dir,
        turn_running: turn_running.clone(),
    };

    let finish = tokio::select! {
        finish = drive(&mut ctx, &prompt, env_key, stops.clone()) => finish,
        () = stop_at_once(stops, turn_running) => {
            if let Some(event) = ctx.adapter.end_turn(TurnStatus::Interrupted) {
                ctx.out.emit(event);
            }
            Finish::interrupted("The run was stopped at once.")
        }
    };
    ctx.turn_running.store(false, Ordering::SeqCst);
    let started_a_turn = ctx.state.turns > 0 && ctx.session.runtime.is_some();
    let Ctx {
        mut out,
        mut state,
        mut session,
        mut budget,
        ..
    } = ctx;

    // The last completion is metered when its body ends, a moment before or
    // after the runtime closes the turn; one still streaming gets a short
    // while to end before the runtime is stopped.
    if started_a_turn {
        let deadline = Instant::now() + SETTLE_WAIT;
        tokio::time::sleep(Duration::from_millis(400)).await;
        while cache_stats::snapshot().open_streams > 0 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    session.stop().await;
    local_session::clear();
    let stats = cache_stats::snapshot();
    state.spent_usd = budget.spent_usd(stats);
    if let Some(usage) = budget.report(stats) {
        out.emit(usage);
    }
    let cost_incomplete = budget.cost_incomplete(stats);
    if cost_incomplete {
        eprintln!("A completion ended before the operator reported its cost, so the cost shown may be short of what was billed.");
    }

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
        cost_incomplete,
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

/// Stops the backend and the runtime a crashed run left behind, if they still
/// run the executable recorded for them and nothing else owns them
/// (`carpe_diem::orphan`). Both lead their own process group.
fn reap_orphans(data_dir: &Path) {
    let dir = data_dir.join(headless::CODE_CLI_DIR);
    for record in [BACKEND_RECORD, RUNTIME_RECORD] {
        if let Some(pid) = orphan::reap_group(&dir.join(record)) {
            eprintln!("Stopped process {pid}, left running by an earlier code run.");
        }
    }
}

/// Everything a run started, stopped in reverse order whatever happened.
struct Session {
    backend: Option<Child>,
    proxy: Option<headless::HeadlessProxy>,
    runtime: Option<headless::HeadlessRuntime>,
    gateway: Option<Gateway>,
    records: PathBuf,
}

impl Session {
    fn new(data_dir: &Path) -> Self {
        Self {
            backend: None,
            proxy: None,
            runtime: None,
            gateway: None,
            records: data_dir.join(headless::CODE_CLI_DIR),
        }
    }

    async fn stop(&mut self) {
        if let Some(gateway) = self.gateway.take() {
            let _ = tokio::time::timeout(Duration::from_secs(2), gateway.close()).await;
        }
        if let Some(mut runtime) = self.runtime.take() {
            let pid = runtime.pid();
            runtime.shutdown();
            if let Some(pid) = pid {
                orphan::forget(&self.records.join(RUNTIME_RECORD), pid);
            }
        }
        self.proxy = None;
        self.stop_backend();
    }

    fn stop_backend(&mut self) {
        if let Some(mut backend) = self.backend.take() {
            let pid = backend.id();
            headless::kill_group(pid);
            let _ = backend.kill();
            let _ = backend.wait();
            orphan::forget(&self.records.join(BACKEND_RECORD), pid);
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop_backend();
    }
}

#[allow(clippy::too_many_lines)]
async fn drive<W: Write>(
    ctx: &mut Ctx<'_, W>,
    prompt: &str,
    env_key: Option<Redacted<String>>,
    mut stops: watch::Receiver<u32>,
) -> Finish {
    let data_dir = ctx.data_dir;
    if ctx.budget.exhausted(cache_stats::snapshot()) {
        return Finish {
            status: RunStatus::BudgetExceeded,
            reason: Some(format!(
                "The run budget of ${:.2} was already reached by earlier turns; raise it with --budget to go on.",
                ctx.state.budget_usd
            )),
        };
    }
    // Re-validated on every invocation: a folder can vanish or turn into a
    // symlink between two turns.
    let dir = match crate::hermes_working_dir::validate_working_dir_at(
        &ctx.state.dir.to_string_lossy(),
        Some(data_dir),
    ) {
        Ok(valid) => valid.path,
        Err(error) => return Finish::failed(error.message),
    };
    let jail = headless::sandbox_available();
    if ctx.state.mode == RunMode::Plan && !jail {
        return Finish::failed(
            "Plan mode keeps the folder read-only with the macOS write jail (Seatbelt), which is not available here. Run in build mode, or on a Mac.",
        );
    }
    if !jail {
        eprintln!("Running WITHOUT an OS sandbox: the agent can write anywhere you can.");
    }

    // The app's settings, read without an app handle: the base URL, and the
    // protected-mode switches that the guard ledger, the rendered config and
    // the chat proxy (`protected_mode::check_chat`) enforce. Without the
    // second load they all read protected mode as off.
    let config_dir = default_config_dir().unwrap_or_else(|| data_dir.to_path_buf());
    settings::load_from_config_dir(&config_dir);
    crate::protected_mode::load_from_config_dir(&config_dir);
    let Some((base_url, key)) = resolve_key(env_key) else {
        return Finish::failed(format!(
            "No Carpe Diem key: set {KEY_ENV}, or store a key in Sub Rosa."
        ));
    };

    match start_backend(data_dir, &base_url, key.expose_str()).await {
        Ok(child) => {
            orphan::remember(&ctx.session.records.join(BACKEND_RECORD), child.id());
            ctx.session.backend = Some(child);
        }
        Err(message) => return Finish::failed(message),
    }
    drop(key);
    let proxy = match headless::start_provider_proxy(ctx.state.model.clone()).await {
        Ok(proxy) => proxy,
        Err(error) => return Finish::failed(error.message),
    };
    let runtime = match headless::start_runtime(HeadlessOptions {
        data_dir,
        working_dir: &dir,
        write_grant: ctx.state.mode == RunMode::Build,
        model: &ctx.state.model,
        proxy_port: proxy.port,
        proxy_token: &proxy.token,
    })
    .await
    {
        Ok(runtime) => runtime,
        Err(error) => return Finish::failed(error.message),
    };
    if let Some(pid) = runtime.pid() {
        orphan::remember(&ctx.session.records.join(RUNTIME_RECORD), pid);
    }
    ctx.session.proxy = Some(proxy);
    let sandboxed = runtime.sandboxed;
    let gateway_path = runtime.gateway_path();
    let runtime_port = runtime.port;
    ctx.session.runtime = Some(runtime);
    let gateway = match Gateway::connect(runtime_port, &gateway_path).await {
        Ok(gateway) => gateway,
        Err(error) => {
            return Finish::failed(format!(
                "The agent runtime's gateway could not be reached: {error}"
            ))
        }
    };
    let gateway = ctx.session.gateway.insert(gateway);

    let runtime_session = match open_session(gateway, &mut ctx.state, &dir, ctx.resumed).await {
        Ok(id) => id,
        Err(message) => return Finish::failed(message),
    };
    if let Err(error) = state::save(data_dir, &mut ctx.state) {
        return Finish::failed(format!("The run's state could not be saved: {error}"));
    }
    ctx.out.emit(CodeEvent::RunStarted {
        engine: Engine::Hermes,
        model: ctx.state.model.clone(),
        mode: ctx.state.mode,
        dir: dir.to_string_lossy().into_owned(),
        budget_usd: Some(ctx.state.budget_usd),
        spent_usd: ctx.resumed.then_some(round_usd(ctx.state.spent_usd)),
        resumed: ctx.resumed,
        sandboxed,
        session_id: ctx.state.hermes_session_id.clone(),
    });

    ctx.adapter.watch_session(runtime_session.clone());
    ctx.state.turns += 1;
    // From here a first stop signal interrupts the turn instead of the run.
    ctx.turn_running.store(true, Ordering::SeqCst);
    let _ = stops.borrow_and_update();
    let begin = ctx.adapter.begin_turn(format!("turn-{}", ctx.state.turns));
    ctx.out.emit(begin);
    let text = match ctx.state.mode {
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
        if let Some(event) = ctx.adapter.end_turn(TurnStatus::Failed) {
            ctx.out.emit(event);
        }
        return Finish::failed(error.message);
    }

    let mut trace = open_trace();
    let mut meter = tokio::time::interval(METER_EVERY);
    let mut stop_requested: Option<RunStatus> = None;
    let mut stop_deadline: Option<Instant> = None;
    let mut last_turn_status = TurnStatus::Completed;
    let mut last_error: Option<String> = None;

    while ctx.adapter.turn_open() {
        tokio::select! {
            frame = gateway.next_event() => {
                let Some(frame) = frame else {
                    let message = "The agent runtime closed its gateway in the middle of the turn.";
                    last_error = Some(message.to_string());
                    ctx.out.emit(CodeEvent::Error {
                        message: message.into(),
                        code: Some("hermes_gateway_closed".into()),
                        recoverable: false,
                    });
                    if let Some(event) = ctx.adapter.end_turn(TurnStatus::Failed) {
                        ctx.out.emit(event);
                    }
                    last_turn_status = TurnStatus::Failed;
                    break;
                };
                if let Some(file) = trace.as_mut() {
                    let _ = writeln!(file, "{frame}");
                }
                if let Some(request_id) = hermes_adapter::terminal_read_request(&frame) {
                    // No window, so no terminal to read: answer at once rather
                    // than let the tool wait out its timeout.
                    if let Err(error) = gateway
                        .request(
                            "terminal.read.respond",
                            json!({ "request_id": request_id, "text": "" }),
                            REQUEST_TIMEOUT,
                        )
                        .await
                    {
                        eprintln!("terminal.read.respond failed: {}", error.message);
                    }
                }
                for event in ctx.adapter.adapt(&frame) {
                    match &event {
                        CodeEvent::TurnFinished { status, .. } => last_turn_status = *status,
                        CodeEvent::Error { message, recoverable: false, .. } => {
                            last_error = Some(message.clone());
                        }
                        _ => {}
                    }
                    let request = match &event {
                        CodeEvent::ApprovalRequested { request_id, kind, .. } => {
                            Some((request_id.clone(), *kind))
                        }
                        _ => None,
                    };
                    ctx.out.emit(event);
                    if let Some((request_id, kind)) = request {
                        let decision = answer_request(
                            gateway,
                            &runtime_session,
                            &request_id,
                            kind,
                            ctx.args.approvals,
                        )
                        .await;
                        ctx.out.emit(CodeEvent::ApprovalResolved {
                            request_id,
                            decision,
                            by: Resolver::Policy,
                        });
                    }
                }
            }
            _ = meter.tick() => {
                let stats = cache_stats::snapshot();
                ctx.state.spent_usd = ctx.budget.spent_usd(stats);
                if let Some(usage) = ctx.budget.report(stats) {
                    ctx.out.emit(usage);
                    // What was spent is on disk as soon as it is known: a run
                    // killed outright (-9) still resumes from it, not from
                    // what it had spent when it started.
                    ctx.state.last_seq = ctx.out.lines.last_seq();
                    if let Err(error) = state::save(data_dir, &mut ctx.state) {
                        eprintln!("The run's state could not be saved: {error}");
                    }
                }
                if stop_requested.is_none() {
                    if ctx.budget.exhausted(stats) {
                        stop_requested = Some(RunStatus::BudgetExceeded);
                    } else if ctx.budget.unpriced(stats) {
                        ctx.out.emit(CodeEvent::Error {
                            message: "The operator reported no price for a completion of this model, so the run budget cannot be enforced; the run stops.".into(),
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
                    if let Some(event) = ctx.adapter.end_turn(TurnStatus::Interrupted) {
                        ctx.out.emit(event);
                    }
                    last_turn_status = TurnStatus::Interrupted;
                }
            }
            changed = stops.changed(), if stop_requested.is_none() => {
                if changed.is_ok() {
                    stop_requested = Some(RunStatus::Interrupted);
                    eprintln!("Stopping the turn; press Ctrl-C again to stop at once.");
                    interrupt(gateway, &runtime_session).await;
                    stop_deadline = Some(Instant::now() + INTERRUPT_GRACE);
                }
            }
        }
    }
    ctx.turn_running.store(false, Ordering::SeqCst);

    match stop_requested {
        Some(RunStatus::BudgetExceeded) => Finish {
            status: RunStatus::BudgetExceeded,
            reason: Some(format!(
                "The run budget of ${:.2} was reached (spent ${:.4}); the turn was stopped.",
                ctx.budget.limit_usd(),
                ctx.state.spent_usd
            )),
        },
        Some(RunStatus::Interrupted) => Finish::interrupted("The run was interrupted."),
        Some(status) => Finish {
            status,
            reason: Some("The run budget cannot be enforced on this model.".into()),
        },
        None => match last_turn_status {
            TurnStatus::Completed => Finish {
                status: RunStatus::Completed,
                reason: None,
            },
            TurnStatus::Interrupted => {
                Finish::interrupted("The agent runtime interrupted the turn.")
            }
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

/// The key from the environment first (taken out of it by `main`, see
/// [`take_env_key`]; the keychain is not touched, it could prompt with no one
/// to answer), else the app's own.
fn resolve_key(env_key: Option<Redacted<String>>) -> Option<(String, Redacted<String>)> {
    match env_key {
        Some(key) => Some((settings::file_base_url(), key)),
        None => settings::credentials(),
    }
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
    // Nothing credential-shaped from this process's environment: the key
    // travels on the backend's stdin only, as the app's sidecar does.
    crate::child_env::scrub(&mut command);
    sidecar::configure_backend(&mut command, port, base_url);
    // Its own process group: a Ctrl-C in the terminal reaches this process,
    // which stops the turn and then the backend, instead of killing the
    // backend under a turn that is still closing.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
    }
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
    open_owner_only_append(Path::new(&path)).ok()
}

/// Opens `path` for appending, readable by its owner only: a trace holds the
/// conversation in clear. An existing file is narrowed too.
fn open_owner_only_append(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
        options.mode(0o600);
        let file = options.open(path)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        Ok(file)
    }
    #[cfg(not(unix))]
    options.open(path)
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

    /// A first stop signal during a turn leaves the turn to close (the turn
    /// loop interrupts it); a second one, or a first one outside a turn,
    /// stops the run at once.
    #[test]
    fn a_second_stop_or_one_outside_a_turn_stops_at_once() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let soon = Duration::from_millis(50);
            let (sender, receiver) = watch::channel(0u32);
            let turn = Arc::new(AtomicBool::new(true));
            let mut stop = Box::pin(stop_at_once(receiver.clone(), turn.clone()));
            sender.send_modify(|count| *count += 1);
            assert!(tokio::time::timeout(soon, &mut stop).await.is_err());
            sender.send_modify(|count| *count += 1);
            assert!(tokio::time::timeout(soon, &mut stop).await.is_ok());

            let (sender, receiver) = watch::channel(0u32);
            let idle = Arc::new(AtomicBool::new(false));
            let stop = stop_at_once(receiver, idle);
            sender.send_modify(|count| *count += 1);
            assert!(tokio::time::timeout(soon, stop).await.is_ok());
        });
    }

    #[cfg(unix)]
    #[test]
    fn a_trace_file_is_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().unwrap();
        let fresh = dir.path().join("fresh.jsonl");
        open_owner_only_append(&fresh).unwrap();
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&fresh), 0o600);
        let old = dir.path().join("old.jsonl");
        std::fs::write(&old, "{}\n").unwrap();
        std::fs::set_permissions(&old, std::fs::Permissions::from_mode(0o644)).unwrap();
        open_owner_only_append(&old).unwrap();
        assert_eq!(mode(&old), 0o600);
    }

    /// The key leaves the environment block itself, not only the variable
    /// list: run in a child process (this test binary again) whose
    /// environment starts with the key, it must be gone from what other
    /// processes can read (`KERN_PROCARGS2`, `/proc/self/environ`).
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn the_env_key_is_wiped_from_the_environment_block() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "code::cli::run::tests::child_takes_the_env_key",
                "--ignored",
                "--test-threads=1",
            ])
            .env(KEY_ENV, "cdm_scrubprobe0123456789")
            .env("SUBROSA_CODE_SCRUB_CHILD", "1")
            .output()
            .unwrap();
        let report = String::from_utf8_lossy(&status.stdout);
        // A filter that matched nothing would pass too: the child must have
        // run its one test.
        assert!(
            report.contains("1 passed"),
            "the child test did not run: {report}"
        );
        assert!(
            status.status.success(),
            "the child still exposed the key: {report}"
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    #[ignore = "run by the_env_key_is_wiped_from_the_environment_block"]
    fn child_takes_the_env_key() {
        if std::env::var_os("SUBROSA_CODE_SCRUB_CHILD").is_none() {
            return;
        }
        let probe = b"cdm_scrubprobe0123456789";
        let contains = |haystack: &[u8]| haystack.windows(probe.len()).any(|w| w == probe);
        assert!(
            contains(&own_environment_block().unwrap()),
            "probe not set up"
        );
        let key = take_env_key().unwrap();
        assert_eq!(key.expose_str(), "cdm_scrubprobe0123456789");
        assert!(std::env::var(KEY_ENV).is_err());
        assert!(!contains(&own_environment_block().unwrap()));
    }

    /// What another process of the user reads of this one's environment.
    #[cfg(target_os = "macos")]
    fn own_environment_block() -> Option<Vec<u8>> {
        let pid = libc::c_int::try_from(std::process::id()).ok()?;
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
        let mut size: libc::size_t = 0;
        // SAFETY: a size query, then a read into a buffer of that size.
        #[allow(unsafe_code)]
        unsafe {
            if libc::sysctl(
                mib.as_mut_ptr(),
                3,
                std::ptr::null_mut(),
                &mut size,
                std::ptr::null_mut(),
                0,
            ) != 0
            {
                return None;
            }
            let mut buffer = vec![0u8; size];
            if libc::sysctl(
                mib.as_mut_ptr(),
                3,
                buffer.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            ) != 0
            {
                return None;
            }
            buffer.truncate(size);
            Some(buffer)
        }
    }

    #[cfg(target_os = "linux")]
    fn own_environment_block() -> Option<Vec<u8>> {
        std::fs::read("/proc/self/environ").ok()
    }

    /// A real, free start: the installed runtime under the CLI's profile
    /// (plan mode: the folder denied, the app's venv not granted, no `.pyc`
    /// written), its gateway answering, no prompt sent, so nothing billed.
    /// Ignored by default: it needs the runtime the app installs. Run with
    /// `cargo test --features code-cli --lib -- --ignored a_real_runtime`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "starts the installed agent runtime"]
    fn a_real_runtime_starts_under_the_cli_profile_and_its_gateway_answers() {
        let Some(app_data) = default_data_dir() else {
            return;
        };
        let installed = app_data.join("hermes-runtime");
        if !installed.join("runtime.json").exists() {
            eprintln!("no installed runtime in {}; skipped", installed.display());
            return;
        }
        // A data folder of its own, so a run in progress in the app's is not
        // disturbed; the runtime is the installed one, by a link.
        let data = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(&installed, data.path().join("hermes-runtime")).unwrap();
        let work = tempfile::tempdir().unwrap();
        let work_dir = work.path().canonicalize().unwrap();
        let venv = installed.canonicalize().unwrap();
        let started = std::time::SystemTime::now();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let proxy = headless::start_provider_proxy("kimi-k2-7-code".into())
                .await
                .unwrap();
            let mut hermes = headless::start_runtime(HeadlessOptions {
                data_dir: data.path(),
                working_dir: &work_dir,
                write_grant: false,
                model: "kimi-k2-7-code",
                proxy_port: proxy.port,
                proxy_token: &proxy.token,
            })
            .await
            .unwrap();
            assert!(hermes.sandboxed);
            let mut gateway = Gateway::connect(hermes.port, &hermes.gateway_path())
                .await
                .unwrap();
            let listed = gateway
                .request("session.list", json!({}), REQUEST_TIMEOUT)
                .await;
            assert!(listed.is_ok(), "the gateway did not answer: {listed:?}");
            gateway.close().await;
            hermes.shutdown();
        });
        let profile =
            std::fs::read_to_string(data.path().join("code-cli/hermes-sandbox.sb")).unwrap();
        assert!(profile.contains(&format!(
            "(deny file-write* (subpath \"{}\"))",
            work_dir.display()
        )));
        assert!(std::fs::read_dir(&work_dir).unwrap().next().is_none());
        let written = newer_files(&venv, started);
        assert!(
            written.is_empty(),
            "the runtime wrote its venv: {written:?}"
        );
    }

    #[cfg(target_os = "macos")]
    fn newer_files(dir: &Path, since: std::time::SystemTime) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(meta) = entry.metadata() else { continue };
                if meta.is_dir() {
                    stack.push(entry.path());
                } else if meta.modified().is_ok_and(|modified| modified > since) {
                    found.push(entry.path());
                }
            }
        }
        found
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
