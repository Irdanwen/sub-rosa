//! Assignments (ADR-0091): a standing goal the assistant works on again and
//! again, and the scheduled tasks a phone keeps.
//!
//! An **assignment** is a goal, a cadence, an autonomy ("ask before anything
//! leaves the device", or "act within these tools"), the tools it may use, and
//! a results inbox: each run's answer waits for Approve or Reject, and what
//! the person says is read back by the next run. A **scheduled task** is the
//! same row with `kind = task`: it runs and notifies, nothing to review.
//!
//! The product owner's rule shapes everything here: **an assignment runs only
//! while an app is open**, and the desktop sitting in the menu bar counts. No
//! server runs anything (ADR-0049). So:
//!
//! - **The app owns the clock** ([`schedule`]). A slot is due when the device
//!   that runs the row looks and finds it unrun; a missed morning becomes one
//!   late run, never seven ([`tick`], from the sweep and from [`start_clock`]).
//! - **One device runs a row**, the one it names, so nothing races. On the
//!   desktop a run is a one-shot Hermes cron job ([`hermes`]); on the phone it
//!   is an agent-lite chat ([`lite`]). Either way the row comes first and the
//!   work rides on something durable (ADR-0018).
//! - **A phone's assignment can run on the computer.** The row is addressed to
//!   it like an errand (ADR-0054): the computer runs one another device wrote
//!   only when its owner accepts work from other devices, each slot runs once
//!   (`assignment_slot_runs`, never synchronised), and only the latest slot is
//!   ever owed. "Run now" from the phone is a real errand. When the computer
//!   leaves a slot unrun, the phone catches it up in the foreground, late and
//!   saying so.
//! - **Feedback is the loop.** A review travels with the run's row, so the
//!   phone can approve what the desktop found; an approval of an "ask first"
//!   proposal is carried out by the next tick on the device that runs it.

#[cfg(desktop)]
mod hermes;

/// What every desktop run's Hermes job name starts with. A machine tag,
/// never translated: Hermes titles the run's session from the job name, and
/// the tag is how the webview keeps these runs out of the Routines list and
/// history and shows the session under the assignment's own title
/// (`ASSIGNMENT_JOB_TAG` in `src/lib/hermes-routines.ts`), and how the daily
/// brief tells them from routines (ADR-0091).
pub const ASSIGNMENT_JOB_TAG: &str = "[assignment] ";
pub mod lite;
pub mod prompt;
pub mod schedule;
pub mod store;
#[cfg(test)]
mod tests;

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::SqlitePool;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

use crate::domain::types::AppError;
use prompt::{Autonomy, RunPrompt};
use schedule::Role;
use store::{AssignmentRow, NewRun, RunRow};

/// Emitted whenever an assignment or a run changes. The screens read the rows
/// again: the event says when to look, never what is true.
pub const ASSIGNMENTS_EVENT: &str = "june://assignments";

/// The address an errand carries when it asks another device to run an
/// assignment now. A device too old to know it hands it to the import rail,
/// which refuses it and says so: the asker gets an answer, not silence.
pub const ERRAND_PREFIX: &str = "subrosa://assignment/";

const MAX_TITLE_CHARS: usize = 120;
const MAX_GOAL_CHARS: usize = 4_000;
/// A phone run left pending this long is closed as failed. A turn the sweep
/// can still finish finishes well inside it.
const PHONE_RUN_TIMEOUT_HOURS: i64 = 6;
/// A run with no handle this long after it was claimed never started.
const START_TIMEOUT_MINUTES: i64 = 10;

/// Whether this device runs any assignment on a schedule. Read by iOS while it
/// decides whether to ask for a background refresh, so it is in memory.
static SCHEDULED_HERE: AtomicBool = AtomicBool::new(false);
static TICKING: AtomicBool = AtomicBool::new(false);

pub fn has_scheduled_work() -> bool {
    SCHEDULED_HERE.load(Ordering::SeqCst)
}

fn error(code: &str) -> AppError {
    // One literal per code, so the catalog can translate each (ADR-0047).
    match code {
        "assignment_goal_missing" => AppError::new(
            "assignment_goal_missing",
            "Say what the assignment should work on.",
        ),
        "assignment_cadence_invalid" => {
            AppError::new("assignment_cadence_invalid", "Choose how often it runs.")
        }
        "assignment_not_found" => {
            AppError::new("assignment_not_found", "That assignment no longer exists.")
        }
        "assignment_no_account" => AppError::new(
            "assignment_no_account",
            "Connect your account on both devices to run it on your other device.",
        ),
        "assignment_runtime_missing" => AppError::new(
            "assignment_runtime_missing",
            "The assistant is not running on this computer yet. Try again in a moment.",
        ),
        _ => AppError::new("assignment_failed", "That assignment could not be saved."),
    }
}

async fn pool(app: &AppHandle) -> Result<SqlitePool, AppError> {
    Ok(crate::commands::repositories(app).await?.pool.clone())
}

/// This device's id in the account, or empty with no account.
async fn this_device(pool: &SqlitePool) -> String {
    query("SELECT device_id FROM account_sync_control WHERE id=1")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .and_then(|row| row.get::<Option<String>, _>("device_id"))
        .unwrap_or_default()
}

/// What "ran on" says: the kind of device, which every screen can translate.
fn device_kind() -> &'static str {
    if cfg!(mobile) {
        "phone"
    } else {
        "computer"
    }
}

/// Whether the device `me` runs this row on its schedule.
pub fn runs_here(row: &AssignmentRow, me: &str) -> bool {
    row.device_id.is_empty() || row.device_id == me
}

fn emit(app: &AppHandle) {
    let _ = app.emit(ASSIGNMENTS_EVENT, ());
}

// --- Saving ------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignmentInput {
    pub id: Option<String>,
    pub kind: Option<String>,
    pub title: String,
    pub goal: String,
    pub cadence: String,
    pub at_minute: Option<u32>,
    pub weekday: Option<u32>,
    pub every_hours: Option<u32>,
    pub autonomy: String,
    pub tools: Vec<String>,
    /// Another of your devices to run it. Absent: this one.
    pub device_id: Option<String>,
    pub device_name: Option<String>,
}

fn clip(text: &str, limit: usize) -> String {
    text.trim().chars().take(limit).collect()
}

/// The row a save writes, from what the form sent and what was there. Pure,
/// so the rules are tested: a missing title comes from the goal, unknown
/// tools are dropped, "this device" is stored as this device's id, and the
/// device that first wrote a row stays its origin.
pub fn normalize(
    input: &AssignmentInput,
    existing: Option<&AssignmentRow>,
    me: &str,
    now: &str,
) -> Result<AssignmentRow, AppError> {
    let goal = clip(&input.goal, MAX_GOAL_CHARS);
    if goal.is_empty() {
        return Err(error("assignment_goal_missing"));
    }
    let cadence = schedule::Cadence::parse(&input.cadence)
        .ok_or_else(|| error("assignment_cadence_invalid"))?;
    let title = match clip(&input.title, MAX_TITLE_CHARS) {
        title if title.is_empty() => goal
            .lines()
            .next()
            .map(|line| clip(line, 60))
            .unwrap_or_default(),
        title => title,
    };
    let kind = match input.kind.as_deref() {
        Some("task") => "task",
        _ => "assignment",
    };
    let mut tools: Vec<String> = Vec::new();
    for tool in &input.tools {
        if prompt::TOOL_GROUPS.iter().any(|group| group.id == tool) && !tools.contains(tool) {
            tools.push(tool.clone());
        }
    }
    let (device_id, device_name) = match input.device_id.as_deref().map(str::trim) {
        Some(device) if !device.is_empty() && device != me => {
            if me.is_empty() {
                return Err(error("assignment_no_account"));
            }
            (
                device.to_string(),
                clip(input.device_name.as_deref().unwrap_or_default(), 80),
            )
        }
        // This device: keep the name another device gave it, if any.
        _ => (
            me.to_string(),
            existing
                .filter(|row| row.device_id == me)
                .map(|row| row.device_name.clone())
                .unwrap_or_default(),
        ),
    };
    Ok(AssignmentRow {
        id: existing
            .map(|row| row.id.clone())
            .or_else(|| input.id.clone().filter(|id| !id.is_empty()))
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        kind: kind.into(),
        title,
        goal,
        cadence: cadence.as_str().into(),
        at_minute: i64::from(input.at_minute.unwrap_or(9 * 60).min(24 * 60 - 1)),
        weekday: i64::from(input.weekday.unwrap_or(1) % 7),
        every_hours: i64::from(input.every_hours.unwrap_or(4).clamp(1, 24)),
        autonomy: Autonomy::parse(&input.autonomy).as_str().into(),
        tools,
        device_id,
        device_name,
        origin_device_id: existing
            .map_or_else(|| me.to_string(), |row| row.origin_device_id.clone()),
        paused: existing.is_some_and(|row| row.paused),
        active_since: existing.map_or_else(|| now.to_string(), |row| row.active_since.clone()),
        created_at: existing.map_or_else(|| now.to_string(), |row| row.created_at.clone()),
        updated_at: now.to_string(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignmentDto {
    #[serde(flatten)]
    pub row: AssignmentRow,
    /// The next slot, when this device can say (it runs the row, or the row
    /// is on its own clock).
    pub next_run_at: Option<String>,
    /// This device runs it on its schedule.
    pub runs_here: bool,
    /// Another device wrote it, and this one does not accept work from other
    /// devices yet, so it waits.
    pub waiting_for_consent: bool,
    /// Results waiting for a verdict.
    pub waiting: i64,
    pub last_run: Option<RunRow>,
}

async fn dtos(app: &AppHandle, pool: &SqlitePool) -> Result<Vec<AssignmentDto>, AppError> {
    let me = this_device(pool).await;
    let accepts_others = crate::errands::settings(app).enabled;
    let mut summaries = store::summaries(pool).await?;
    let now = chrono::Local::now();
    Ok(store::list(pool)
        .await?
        .into_iter()
        .map(|row| {
            let (waiting, last_run) = summaries.remove(&row.id).unwrap_or((0, None));
            let next_run_at = (!row.paused)
                .then(|| row.schedule())
                .flatten()
                .and_then(|schedule| schedule.next_after(&now))
                .map(|slot| slot.with_timezone(&chrono::Utc).to_rfc3339());
            let here = runs_here(&row, &me);
            let foreign = !row.origin_device_id.is_empty() && row.origin_device_id != me;
            AssignmentDto {
                runs_here: here,
                waiting_for_consent: here && foreign && !accepts_others,
                next_run_at,
                waiting,
                last_run,
                row,
            }
        })
        .collect())
}

async fn dto(app: &AppHandle, pool: &SqlitePool, id: &str) -> Result<AssignmentDto, AppError> {
    dtos(app, pool)
        .await?
        .into_iter()
        .find(|dto| dto.row.id == id)
        .ok_or_else(|| error("assignment_not_found"))
}

// --- Running -----------------------------------------------------------------

/// What asked for a run. Each becomes the run's slot key, which is what makes
/// it single use.
enum Slot {
    Due(schedule::Due),
    Now,
    Errand(String),
    Approved(Box<RunRow>),
    /// A connector event (ADR-0092): its trigger and the item it saw.
    Event(String),
}

/// Whether a run can start on this device right now.
async fn can_run_now(app: &AppHandle) -> bool {
    #[cfg(desktop)]
    {
        hermes::available(app).await
    }
    #[cfg(mobile)]
    {
        let _ = app;
        true
    }
}

async fn platform_start(
    app: &AppHandle,
    row: &AssignmentRow,
    prompt_text: &str,
    groups: &[&prompt::ToolGroup],
) -> Result<String, AppError> {
    #[cfg(desktop)]
    {
        hermes::start(
            app,
            &row.title,
            prompt_text,
            prompt::hermes_toolsets(groups),
        )
        .await
    }
    #[cfg(mobile)]
    {
        lite::start(app, &row.title, prompt_text, prompt::lite_tools(groups)).await
    }
}

/// Start one run, once. Returns the run's id, or `None` when the slot was
/// already taken (by this device, or by an overlapping tick).
async fn start_run(
    app: &AppHandle,
    pool: &SqlitePool,
    row: &AssignmentRow,
    slot: Slot,
    me: &str,
) -> Result<Option<String>, AppError> {
    let (key, late, approved) = match slot {
        Slot::Due(due) => (schedule::slot_key(&due.slot), due.late, None),
        Slot::Now => (
            format!("now:{}", chrono::Utc::now().to_rfc3339()),
            false,
            None,
        ),
        Slot::Errand(id) => (format!("errand:{id}"), false, None),
        Slot::Event(key) => (format!("event:{key}"), false, None),
        Slot::Approved(run) => (format!("approved:{}", run.id), false, Some(*run)),
    };
    let run_id = store::run_id(&row.id, &key);
    if !store::claim_slot(pool, &row.id, &key, &run_id).await? {
        return Ok(None);
    }
    store::insert_run(
        pool,
        &NewRun {
            id: &run_id,
            assignment_id: &row.id,
            slot: &key,
            late,
            device_id: me,
            device_name: device_kind(),
        },
    )
    .await?;
    emit(app);
    let reviewed = store::reviewed_for_prompt(pool, &row.id, prompt::FEEDBACK_IN_PROMPT as i64)
        .await
        .unwrap_or_default();
    let autonomy = if approved.is_some() {
        Autonomy::Act
    } else {
        row.autonomy()
    };
    let late_for = late.then(|| {
        chrono::DateTime::parse_from_rfc3339(&key)
            .map(|slot| {
                slot.with_timezone(&chrono::Local)
                    .format("%Y-%m-%d %H:%M")
                    .to_string()
            })
            .unwrap_or_else(|_| key.clone())
    });
    let proposal = approved.as_ref().and_then(|run| run.result.clone());
    let text = prompt::run_prompt(&RunPrompt {
        kind: &row.kind,
        title: &row.title,
        goal: &row.goal,
        autonomy,
        late_for: late_for.as_deref(),
        reviewed: &reviewed,
        approved_proposal: proposal.as_deref(),
    });
    let groups = prompt::effective_groups(&row.tools, autonomy);
    match platform_start(app, row, &text, &groups).await {
        Ok(handle) => store::set_handle(pool, &run_id, &handle).await?,
        Err(failure) => {
            if store::finish_run(pool, &run_id, "failed", None, Some(&failure.message)).await? {
                notify_failed(app, row, &failure.message);
            }
            emit(app);
        }
    }
    Ok(Some(run_id))
}

/// Close the runs this device started that have finished.
async fn harvest(app: &AppHandle, pool: &SqlitePool, me: &str) {
    let Ok(running) = store::running_here(pool, me).await else {
        return;
    };
    for run in running {
        let started = chrono::DateTime::parse_from_rfc3339(&run.started_at).ok();
        let older_than = |hours: i64, minutes: i64| {
            started.is_some_and(|at| {
                chrono::Utc::now().signed_duration_since(at)
                    > chrono::Duration::hours(hours) + chrono::Duration::minutes(minutes)
            })
        };
        let Some(handle) = run.handle.clone() else {
            if older_than(0, START_TIMEOUT_MINUTES) {
                let _ = store::finish_run(
                    pool,
                    &run.id,
                    "failed",
                    None,
                    Some("The run did not start."),
                )
                .await;
                emit(app);
            }
            continue;
        };
        #[cfg(desktop)]
        let outcome = hermes::poll(app, &handle, &run.started_at).await;
        #[cfg(mobile)]
        let outcome = lite::poll(app, &handle).await;
        let Ok(Some(row)) = store::get(pool, &run.assignment_id).await else {
            continue;
        };
        match outcome {
            lite::Outcome::Pending => {
                // A turn the phone suspended under: picked up again here, with
                // the run's own tools, before the chat resume would take it.
                #[cfg(mobile)]
                {
                    let autonomy = if run.slot.starts_with("approved:") {
                        Autonomy::Act
                    } else {
                        row.autonomy()
                    };
                    let groups = prompt::effective_groups(&row.tools, autonomy);
                    lite::resume_if_interrupted(app, &handle, prompt::lite_tools(&groups)).await;
                }
                if cfg!(mobile) && older_than(PHONE_RUN_TIMEOUT_HOURS, 0) {
                    let _ = store::finish_run(
                        pool,
                        &run.id,
                        "failed",
                        None,
                        Some("The run did not finish in time."),
                    )
                    .await;
                    emit(app);
                }
            }
            lite::Outcome::Answer(answer) => {
                let state = if row.reviewed() && !run.slot.starts_with("approved:") {
                    "needs_review"
                } else {
                    "done"
                };
                if store::finish_run(pool, &run.id, state, Some(&answer), None)
                    .await
                    .unwrap_or(false)
                {
                    notify_finished(app, &row, state, &answer, &handle);
                }
                emit(app);
            }
            lite::Outcome::Failed(message) => {
                if store::finish_run(pool, &run.id, "failed", None, Some(&message))
                    .await
                    .unwrap_or(false)
                {
                    notify_failed(app, &row, &message);
                }
                emit(app);
            }
        }
    }
}

fn notify(app: &AppHandle, title: &str, body: &str, destination: String) {
    let _ = app
        .notification()
        .builder()
        .title(title.to_string())
        .body(body.to_string())
        .extra(crate::destinations::EXTRA_KEY, destination)
        .show();
}

fn notify_finished(app: &AppHandle, row: &AssignmentRow, state: &str, answer: &str, handle: &str) {
    let summary = prompt::result_summary(answer);
    if state == "needs_review" {
        notify(
            app,
            &row.title,
            &review_body(&summary),
            crate::destinations::today(),
        );
    } else {
        // On the phone the run is a chat, and the tap opens it.
        let destination = if cfg!(mobile) {
            crate::destinations::chat(Some(handle))
        } else {
            crate::destinations::today()
        };
        notify(app, &row.title, &summary, destination);
    }
}

fn notify_failed(app: &AppHandle, row: &AssignmentRow, message: &str) {
    notify(
        app,
        &row.title,
        &failed_body(message),
        crate::destinations::today(),
    );
}

/// What a result waiting for review says, in the app's language.
pub(crate) fn review_body(summary: &str) -> String {
    if summary.is_empty() {
        crate::tr!("A result is waiting for your review.")
    } else {
        crate::tr!("To review: {summary}", summary = summary)
    }
}

/// What a failed run says. The stored reason is one of the sentences this
/// module writes (kept in English in the row, the webview translates it
/// too), or a provider's own words, which pass as they came.
pub(crate) fn failed_body(message: &str) -> String {
    crate::tr!(
        "This run did not finish. {reason}",
        reason = crate::i18n::translate_known(message)
    )
}

/// Run what is due here, close what has finished, and carry out what was
/// approved. Idempotent and non-reentrant: two overlapping calls do the work
/// once. Called by the background sweep and by [`start_clock`].
pub async fn tick(app: &AppHandle) {
    if TICKING.swap(true, Ordering::SeqCst) {
        return;
    }
    struct Release;
    impl Drop for Release {
        fn drop(&mut self) {
            TICKING.store(false, Ordering::SeqCst);
        }
    }
    let _release = Release;
    let Ok(pool) = pool(app).await else {
        return;
    };
    let me = this_device(&pool).await;
    if !me.is_empty() {
        let _ = store::adopt_unaddressed(&pool, &me).await;
    }
    harvest(app, &pool, &me).await;
    let Ok(rows) = store::list(&pool).await else {
        return;
    };
    let ready = can_run_now(app).await;
    let accepts_others = crate::errands::settings(app).enabled;
    let now = chrono::Local::now();
    let mut scheduled_here = false;
    for row in rows.iter().filter(|row| !row.paused) {
        let role = if runs_here(row, &me) {
            Role::Executor
        } else if cfg!(mobile) && !me.is_empty() && row.origin_device_id == me {
            Role::Fallback
        } else {
            continue;
        };
        scheduled_here = true;
        // A row another device wrote runs here only with the standing consent
        // this machine's owner gives errands (ADR-0054).
        let foreign = !row.origin_device_id.is_empty() && row.origin_device_id != me;
        if role == Role::Executor && foreign && !accepts_others {
            continue;
        }
        let (Some(schedule), Ok(active_since)) = (
            row.schedule(),
            chrono::DateTime::parse_from_rfc3339(&row.active_since),
        ) else {
            continue;
        };
        let Ok(ran) = store::ran_slots(&pool, &row.id).await else {
            continue;
        };
        let Some(due) = schedule::due(
            &schedule,
            active_since.with_timezone(&chrono::Utc),
            &now,
            |key| ran.contains(key),
            role,
        ) else {
            continue;
        };
        if !ready {
            continue;
        }
        if let Err(failure) = start_run(app, &pool, row, Slot::Due(due), &me).await {
            tracing::warn!(code = %failure.code, "assignment run did not start");
        }
    }
    if ready {
        if let Ok(approved) = store::pending_carry_outs(&pool).await {
            for run in approved {
                let Some(row) = rows.iter().find(|row| row.id == run.assignment_id) else {
                    continue;
                };
                if !runs_here(row, &me) {
                    continue;
                }
                let _ = start_run(app, &pool, row, Slot::Approved(Box::new(run)), &me).await;
            }
        }
    }
    SCHEDULED_HERE.store(scheduled_here, Ordering::SeqCst);
}

/// The clock while an app is open: a tick a minute, plus the daily brief and
/// the errands other devices sent. It holds no state (every step reads its
/// rows), so a suspended phone that wakes up loses nothing; the sweep covers
/// launches and resumes.
pub fn start_clock(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            tick(&app).await;
            crate::moments::daily::tick(&app).await;
            crate::errands::run_pending(&app).await;
        }
    });
}

// --- Errands -----------------------------------------------------------------

/// The assignment an errand asks for, when its address is one of ours.
pub fn errand_assignment(url: &str) -> Option<&str> {
    let id = url.strip_prefix(ERRAND_PREFIX)?;
    (!id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .then_some(id)
}

/// Write an errand asking the device that runs `row` to run it now. The row
/// is an ordinary errand (ADR-0054): addressed, single use and perishable.
pub async fn insert_errand(pool: &SqlitePool, row: &AssignmentRow) -> Result<String, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    query("INSERT INTO account_errands(id,device_id,url,requested_by,requested_at,state,updated_at) VALUES(?,?,?,?,?,'requested',?)")
        .bind(&id)
        .bind(&row.device_id)
        .bind(format!("{ERRAND_PREFIX}{}", row.id))
        .bind(device_kind())
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await?;
    Ok(id)
}

/// The receiving end: run the assignment an errand names. Errors become the
/// errand's refusal, in words the asker reads.
pub async fn run_for_errand(
    app: &AppHandle,
    assignment_id: &str,
    errand_id: &str,
) -> Result<String, AppError> {
    let pool = pool(app).await?;
    let row = store::get(&pool, assignment_id)
        .await?
        .ok_or_else(|| error("assignment_not_found"))?;
    let me = this_device(&pool).await;
    start_run(app, &pool, &row, Slot::Errand(errand_id.to_string()), &me)
        .await?
        .ok_or_else(|| error("assignment_not_found"))
}

/// Whether this device evaluates the connector triggers of an assignment:
/// the device that runs it, under the same consent as its slots.
pub async fn evaluates_here(app: &AppHandle, assignment_id: &str) -> bool {
    let Ok(pool) = pool(app).await else {
        return false;
    };
    let Ok(Some(row)) = store::get(&pool, assignment_id).await else {
        return false;
    };
    let me = this_device(&pool).await;
    let foreign = !row.origin_device_id.is_empty() && row.origin_device_id != me;
    !row.paused && runs_here(&row, &me) && (!foreign || crate::errands::settings(app).enabled)
}

/// Run an assignment because a connector reported something (ADR-0092).
/// Single use per event like any slot; the event's description joins the
/// goal for this run only.
pub async fn run_for_event(
    app: &AppHandle,
    assignment_id: &str,
    event_key: &str,
    summary: &str,
) -> Result<Option<String>, AppError> {
    if !evaluates_here(app, assignment_id).await || !can_run_now(app).await {
        return Ok(None);
    }
    let pool = pool(app).await?;
    let mut row = store::get(&pool, assignment_id)
        .await?
        .ok_or_else(|| error("assignment_not_found"))?;
    row.goal = format!("{}\n\nWhat started this run: {summary}", row.goal);
    let me = this_device(&pool).await;
    start_run(app, &pool, &row, Slot::Event(event_key.to_string()), &me).await
}

/// Whether an errand-started run has landed: `None` while it runs, then its
/// answer or the reason it did not.
pub async fn errand_outcome(pool: &SqlitePool, run_id: &str) -> Option<Result<(), String>> {
    match store::run(pool, run_id).await.ok().flatten() {
        Some(run) if run.state == "running" => None,
        Some(run) if run.state == "failed" => Some(Err(run
            .error
            .unwrap_or_else(|| "The run did not finish on that device.".into()))),
        Some(_) => Some(Ok(())),
        None => Some(Err("The run was deleted on that device.".into())),
    }
}

/// Whether a run can start for an errand now. When the runtime is not up yet
/// the errand waits for the next sweep instead of being refused.
pub async fn ready_for_errand(app: &AppHandle) -> bool {
    can_run_now(app).await
}

// --- Commands ------------------------------------------------------------------

#[tauri::command]
pub async fn assignment_list(app: AppHandle) -> Result<Vec<AssignmentDto>, AppError> {
    dtos(&app, &pool(&app).await?).await
}

#[tauri::command]
pub async fn assignment_save(
    app: AppHandle,
    request: AssignmentInput,
) -> Result<AssignmentDto, AppError> {
    let pool = pool(&app).await?;
    let me = this_device(&pool).await;
    let existing = match request.id.as_deref() {
        Some(id) => store::get(&pool, id).await?,
        None => None,
    };
    let row = normalize(
        &request,
        existing.as_ref(),
        &me,
        &chrono::Utc::now().to_rfc3339(),
    )?;
    store::upsert(&pool, &row).await?;
    emit(&app);
    dto(&app, &pool, &row.id).await
}

#[tauri::command]
pub async fn assignment_delete(app: AppHandle, id: String) -> Result<(), AppError> {
    let pool = pool(&app).await?;
    store::delete(&pool, &id).await?;
    emit(&app);
    Ok(())
}

#[tauri::command]
pub async fn assignment_set_paused(
    app: AppHandle,
    id: String,
    paused: bool,
) -> Result<AssignmentDto, AppError> {
    let pool = pool(&app).await?;
    store::set_paused(&pool, &id, paused).await?;
    emit(&app);
    dto(&app, &pool, &id).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunNowDto {
    /// `started` here, or `sent` to the device that runs it.
    pub outcome: String,
    pub device_name: String,
}

#[tauri::command]
pub async fn assignment_run_now(app: AppHandle, id: String) -> Result<RunNowDto, AppError> {
    let pool = pool(&app).await?;
    let row = store::get(&pool, &id)
        .await?
        .ok_or_else(|| error("assignment_not_found"))?;
    let me = this_device(&pool).await;
    if runs_here(&row, &me) {
        if !can_run_now(&app).await {
            return Err(error("assignment_runtime_missing"));
        }
        start_run(&app, &pool, &row, Slot::Now, &me).await?;
        return Ok(RunNowDto {
            outcome: "started".into(),
            device_name: String::new(),
        });
    }
    insert_errand(&pool, &row).await?;
    // Leave now rather than at the next sync: the point is that the other
    // machine starts while you are still holding the phone.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = crate::account::sync::run(&handle).await;
    });
    Ok(RunNowDto {
        outcome: "sent".into(),
        device_name: row.device_name,
    })
}

#[tauri::command]
pub async fn assignment_runs(
    app: AppHandle,
    assignment_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<RunRow>, AppError> {
    store::runs(
        &pool(&app).await?,
        assignment_id.as_deref(),
        i64::from(limit.unwrap_or(50).min(200)),
    )
    .await
}

#[tauri::command]
pub async fn assignment_inbox(app: AppHandle) -> Result<Vec<RunRow>, AppError> {
    Ok(store::needs_review(&pool(&app).await?)
        .await?
        .into_iter()
        .map(|(run, _)| run)
        .collect())
}

#[tauri::command]
pub async fn assignment_review(
    app: AppHandle,
    run_id: String,
    approve: bool,
    feedback: Option<String>,
) -> Result<RunRow, AppError> {
    let pool = pool(&app).await?;
    let run = store::review(&pool, &run_id, approve, feedback.as_deref())
        .await?
        .ok_or_else(|| error("assignment_not_found"))?;
    emit(&app);
    // An approved "ask first" proposal is carried out by the device that runs
    // the assignment; when that is this one, now.
    if approve {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move { tick(&handle).await });
    }
    Ok(run)
}
