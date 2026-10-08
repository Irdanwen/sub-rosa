//! The research engine: one step at a time, each one a row (ADR-0018).
//!
//! A run is searches, then page reads, then the report. The engine never
//! holds a plan in memory: it asks the database what is still pending, does
//! that one thing, writes down that it was done, and asks again. So a run
//! killed between two steps resumes at the next one, and a step killed in the
//! middle is done again from the start, which costs at most one search or one
//! page read twice and never a whole run.
//!
//! What it talks to is a [`Backend`], so the same steps run against the
//! sidecar in the app and against a scripted backend in the tests.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};

use sqlx_sqlite::SqlitePool;
use tokio::sync::Notify;

use super::prompts;
use super::report::{self, HandedSource};
use super::store::{self, Found, RunRow};
use crate::domain::types::AppError;

/// What the engine needs from the world.
pub trait Backend: Sync {
    /// One completion, its text.
    fn complete(
        &self,
        system: &str,
        user: &str,
        max_tokens: u32,
    ) -> impl Future<Output = Result<String, AppError>> + Send;
    /// Web results for a query. An error is a transport failure, which
    /// stops the run so it can be retried; a query the search refused is an
    /// empty list.
    fn web_search(
        &self,
        query: &str,
        limit: usize,
    ) -> impl Future<Output = Result<Vec<Found>, AppError>> + Send;
    /// A page's text, or None when the page could not be read.
    fn fetch_page(
        &self,
        url: &str,
    ) -> impl Future<Output = Result<Option<String>, AppError>> + Send;
    /// The person's own material for a query: notes, the project's files,
    /// and connected apps once they exist (P6). Best effort.
    fn own_sources(&self, run: &RunRow, query: &str) -> impl Future<Output = Vec<Found>> + Send;
    /// Saves the report as a note and answers its id.
    fn save_report(
        &self,
        title: &str,
        body: &str,
    ) -> impl Future<Output = Result<String, AppError>> + Send;
}

/// Stop for a live run. The flag answers "was it stopped" at any time; the
/// notification wakes a step that is waiting on the network.
#[derive(Default)]
pub struct StopSignal {
    stopped: AtomicBool,
    notify: Notify,
}

impl StopSignal {
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        // A permit, not a broadcast: the engine may be between two awaits.
        self.notify.notify_one();
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    pub async fn stopped(&self) {
        loop {
            if self.is_stopped() {
                return;
            }
            self.notify.notified().await;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Advanced {
    Step,
    Finished,
}

/// Runs a research run until it is done, stopped, deleted or fails.
/// `changed` is called after every step, for the screens to follow.
pub async fn drive<B: Backend>(
    pool: &SqlitePool,
    backend: &B,
    run_id: &str,
    stop: &StopSignal,
    changed: &(dyn Fn() + Sync),
) -> Result<(), AppError> {
    loop {
        let Some(run) = store::run_row(pool, run_id).await? else {
            return Ok(());
        };
        if run.status != "running" {
            return Ok(());
        }
        if stop.is_stopped() {
            store::stop(pool, run_id).await?;
            changed();
            return Ok(());
        }
        let advanced = tokio::select! {
            biased;
            () = stop.stopped() => {
                // The step in flight is dropped; it is still pending and is
                // done again if the run resumes.
                store::stop(pool, run_id).await?;
                changed();
                return Ok(());
            }
            advanced = advance(pool, backend, &run) => advanced?,
        };
        changed();
        if advanced == Advanced::Finished {
            return Ok(());
        }
    }
}

fn plan_of(run: &RunRow) -> Result<super::ResearchPlan, AppError> {
    run.plan.clone().ok_or_else(|| {
        AppError::new(
            "research_no_plan",
            "This research has no approved plan yet.",
        )
    })
}

/// Does the next pending thing of a run.
pub async fn advance<B: Backend>(
    pool: &SqlitePool,
    backend: &B,
    run: &RunRow,
) -> Result<Advanced, AppError> {
    let plan = plan_of(run)?;
    let depth = run.depth;
    let request =
        prompts::request_text(&run.question, &run.clarify_questions, &run.clarify_answers);

    if let Some(step) = store::pending_step(pool, &run.id).await? {
        store::set_phase(pool, &run.id, "searching").await?;
        let (_, steps) = store::step_counts(pool, &run.id).await?;
        let (mut total, mut own) = store::source_counts(pool, &run.id).await?;
        let own_cap = if run.use_notes {
            depth.own_sources()
        } else {
            0
        };
        // The web's share, spread over every search of the plan, so the last
        // section still finds sources after the first ones were generous.
        let web_cap = depth.max_sources() - own_cap;
        let per_search = web_cap
            .div_ceil(usize::try_from(steps.max(1)).unwrap_or(1))
            .clamp(1, depth.results_per_query());
        let mut added = 0;
        for found in backend
            .web_search(&step.query, depth.results_per_query())
            .await?
        {
            if added >= per_search || total >= depth.max_sources() {
                break;
            }
            if store::insert_source(pool, &run.id, &found).await? {
                added += 1;
                total += 1;
            }
        }
        if own < own_cap && total < depth.max_sources() {
            for found in backend.own_sources(run, &step.query).await {
                if own >= own_cap || total >= depth.max_sources() {
                    break;
                }
                if store::insert_source(pool, &run.id, &found).await? {
                    own += 1;
                    total += 1;
                }
            }
        }
        store::finish_step(pool, &step.id, "done").await?;
        return Ok(Advanced::Step);
    }

    if let Some(source) = store::pending_source(pool, &run.id).await? {
        store::set_phase(pool, &run.id, "reading").await?;
        match (source.kind.as_str(), source.url.as_deref()) {
            ("web", Some(url)) => {
                let Some(text) = backend.fetch_page(url).await? else {
                    store::finish_source(pool, &source.id, "failed", None).await?;
                    return Ok(Advanced::Step);
                };
                let note = backend
                    .complete(
                        prompts::NOTE_SYSTEM,
                        &prompts::note_user(&request, &plan, &source.title, url, &text),
                        prompts::NOTE_MAX_TOKENS,
                    )
                    .await?;
                if prompts::is_irrelevant(&note) || note.trim().is_empty() {
                    store::finish_source(pool, &source.id, "skipped", None).await?;
                } else {
                    store::finish_source(pool, &source.id, "read", Some(note.trim())).await?;
                }
            }
            // The person's own material arrives as the passages that matched,
            // already screened for the query: they are the notes.
            _ => {
                let excerpt = source.excerpt.as_deref().unwrap_or("").trim();
                let status = if excerpt.is_empty() {
                    "skipped"
                } else {
                    "read"
                };
                store::finish_source(pool, &source.id, status, Some(excerpt)).await?;
            }
        }
        return Ok(Advanced::Step);
    }

    store::set_phase(pool, &run.id, "writing").await?;
    let read: Vec<_> = store::sources(pool, &run.id)
        .await?
        .into_iter()
        .filter(|source| source.status == "read")
        .collect();
    if read.is_empty() {
        return Err(AppError::new(
            "research_no_sources",
            "No source could be read for this question. Try other searches.",
        ));
    }
    // The numbers the model sees are the app's, in the order the sources
    // were read; the report is resolved against exactly this list.
    let handed: Vec<HandedSource> = read
        .iter()
        .enumerate()
        .map(|(index, source)| HandedSource {
            index: index + 1,
            kind: source.kind.clone(),
            title: source.title.clone(),
            url: source.url.clone(),
        })
        .collect();
    let notes: Vec<(usize, String, String)> = read
        .iter()
        .enumerate()
        .map(|(index, source)| {
            (
                index + 1,
                source.title.clone(),
                source.notes.clone().unwrap_or_default(),
            )
        })
        .collect();
    let raw = backend
        .complete(
            prompts::REPORT_SYSTEM,
            &prompts::report_user(&request, &plan, &notes),
            prompts::REPORT_MAX_TOKENS,
        )
        .await?;
    let assembled = report::assemble(&plan.title, &raw, &handed);
    let title = report::report_title(&assembled.markdown, &plan.title);
    let body = report::without_title(&assembled.markdown);
    let note_id = backend.save_report(&title, &body).await?;
    store::complete(
        pool,
        &run.id,
        &note_id,
        assembled.cited.len(),
        assembled.invented.len(),
    )
    .await?;
    Ok(Advanced::Finished)
}
