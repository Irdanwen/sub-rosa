//! Deep research (ADR-0089): a question read across the web and the person's
//! own notes, written up as a note whose sources the app numbered.
//!
//! The shape is the one a person expects from a research assistant, in four
//! moves, each its own command so each can be looked at before money is
//! spent on the next:
//!
//! 1. **Clarify.** [`research_start`] files the run and asks the model
//!    whether anything essential is ambiguous (at most three questions, often
//!    none).
//! 2. **Plan.** [`research_plan`] turns the request and the answers into
//!    sections and searches. The person edits it, picks a depth, and reads
//!    what it will cost before anything is searched.
//! 3. **Run.** [`research_approve`] writes one row per search and starts the
//!    engine ([`engine`]): searches, then one note per source read, then the
//!    report. Every step is a row, so the run survives the app being
//!    suspended, killed or quit, and the background sweep picks it up again
//!    ([`resume_unfinished`], ADR-0018). Whether a run is live is an
//!    in-process question (the `LIVE` registry), never the database's.
//! 4. **Report.** The model numbers its citations over the source notes it
//!    was handed; the app resolves them (ADR-0044), writes the sources list
//!    itself, and saves the report as an ordinary note, which exports as
//!    Markdown, PDF or Word ([`export`]).
//!
//! One engine for both shells: the desktop runs the same steps through the
//! same sidecar as the phone, rather than handing the work to Hermes, so a
//! report reads the same whichever device wrote it. Nothing goes in
//! `june-api/` (ADR-0027): the prompts are in [`prompts`] with their own
//! version.

pub mod backend;
pub mod engine;
pub mod export;
pub mod prompts;
pub mod report;
pub mod store;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::domain::types::AppError;
use engine::StopSignal;

/// `{ id }` whenever a run changes. Each screen reads the run again with
/// [`research_get`]: the row is the truth, the event only says when to look.
pub const RESEARCH_EVENT: &str = "june://research";

pub(crate) const MAX_QUESTION_CHARS: usize = 4_000;
pub(crate) const MAX_SECTIONS: usize = 8;
pub(crate) const MAX_ANSWER_CHARS: usize = 1_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Depth {
    Quick,
    Standard,
    Deep,
}

impl Depth {
    pub fn as_str(self) -> &'static str {
        match self {
            Depth::Quick => "quick",
            Depth::Standard => "standard",
            Depth::Deep => "deep",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "quick" => Some(Depth::Quick),
            "standard" => Some(Depth::Standard),
            "deep" => Some(Depth::Deep),
            _ => None,
        }
    }

    /// Sources read at most: the budget a person picks.
    pub fn max_sources(self) -> usize {
        match self {
            Depth::Quick => 10,
            Depth::Standard => 25,
            Depth::Deep => 50,
        }
    }

    /// Searches the plan may hold.
    pub fn max_queries(self) -> usize {
        match self {
            Depth::Quick => 4,
            Depth::Standard => 8,
            Depth::Deep => 14,
        }
    }

    pub fn results_per_query(self) -> usize {
        match self {
            Depth::Quick => 5,
            Depth::Standard => 6,
            Depth::Deep => 8,
        }
    }

    /// The share of the budget the person's own notes and files may take.
    pub fn own_sources(self) -> usize {
        self.max_sources() / 5
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanSection {
    pub title: String,
    pub queries: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResearchPlan {
    pub title: String,
    pub sections: Vec<PlanSection>,
}

/// What a run will spend at most, said before it starts. Token counts are
/// ceilings; the screen prices them with the model's own rates, and the
/// searches and page reads with the operator's per-call prices for the two
/// web routes (`carpe_diem_web_pricing`), when it knows them. Every source is
/// counted as a web page read, the most a depth can cost.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResearchEstimate {
    pub depth: Depth,
    pub searches: usize,
    pub page_reads: usize,
    pub model_calls: usize,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

/// The ceiling of a run of `depth` with `searches` searches.
pub fn estimate(depth: Depth, searches: usize) -> ResearchEstimate {
    let page_reads = depth.max_sources();
    let page_tokens = (prompts::READ_PAGE_CHARS / 4) as u64 + 600;
    let note_tokens = u64::from(prompts::NOTE_MAX_TOKENS);
    ResearchEstimate {
        depth,
        searches,
        page_reads,
        // One note per page, and the report.
        model_calls: page_reads + 1,
        prompt_tokens: page_reads as u64 * page_tokens + page_reads as u64 * note_tokens + 1_500,
        completion_tokens: page_reads as u64 * note_tokens + u64::from(prompts::REPORT_MAX_TOKENS),
    }
}

/// A plan as the person sent it, made safe to run: trimmed, empty searches
/// and sections dropped, and no more searches than the depth allows.
pub fn clamp_plan(plan: &ResearchPlan, depth: Depth) -> Result<ResearchPlan, AppError> {
    let mut budget = depth.max_queries();
    let mut sections = Vec::new();
    for section in plan.sections.iter().take(MAX_SECTIONS) {
        let queries: Vec<String> = section
            .queries
            .iter()
            .map(|query| query.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|query| !query.is_empty())
            .map(|query| query.chars().take(200).collect())
            .take(budget)
            .collect();
        budget -= queries.len();
        let title: String = section.title.trim().chars().take(160).collect();
        if !queries.is_empty() {
            sections.push(PlanSection {
                title: if title.is_empty() {
                    queries[0].clone()
                } else {
                    title
                },
                queries,
            });
        }
    }
    if sections.is_empty() {
        return Err(AppError::new(
            "research_plan_empty",
            "Add at least one search to the plan.",
        ));
    }
    let title: String = plan.title.trim().chars().take(160).collect();
    Ok(ResearchPlan {
        title: if title.is_empty() {
            sections[0].title.clone()
        } else {
            title
        },
        sections,
    })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSourceDto {
    pub position: i64,
    pub kind: String,
    pub title: String,
    pub url: Option<String>,
    pub note_id: Option<String>,
    /// pending, read, skipped (nothing useful) or failed (unreadable).
    pub status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResearchRunDto {
    pub id: String,
    pub question: String,
    pub depth: Depth,
    /// clarifying, planned, running, done, stopped or failed.
    pub status: String,
    /// searching, reading or writing while it runs.
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
    /// Citations that named no source and were removed from the report.
    pub invented_citations: i64,
    pub error: Option<String>,
    pub steps_done: i64,
    pub steps_total: i64,
    pub max_sources: usize,
    pub sources_found: usize,
    pub sources_read: usize,
    pub estimate: Option<ResearchEstimate>,
    /// The same ceiling at every depth, for the plan's depth picker, each
    /// with no more searches than that depth runs. Empty without a plan.
    pub depth_estimates: Vec<ResearchEstimate>,
    pub sources: Vec<ResearchSourceDto>,
    /// A step is being worked on in this process right now.
    pub live: bool,
    pub created_at: String,
    pub updated_at: String,
}

pub async fn dto(
    pool: &sqlx_sqlite::SqlitePool,
    run: store::RunRow,
) -> Result<ResearchRunDto, AppError> {
    let (steps_done, steps_total) = store::step_counts(pool, &run.id).await?;
    let sources = store::sources(pool, &run.id).await?;
    let searches = match (&run.plan, steps_total) {
        (_, total) if total > 0 => total as usize,
        (Some(plan), _) => plan.sections.iter().map(|s| s.queries.len()).sum(),
        (None, _) => 0,
    };
    Ok(ResearchRunDto {
        live: is_live(&run.id),
        estimate: run.plan.as_ref().map(|_| estimate(run.depth, searches)),
        depth_estimates: match &run.plan {
            Some(_) => [Depth::Quick, Depth::Standard, Depth::Deep]
                .into_iter()
                .map(|depth| estimate(depth, searches.min(depth.max_queries())))
                .collect(),
            None => Vec::new(),
        },
        max_sources: run.depth.max_sources(),
        sources_found: sources.len(),
        sources_read: sources.iter().filter(|s| s.status == "read").count(),
        sources: sources
            .into_iter()
            .map(|source| ResearchSourceDto {
                position: source.position,
                kind: source.kind,
                title: source.title,
                url: source.url,
                note_id: source.note_id,
                status: source.status,
            })
            .collect(),
        steps_done,
        steps_total,
        id: run.id,
        question: run.question,
        depth: run.depth,
        status: run.status,
        phase: run.phase,
        use_notes: run.use_notes,
        project_id: run.project_id,
        chat_id: run.chat_id,
        clarify_questions: run.clarify_questions,
        clarify_answers: run.clarify_answers,
        plan: run.plan,
        model: run.model,
        report_note_id: run.report_note_id,
        cited_sources: run.cited_sources,
        invented_citations: run.invented_citations,
        error: run.error,
        created_at: run.created_at,
        updated_at: run.updated_at,
    })
}

// --- Liveness --------------------------------------------------------------

static LIVE: LazyLock<Mutex<HashMap<String, Arc<StopSignal>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn live() -> MutexGuard<'static, HashMap<String, Arc<StopSignal>>> {
    LIVE.lock().unwrap_or_else(|poison| poison.into_inner())
}

pub fn is_live(id: &str) -> bool {
    live().contains_key(id)
}

/// The claim over a run's engine in this process.
struct Claim {
    id: String,
    stop: Arc<StopSignal>,
}

impl Claim {
    fn take(id: &str) -> Option<Self> {
        let mut live = live();
        if live.contains_key(id) {
            return None;
        }
        let stop = Arc::new(StopSignal::default());
        live.insert(id.to_string(), Arc::clone(&stop));
        Some(Self {
            id: id.to_string(),
            stop,
        })
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        live().remove(&self.id);
    }
}

fn emit(app: &AppHandle, id: &str) {
    let _ = app.emit(RESEARCH_EVENT, serde_json::json!({ "id": id }));
}

fn spawn_drive(app: AppHandle, id: String) {
    tauri::async_runtime::spawn(async move {
        let Some(claim) = Claim::take(&id) else {
            return;
        };
        let background = crate::ios_background::BackgroundTask::begin("deep-research");
        let result = drive_live(&app, &id, &claim.stop).await;
        drop(background);
        drop(claim);
        let Ok(repos) = crate::commands::repositories(&app).await else {
            return;
        };
        if let Err(error) = result {
            tracing::warn!(run = %id, code = %error.code, "deep research failed");
            let _ = store::set_status(&repos.pool, &id, "failed", Some(&error.message)).await;
        }
        emit(&app, &id);
        if let Ok(Some(run)) = store::run_row(&repos.pool, &id).await {
            if run.status == "done" {
                announce(&app, &run);
            }
        }
    });
}

async fn drive_live(app: &AppHandle, id: &str, stop: &StopSignal) -> Result<(), AppError> {
    let repos = crate::commands::repositories(app).await?;
    let Some(run) = store::run_row(&repos.pool, id).await? else {
        return Ok(());
    };
    let backend = backend::LiveBackend::new(app.clone(), run.model.clone());
    let notify = || emit(app, id);
    engine::drive(&repos.pool, &backend, id, stop, &notify).await
}

/// "Your report is ready", tapping into the note.
fn announce(app: &AppHandle, run: &store::RunRow) {
    use tauri_plugin_notification::NotificationExt;
    let Some(note_id) = run.report_note_id.as_deref() else {
        return;
    };
    let title = run
        .plan
        .as_ref()
        .map(|plan| plan.title.clone())
        .unwrap_or_else(|| run.question.clone());
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(crate::tr!("Your research report is ready in your notes."))
        .extra(
            crate::destinations::EXTRA_KEY,
            crate::destinations::note(note_id),
        )
        .show();
}

/// Re-drive runs that were running when the app went away. Called by
/// [`crate::background::sweep`].
pub async fn resume_unfinished(app: &AppHandle) {
    let Ok(repos) = crate::commands::repositories(app).await else {
        return;
    };
    let Ok(ids) = store::unfinished(&repos.pool).await else {
        return;
    };
    for id in ids {
        if is_live(&id) {
            continue;
        }
        tracing::info!(run = %id, "resuming a deep research run");
        spawn_drive(app.clone(), id);
    }
}

// --- Commands --------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchStartRequest {
    pub question: String,
    pub depth: Depth,
    #[serde(default = "default_true")]
    pub use_notes: bool,
    /// The chat it was started from; its project's files become sources.
    #[serde(default)]
    pub chat_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    /// Connectors the run may search (ADR-0092).
    #[serde(default)]
    pub connectors: Vec<String>,
}

fn default_true() -> bool {
    true
}

fn missing() -> AppError {
    AppError::new(
        "research_missing",
        "This research is no longer on this device.",
    )
}

async fn load(pool: &sqlx_sqlite::SqlitePool, id: &str) -> Result<store::RunRow, AppError> {
    store::run_row(pool, id).await?.ok_or_else(missing)
}

/// The chat a run is started from, when it may be: a report is kept, listed
/// and synchronised, so a temporary chat (ADR-0083) cannot start one.
pub(crate) async fn chat_of<'a>(
    pool: &sqlx_sqlite::SqlitePool,
    request: &'a ResearchStartRequest,
) -> Result<Option<&'a str>, AppError> {
    let chat_id = request
        .chat_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    crate::temporary_chat::refuse_in_temporary(pool, chat_id).await?;
    Ok(chat_id)
}

/// Files a run and asks whether anything needs clarifying first.
#[tauri::command]
pub async fn research_start(
    app: AppHandle,
    request: ResearchStartRequest,
) -> Result<ResearchRunDto, AppError> {
    let question = request.question.trim();
    if question.is_empty() {
        return Err(AppError::new(
            "research_empty",
            "Write what you want researched first.",
        ));
    }
    let question: String = question.chars().take(MAX_QUESTION_CHARS).collect();
    let repos = crate::commands::repositories(&app).await?;
    let chat_id = chat_of(&repos.pool, &request).await?;
    let project_id = match request.project_id.as_deref().map(str::trim) {
        Some(id) if !id.is_empty() => Some(id.to_string()),
        _ => match chat_id {
            Some(chat) => crate::projects::context::folder_of_session(&repos.pool, chat).await,
            None => None,
        },
    };
    let id = uuid::Uuid::new_v4().to_string();
    let model = crate::providers::generation_model();
    store::insert_run(
        &repos.pool,
        &store::NewRun {
            id: &id,
            question: &question,
            depth: request.depth,
            use_notes: request.use_notes,
            project_id: project_id.as_deref(),
            chat_id,
            model: &model,
        },
    )
    .await?;
    crate::connectors::research::set_for_run(&repos.pool, &id, &request.connectors).await?;
    let backend = backend::LiveBackend::new(app.clone(), model);
    // Best effort: a request that cannot be clarified is planned as asked.
    let questions = match engine::Backend::complete(
        &backend,
        prompts::CLARIFY_SYSTEM,
        &prompts::request_text(&question, &[], &[]),
        prompts::CLARIFY_MAX_TOKENS,
    )
    .await
    {
        Ok(reply) => prompts::parse_questions(&reply),
        Err(error) => {
            tracing::warn!(code = %error.code, "research clarification failed");
            Vec::new()
        }
    };
    store::set_questions(&repos.pool, &id, &questions).await?;
    dto(&repos.pool, load(&repos.pool, &id).await?).await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchPlanRequest {
    pub id: String,
    #[serde(default)]
    pub answers: Vec<String>,
}

/// Proposes the plan, from the request and the answers to its questions.
#[tauri::command]
pub async fn research_plan(
    app: AppHandle,
    request: ResearchPlanRequest,
) -> Result<ResearchRunDto, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let run = load(&repos.pool, &request.id).await?;
    if !matches!(run.status.as_str(), "clarifying" | "planned") {
        return Err(AppError::new(
            "research_already_started",
            "This research has already started.",
        ));
    }
    let answers: Vec<String> = request
        .answers
        .iter()
        .map(|answer| answer.trim().chars().take(MAX_ANSWER_CHARS).collect())
        .collect();
    let backend = backend::LiveBackend::new(app.clone(), run.model.clone());
    let reply = engine::Backend::complete(
        &backend,
        prompts::PLAN_SYSTEM,
        &prompts::request_text(&run.question, &run.clarify_questions, &answers),
        prompts::PLAN_MAX_TOKENS,
    )
    .await?;
    let proposed = prompts::parse_plan(&reply, &run.question);
    let plan = clamp_plan(&proposed, run.depth)?;
    store::set_plan(&repos.pool, &run.id, &answers, &plan).await?;
    dto(&repos.pool, load(&repos.pool, &run.id).await?).await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchApproveRequest {
    pub id: String,
    pub plan: ResearchPlan,
    #[serde(default)]
    pub depth: Option<Depth>,
}

/// Starts the run on the plan the person approved.
#[tauri::command]
pub async fn research_approve(
    app: AppHandle,
    request: ResearchApproveRequest,
) -> Result<ResearchRunDto, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let run = load(&repos.pool, &request.id).await?;
    if !matches!(run.status.as_str(), "clarifying" | "planned") {
        return Err(AppError::new(
            "research_already_started",
            "This research has already started.",
        ));
    }
    let depth = request.depth.unwrap_or(run.depth);
    let plan = clamp_plan(&request.plan, depth)?;
    store::approve(&repos.pool, &run.id, depth, &plan).await?;
    spawn_drive(app.clone(), run.id.clone());
    dto(&repos.pool, load(&repos.pool, &run.id).await?).await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchIdRequest {
    pub id: String,
}

/// Stops a run. What it read so far stays, and it can resume or write the
/// report from that.
#[tauri::command]
pub async fn research_stop(
    app: AppHandle,
    request: ResearchIdRequest,
) -> Result<ResearchRunDto, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    store::stop(&repos.pool, &request.id).await?;
    if let Some(signal) = live().get(&request.id) {
        signal.stop();
    }
    emit(&app, &request.id);
    dto(&repos.pool, load(&repos.pool, &request.id).await?).await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchResumeRequest {
    pub id: String,
    /// Write the report from what was read instead of reading on.
    #[serde(default)]
    pub finish_now: bool,
}

/// Picks a stopped or failed run up again.
#[tauri::command]
pub async fn research_resume(
    app: AppHandle,
    request: ResearchResumeRequest,
) -> Result<ResearchRunDto, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let run = load(&repos.pool, &request.id).await?;
    if !matches!(run.status.as_str(), "stopped" | "failed") {
        return dto(&repos.pool, run).await;
    }
    if is_live(&run.id) {
        return Err(AppError::new(
            "research_stopping",
            "This research is still stopping. Try again in a moment.",
        ));
    }
    if request.finish_now {
        store::skip_remaining(&repos.pool, &run.id).await?;
    }
    store::set_status(&repos.pool, &run.id, "running", None).await?;
    spawn_drive(app.clone(), run.id.clone());
    dto(&repos.pool, load(&repos.pool, &run.id).await?).await
}

#[tauri::command]
pub async fn research_get(
    app: AppHandle,
    request: ResearchIdRequest,
) -> Result<ResearchRunDto, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    dto(&repos.pool, load(&repos.pool, &request.id).await?).await
}

/// The latest runs, newest first.
#[tauri::command]
pub async fn research_list(app: AppHandle) -> Result<Vec<ResearchRunDto>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let mut out = Vec::new();
    for run in store::recent_runs(&repos.pool, 20).await? {
        let mut item = dto(&repos.pool, run).await?;
        // The list shows counts; the sources are read when a run is opened.
        item.sources.clear();
        out.push(item);
    }
    Ok(out)
}

/// Forgets a run. Its report, a note, is kept.
#[tauri::command]
pub async fn research_delete(app: AppHandle, request: ResearchIdRequest) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    if let Some(signal) = live().get(&request.id) {
        signal.stop();
    }
    store::delete(&repos.pool, &request.id).await?;
    emit(&app, &request.id);
    Ok(())
}
