//! The rows of assignments and their runs (migration 060). What an assignment
//! has done is always what these tables say; whether a run is alive right now
//! is asked of the process that runs it, never of a column (ADR-0018).

use std::collections::HashSet;

use chrono::Utc;
use serde::Serialize;
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::SqlitePool;

use super::prompt::{Autonomy, Reviewed};
use super::schedule::{Cadence, Schedule};
use crate::domain::types::AppError;

/// How long an approval waits to be carried out before it perishes.
const CARRY_OUT_DAYS: i64 = 7;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssignmentRow {
    pub id: String,
    /// `assignment` (its results are reviewed) or `task` (a scheduled task).
    pub kind: String,
    pub title: String,
    pub goal: String,
    pub cadence: String,
    pub at_minute: i64,
    pub weekday: i64,
    pub every_hours: i64,
    pub autonomy: String,
    pub tools: Vec<String>,
    /// The device that runs it; empty means this device, with no account.
    pub device_id: String,
    pub device_name: String,
    pub origin_device_id: String,
    pub paused: bool,
    pub active_since: String,
    pub created_at: String,
    pub updated_at: String,
}

impl AssignmentRow {
    pub fn schedule(&self) -> Option<Schedule> {
        Some(Schedule {
            cadence: Cadence::parse(&self.cadence)?,
            at_minute: self.at_minute.clamp(0, 24 * 60 - 1) as u32,
            weekday: self.weekday.clamp(0, 6) as u32,
            every_hours: self.every_hours.clamp(1, 24) as u32,
        })
    }

    pub fn autonomy(&self) -> Autonomy {
        Autonomy::parse(&self.autonomy)
    }

    pub fn reviewed(&self) -> bool {
        self.kind != "task"
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    pub assignment_id: String,
    pub slot: String,
    pub late: bool,
    pub device_id: String,
    /// `phone` or `computer`: what the person reads as "ran on your phone".
    pub device_name: String,
    pub handle: Option<String>,
    pub state: String,
    pub result: Option<String>,
    pub error: Option<String>,
    pub feedback: Option<String>,
    pub reviewed_at: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub updated_at: String,
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn row_to_assignment(row: &sqlx_sqlite::SqliteRow) -> AssignmentRow {
    let tools: String = row.get("tools");
    let paused: i64 = row.get("paused");
    AssignmentRow {
        id: row.get("id"),
        kind: row.get("kind"),
        title: row.get("title"),
        goal: row.get("goal"),
        cadence: row.get("cadence"),
        at_minute: row.get("at_minute"),
        weekday: row.get("weekday"),
        every_hours: row.get("every_hours"),
        autonomy: row.get("autonomy"),
        tools: serde_json::from_str(&tools).unwrap_or_default(),
        device_id: row.get("device_id"),
        device_name: row.get("device_name"),
        origin_device_id: row.get("origin_device_id"),
        paused: paused != 0,
        active_since: row.get("active_since"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn row_to_run(row: &sqlx_sqlite::SqliteRow) -> RunRow {
    let late: i64 = row.get("late");
    RunRow {
        id: row.get("id"),
        assignment_id: row.get("assignment_id"),
        slot: row.get("slot"),
        late: late != 0,
        device_id: row.get("device_id"),
        device_name: row.get("device_name"),
        handle: row.get("handle"),
        state: row.get("state"),
        result: row.get("result"),
        error: row.get("error"),
        feedback: row.get("feedback"),
        reviewed_at: row.get("reviewed_at"),
        started_at: row.get("started_at"),
        finished_at: row.get("finished_at"),
        updated_at: row.get("updated_at"),
    }
}

/// A run's id comes from its assignment and its slot, so two devices that
/// both ran one slot wrote one object, which synchronisation can reconcile,
/// rather than two results that both look genuine.
pub fn run_id(assignment_id: &str, slot: &str) -> String {
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_OID,
        format!("subrosa:assignment-run:{assignment_id}:{slot}").as_bytes(),
    )
    .to_string()
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<AssignmentRow>, AppError> {
    let rows = query("SELECT * FROM assignments ORDER BY created_at DESC")
        .fetch_all(pool)
        .await?;
    Ok(rows.iter().map(row_to_assignment).collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<AssignmentRow>, AppError> {
    Ok(query("SELECT * FROM assignments WHERE id=?")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .as_ref()
        .map(row_to_assignment))
}

/// Writes the row as given: an insert for a new id, an update otherwise. A
/// write that changes nothing changes nothing, so it queues no revision.
pub async fn upsert(pool: &SqlitePool, row: &AssignmentRow) -> Result<(), AppError> {
    let tools = serde_json::to_string(&row.tools).unwrap_or_else(|_| "[]".into());
    query(
        "INSERT INTO assignments(id,kind,title,goal,cadence,at_minute,weekday,every_hours,autonomy,tools,device_id,device_name,origin_device_id,paused,active_since,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,goal=excluded.goal,cadence=excluded.cadence,at_minute=excluded.at_minute,weekday=excluded.weekday,every_hours=excluded.every_hours,autonomy=excluded.autonomy,tools=excluded.tools,device_id=excluded.device_id,device_name=excluded.device_name,paused=excluded.paused,active_since=excluded.active_since,updated_at=excluded.updated_at",
    )
    .bind(&row.id)
    .bind(&row.kind)
    .bind(&row.title)
    .bind(&row.goal)
    .bind(&row.cadence)
    .bind(row.at_minute)
    .bind(row.weekday)
    .bind(row.every_hours)
    .bind(&row.autonomy)
    .bind(tools)
    .bind(&row.device_id)
    .bind(&row.device_name)
    .bind(&row.origin_device_id)
    .bind(i64::from(row.paused))
    .bind(&row.active_since)
    .bind(&row.created_at)
    .bind(&row.updated_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// Deleting an assignment takes its history with it: every run is a
/// tombstone that travels, so no device keeps a result for nothing.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    query("DELETE FROM assignment_runs WHERE assignment_id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    query("DELETE FROM assignments WHERE id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Pausing stops new slots. Resuming starts the clock again from now, so the
/// slots it was paused through are not owed.
pub async fn set_paused(pool: &SqlitePool, id: &str, paused: bool) -> Result<(), AppError> {
    let now = now();
    if paused {
        query("UPDATE assignments SET paused=1,updated_at=? WHERE id=? AND paused=0")
            .bind(&now)
            .bind(id)
            .execute(pool)
            .await?;
    } else {
        query(
            "UPDATE assignments SET paused=0,active_since=?,updated_at=? WHERE id=? AND paused=1",
        )
        .bind(&now)
        .bind(&now)
        .bind(id)
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// A library with no account wrote rows with no device: once this device has
/// one, they are its own. Only rows this device wrote, so a row that arrived
/// from elsewhere is never taken over.
pub async fn adopt_unaddressed(pool: &SqlitePool, device_id: &str) -> Result<(), AppError> {
    query("UPDATE assignments SET device_id=?,origin_device_id=CASE WHEN origin_device_id='' THEN ? ELSE origin_device_id END,updated_at=? WHERE device_id='' AND origin_device_id IN ('',?)")
        .bind(device_id)
        .bind(device_id)
        .bind(now())
        .bind(device_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Take a slot for this device, once. The primary key answers, so two
/// overlapping ticks cannot both win.
pub async fn claim_slot(
    pool: &SqlitePool,
    assignment_id: &str,
    slot: &str,
    run_id: &str,
) -> Result<bool, AppError> {
    let done = query(
        "INSERT OR IGNORE INTO assignment_slot_runs(assignment_id,slot,run_id,started_at) VALUES(?,?,?,?)",
    )
    .bind(assignment_id)
    .bind(slot)
    .bind(run_id)
    .bind(now())
    .execute(pool)
    .await?;
    Ok(done.rows_affected() == 1)
}

/// Every slot already run, here (the ledger) or anywhere (a run that arrived
/// through synchronisation).
pub async fn ran_slots(
    pool: &SqlitePool,
    assignment_id: &str,
) -> Result<HashSet<String>, AppError> {
    let rows = query(
        "SELECT slot FROM assignment_slot_runs WHERE assignment_id=? UNION SELECT slot FROM assignment_runs WHERE assignment_id=?",
    )
    .bind(assignment_id)
    .bind(assignment_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(|row| row.get("slot")).collect())
}

pub struct NewRun<'a> {
    pub id: &'a str,
    pub assignment_id: &'a str,
    pub slot: &'a str,
    pub late: bool,
    pub device_id: &'a str,
    pub device_name: &'a str,
}

pub async fn insert_run(pool: &SqlitePool, run: &NewRun<'_>) -> Result<(), AppError> {
    let now = now();
    query("INSERT OR IGNORE INTO assignment_runs(id,assignment_id,slot,late,device_id,device_name,state,started_at,updated_at) VALUES(?,?,?,?,?,?,'running',?,?)")
        .bind(run.id)
        .bind(run.assignment_id)
        .bind(run.slot)
        .bind(i64::from(run.late))
        .bind(run.device_id)
        .bind(run.device_name)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn set_handle(pool: &SqlitePool, run_id: &str, handle: &str) -> Result<(), AppError> {
    query("UPDATE assignment_runs SET handle=?,updated_at=? WHERE id=?")
        .bind(handle)
        .bind(now())
        .bind(run_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Close a run: `needs_review`, `done` or `failed`. Only a running run
/// closes, so a late answer cannot overwrite a review someone already gave.
pub async fn finish_run(
    pool: &SqlitePool,
    run_id: &str,
    state: &str,
    result: Option<&str>,
    error: Option<&str>,
) -> Result<bool, AppError> {
    let now = now();
    let done = query("UPDATE assignment_runs SET state=?,result=?,error=?,finished_at=?,updated_at=? WHERE id=? AND state='running'")
        .bind(state)
        .bind(result)
        .bind(error)
        .bind(&now)
        .bind(&now)
        .bind(run_id)
        .execute(pool)
        .await?;
    Ok(done.rows_affected() == 1)
}

pub async fn run(pool: &SqlitePool, run_id: &str) -> Result<Option<RunRow>, AppError> {
    Ok(query("SELECT * FROM assignment_runs WHERE id=?")
        .bind(run_id)
        .fetch_optional(pool)
        .await?
        .as_ref()
        .map(row_to_run))
}

pub async fn runs(
    pool: &SqlitePool,
    assignment_id: Option<&str>,
    limit: i64,
) -> Result<Vec<RunRow>, AppError> {
    let rows = match assignment_id {
        Some(id) => query(
            "SELECT * FROM assignment_runs WHERE assignment_id=? ORDER BY started_at DESC LIMIT ?",
        )
        .bind(id)
        .bind(limit)
        .fetch_all(pool)
        .await?,
        None => {
            query("SELECT * FROM assignment_runs ORDER BY started_at DESC LIMIT ?")
                .bind(limit)
                .fetch_all(pool)
                .await?
        }
    };
    Ok(rows.iter().map(row_to_run).collect())
}

/// The runs this device started and has not closed yet.
pub async fn running_here(pool: &SqlitePool, device_id: &str) -> Result<Vec<RunRow>, AppError> {
    let rows = query(
        "SELECT * FROM assignment_runs WHERE state='running' AND device_id=? ORDER BY started_at",
    )
    .bind(device_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(row_to_run).collect())
}

/// Approve or reject a result, with what the person said. The next run reads
/// it (`reviewed_for_prompt`), wherever it runs: the row travels.
pub async fn review(
    pool: &SqlitePool,
    run_id: &str,
    approve: bool,
    feedback: Option<&str>,
) -> Result<Option<RunRow>, AppError> {
    let now = now();
    let feedback = feedback.map(str::trim).filter(|text| !text.is_empty());
    query("UPDATE assignment_runs SET state=?,feedback=?,reviewed_at=?,updated_at=? WHERE id=? AND state IN ('needs_review','approved','rejected')")
        .bind(if approve { "approved" } else { "rejected" })
        .bind(feedback)
        .bind(&now)
        .bind(&now)
        .bind(run_id)
        .execute(pool)
        .await?;
    run(pool, run_id).await
}

/// What the person said about this assignment's recent results, newest first.
pub async fn reviewed_for_prompt(
    pool: &SqlitePool,
    assignment_id: &str,
    limit: i64,
) -> Result<Vec<Reviewed>, AppError> {
    let rows = query("SELECT * FROM assignment_runs WHERE assignment_id=? AND state IN ('approved','rejected') ORDER BY reviewed_at DESC LIMIT ?")
        .bind(assignment_id)
        .bind(limit)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .iter()
        .map(row_to_run)
        .map(|run| Reviewed {
            when: run
                .reviewed_at
                .as_deref()
                .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
                .map(|at| at.format("%Y-%m-%d").to_string())
                .unwrap_or_default(),
            approved: run.state == "approved",
            feedback: run.feedback,
            result: run.result.as_deref().map(super::prompt::result_summary),
        })
        .collect())
}

/// Approved proposals of "ask first" assignments that nobody has carried out
/// yet, recent enough to still mean what they said.
pub async fn pending_carry_outs(pool: &SqlitePool) -> Result<Vec<RunRow>, AppError> {
    let since = (Utc::now() - chrono::Duration::days(CARRY_OUT_DAYS)).to_rfc3339();
    let rows = query("SELECT r.* FROM assignment_runs r JOIN assignments a ON a.id=r.assignment_id WHERE r.state='approved' AND a.autonomy='ask' AND a.kind<>'task' AND r.slot NOT LIKE 'approved:%' AND r.reviewed_at>=? AND NOT EXISTS(SELECT 1 FROM assignment_runs c WHERE c.assignment_id=r.assignment_id AND c.slot='approved:'||r.id) AND NOT EXISTS(SELECT 1 FROM assignment_slot_runs l WHERE l.assignment_id=r.assignment_id AND l.slot='approved:'||r.id)")
        .bind(since)
        .fetch_all(pool)
        .await?;
    Ok(rows.iter().map(row_to_run).collect())
}

/// The inbox: results waiting for a verdict, newest first, with their
/// assignment's title.
pub async fn needs_review(pool: &SqlitePool) -> Result<Vec<(RunRow, String)>, AppError> {
    let rows = query("SELECT r.*, a.title AS assignment_title FROM assignment_runs r JOIN assignments a ON a.id=r.assignment_id WHERE r.state='needs_review' ORDER BY r.finished_at DESC LIMIT 50")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .iter()
        .map(|row| (row_to_run(row), row.get("assignment_title")))
        .collect())
}

/// Runs that failed since `since`, with their assignment's title.
pub async fn failed_since(
    pool: &SqlitePool,
    since: &str,
) -> Result<Vec<(RunRow, String)>, AppError> {
    let rows = query("SELECT r.*, a.title AS assignment_title FROM assignment_runs r JOIN assignments a ON a.id=r.assignment_id WHERE r.state='failed' AND r.updated_at>=? ORDER BY r.updated_at DESC LIMIT 20")
        .bind(since)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .iter()
        .map(|row| (row_to_run(row), row.get("assignment_title")))
        .collect())
}

/// Per assignment: how many results wait for review, and the newest run.
pub async fn summaries(
    pool: &SqlitePool,
) -> Result<std::collections::HashMap<String, (i64, Option<RunRow>)>, AppError> {
    let mut out = std::collections::HashMap::new();
    for row in query("SELECT assignment_id, count(*) AS waiting FROM assignment_runs WHERE state='needs_review' GROUP BY assignment_id")
        .fetch_all(pool)
        .await?
    {
        out.insert(row.get::<String, _>("assignment_id"), (row.get::<i64, _>("waiting"), None));
    }
    for row in query("SELECT r.* FROM assignment_runs r WHERE r.started_at=(SELECT MAX(started_at) FROM assignment_runs x WHERE x.assignment_id=r.assignment_id)")
        .fetch_all(pool)
        .await?
    {
        let run = row_to_run(&row);
        let id = run.assignment_id.clone();
        out.entry(id).or_insert((0, None)).1 = Some(run);
    }
    Ok(out)
}
