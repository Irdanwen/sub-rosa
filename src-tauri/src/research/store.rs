//! The rows of a research run (migration 057). Every write the engine makes
//! is one of these, so what a run has done is always what the database says.

use chrono::Utc;
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::SqlitePool;

use super::{Depth, ResearchPlan};
use crate::domain::types::AppError;

#[derive(Debug, Clone)]
pub struct RunRow {
    pub id: String,
    pub question: String,
    pub depth: Depth,
    pub status: String,
    pub phase: Option<String>,
    pub use_notes: bool,
    pub project_id: Option<String>,
    pub chat_id: Option<String>,
    pub clarify_questions: Vec<String>,
    pub clarify_answers: Vec<String>,
    pub plan: Option<ResearchPlan>,
    pub model: String,
    pub report_note_id: Option<String>,
    pub cited_sources: i64,
    pub invented_citations: i64,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct StepRow {
    pub id: String,
    pub query: String,
}

#[derive(Debug, Clone)]
pub struct SourceRow {
    pub id: String,
    pub position: i64,
    pub kind: String,
    pub title: String,
    pub url: Option<String>,
    pub note_id: Option<String>,
    pub excerpt: Option<String>,
    pub status: String,
    pub notes: Option<String>,
}

/// A source a search turned up, before it is filed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub kind: &'static str,
    /// What makes two finds the same source: the address, or the note.
    pub key: String,
    pub title: String,
    pub url: Option<String>,
    pub note_id: Option<String>,
    pub excerpt: Option<String>,
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn json_list(raw: Option<String>) -> Vec<String> {
    raw.and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn row_to_run(row: &sqlx_sqlite::SqliteRow) -> RunRow {
    let depth: String = row.get("depth");
    let plan: Option<String> = row.get("plan");
    let use_notes: i64 = row.get("use_notes");
    RunRow {
        id: row.get("id"),
        question: row.get("question"),
        depth: Depth::parse(&depth).unwrap_or(Depth::Standard),
        status: row.get("status"),
        phase: row.get("phase"),
        use_notes: use_notes != 0,
        project_id: row.get("project_id"),
        chat_id: row.get("chat_id"),
        clarify_questions: json_list(row.get("clarify_questions")),
        clarify_answers: json_list(row.get("clarify_answers")),
        plan: plan.and_then(|plan| serde_json::from_str(&plan).ok()),
        model: row.get("model"),
        report_note_id: row.get("report_note_id"),
        cited_sources: row.get("cited_sources"),
        invented_citations: row.get("invented_citations"),
        error: row.get("error"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn row_to_source(row: &sqlx_sqlite::SqliteRow) -> SourceRow {
    SourceRow {
        id: row.get("id"),
        position: row.get("position"),
        kind: row.get("kind"),
        title: row.get("title"),
        url: row.get("url"),
        note_id: row.get("note_id"),
        excerpt: row.get("excerpt"),
        status: row.get("status"),
        notes: row.get("notes"),
    }
}

pub struct NewRun<'a> {
    pub id: &'a str,
    pub question: &'a str,
    pub depth: Depth,
    pub use_notes: bool,
    pub project_id: Option<&'a str>,
    pub chat_id: Option<&'a str>,
    pub model: &'a str,
}

pub async fn insert_run(pool: &SqlitePool, run: &NewRun<'_>) -> Result<(), AppError> {
    let stamp = now();
    query(
        "INSERT INTO research_runs (id, question, depth, status, use_notes, project_id, chat_id, model,
         prompt_version, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'clarifying', ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
    )
    .bind(run.id)
    .bind(run.question)
    .bind(run.depth.as_str())
    .bind(i64::from(run.use_notes))
    .bind(run.project_id)
    .bind(run.chat_id)
    .bind(run.model)
    .bind(i64::from(super::prompts::RESEARCH_PROMPT_VERSION))
    .bind(stamp)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn run_row(pool: &SqlitePool, id: &str) -> Result<Option<RunRow>, AppError> {
    Ok(query("SELECT * FROM research_runs WHERE id = ?1")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .as_ref()
        .map(row_to_run))
}

pub async fn recent_runs(pool: &SqlitePool, limit: i64) -> Result<Vec<RunRow>, AppError> {
    let rows = query("SELECT * FROM research_runs ORDER BY created_at DESC, id LIMIT ?1")
        .bind(limit)
        .fetch_all(pool)
        .await?;
    Ok(rows.iter().map(row_to_run).collect())
}

pub async fn set_questions(
    pool: &SqlitePool,
    id: &str,
    questions: &[String],
) -> Result<(), AppError> {
    query("UPDATE research_runs SET clarify_questions = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(serde_json::to_string(questions).unwrap_or_else(|_| "[]".into()))
        .bind(now())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn set_plan(
    pool: &SqlitePool,
    id: &str,
    answers: &[String],
    plan: &ResearchPlan,
) -> Result<(), AppError> {
    query(
        "UPDATE research_runs SET clarify_answers = ?1, plan = ?2, status = 'planned', error = NULL,
         updated_at = ?3 WHERE id = ?4",
    )
    .bind(serde_json::to_string(answers).unwrap_or_else(|_| "[]".into()))
    .bind(serde_json::to_string(plan).unwrap_or_default())
    .bind(now())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// The approved plan becomes the run's steps, one per search, and the run
/// starts. Approving again starts over from that plan.
pub async fn approve(
    pool: &SqlitePool,
    id: &str,
    depth: Depth,
    plan: &ResearchPlan,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    query("DELETE FROM research_steps WHERE run_id = ?1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    query("DELETE FROM research_sources WHERE run_id = ?1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let mut position = 0_i64;
    for section in &plan.sections {
        for search in &section.queries {
            position += 1;
            query(
                "INSERT INTO research_steps (id, run_id, position, section, query)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(id)
            .bind(position)
            .bind(&section.title)
            .bind(search)
            .execute(&mut *tx)
            .await?;
        }
    }
    query(
        "UPDATE research_runs SET plan = ?1, depth = ?2, status = 'running', phase = 'searching',
         error = NULL, report_note_id = NULL, updated_at = ?3 WHERE id = ?4",
    )
    .bind(serde_json::to_string(plan).unwrap_or_default())
    .bind(depth.as_str())
    .bind(now())
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn set_status(
    pool: &SqlitePool,
    id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), AppError> {
    query("UPDATE research_runs SET status = ?1, error = ?2, updated_at = ?3 WHERE id = ?4")
        .bind(status)
        .bind(error)
        .bind(now())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Stops a run that is running. A run already finished stays finished.
pub async fn stop(pool: &SqlitePool, id: &str) -> Result<bool, AppError> {
    let result = query(
        "UPDATE research_runs SET status = 'stopped', updated_at = ?1
         WHERE id = ?2 AND status = 'running'",
    )
    .bind(now())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn set_phase(pool: &SqlitePool, id: &str, phase: &str) -> Result<(), AppError> {
    query("UPDATE research_runs SET phase = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(phase)
        .bind(now())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn pending_step(pool: &SqlitePool, run_id: &str) -> Result<Option<StepRow>, AppError> {
    Ok(query(
        "SELECT id, query FROM research_steps WHERE run_id = ?1 AND status = 'pending'
         ORDER BY position LIMIT 1",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?
    .map(|row| StepRow {
        id: row.get("id"),
        query: row.get("query"),
    }))
}

pub async fn finish_step(pool: &SqlitePool, step_id: &str, status: &str) -> Result<(), AppError> {
    query("UPDATE research_steps SET status = ?1 WHERE id = ?2")
        .bind(status)
        .bind(step_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// (steps done, steps in the plan)
pub async fn step_counts(pool: &SqlitePool, run_id: &str) -> Result<(i64, i64), AppError> {
    let row = query(
        "SELECT COALESCE(SUM(CASE WHEN status != 'pending' THEN 1 ELSE 0 END), 0) AS done,
                COUNT(*) AS total
         FROM research_steps WHERE run_id = ?1",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await?;
    Ok((row.get("done"), row.get("total")))
}

/// (every source filed, the person's own among them)
pub async fn source_counts(pool: &SqlitePool, run_id: &str) -> Result<(usize, usize), AppError> {
    let row = query(
        "SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN kind != 'web' THEN 1 ELSE 0 END), 0) AS own
         FROM research_sources WHERE run_id = ?1",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await?;
    let total: i64 = row.get("total");
    let own: i64 = row.get("own");
    Ok((total as usize, own as usize))
}

/// Files a source unless the run already has it. True when it was new.
pub async fn insert_source(
    pool: &SqlitePool,
    run_id: &str,
    found: &Found,
) -> Result<bool, AppError> {
    let result = query(
        "INSERT INTO research_sources (id, run_id, position, kind, source_key, title, url, note_id, excerpt)
         VALUES (?1, ?2, (SELECT COALESCE(MAX(position), 0) + 1 FROM research_sources WHERE run_id = ?2),
                 ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(run_id, source_key) DO NOTHING",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(run_id)
    .bind(found.kind)
    .bind(&found.key)
    .bind(&found.title)
    .bind(found.url.as_deref())
    .bind(found.note_id.as_deref())
    .bind(found.excerpt.as_deref())
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn pending_source(
    pool: &SqlitePool,
    run_id: &str,
) -> Result<Option<SourceRow>, AppError> {
    Ok(query(
        "SELECT * FROM research_sources WHERE run_id = ?1 AND status = 'pending'
         ORDER BY position LIMIT 1",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?
    .as_ref()
    .map(row_to_source))
}

pub async fn finish_source(
    pool: &SqlitePool,
    source_id: &str,
    status: &str,
    notes: Option<&str>,
) -> Result<(), AppError> {
    query("UPDATE research_sources SET status = ?1, notes = ?2 WHERE id = ?3")
        .bind(status)
        .bind(notes)
        .bind(source_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn sources(pool: &SqlitePool, run_id: &str) -> Result<Vec<SourceRow>, AppError> {
    let rows = query("SELECT * FROM research_sources WHERE run_id = ?1 ORDER BY position")
        .bind(run_id)
        .fetch_all(pool)
        .await?;
    Ok(rows.iter().map(row_to_source).collect())
}

/// "Write the report now": what is still waiting is set aside, and the run
/// goes straight to writing from what was read.
pub async fn skip_remaining(pool: &SqlitePool, run_id: &str) -> Result<(), AppError> {
    query("UPDATE research_steps SET status = 'skipped' WHERE run_id = ?1 AND status = 'pending'")
        .bind(run_id)
        .execute(pool)
        .await?;
    query(
        "UPDATE research_sources SET status = 'skipped' WHERE run_id = ?1 AND status = 'pending'",
    )
    .bind(run_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn complete(
    pool: &SqlitePool,
    id: &str,
    note_id: &str,
    cited: usize,
    invented: usize,
) -> Result<(), AppError> {
    query(
        "UPDATE research_runs SET status = 'done', phase = NULL, report_note_id = ?1,
         cited_sources = ?2, invented_citations = ?3, error = NULL, updated_at = ?4 WHERE id = ?5",
    )
    .bind(note_id)
    .bind(cited as i64)
    .bind(invented as i64)
    .bind(now())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn unfinished(pool: &SqlitePool) -> Result<Vec<String>, AppError> {
    let rows = query("SELECT id FROM research_runs WHERE status = 'running' ORDER BY created_at")
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|row| row.get("id")).collect())
}

/// Deletes a run and its rows. The report note, if one was written, stays:
/// it is the person's note now.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    query("DELETE FROM research_sources WHERE run_id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    query("DELETE FROM research_steps WHERE run_id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    query("DELETE FROM research_runs WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
