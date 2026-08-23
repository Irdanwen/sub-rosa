//! Long-form summaries: reading a long transcript the way a reader wants
//! rather than the way a meeting note-taker does (ADR-0027).
//!
//! The note generator's prompt is deliberately editorial — it drops
//! digressions and tentative ideas and keeps decisions and owners — which is
//! right for a standup and wrong for a two-hour talk, where the digression is
//! often the point. And it is a single pass, so a very long transcript either
//! overflows the window or quietly thins out in the middle.
//!
//! So: map over chunks that end on turn boundaries, merge the parts, and write
//! a short paragraph over the merged whole. Three things make it more than the
//! obvious version of that:
//!
//! - **The app owns the clock.** A map pass tags its headings with a `[t:N]`
//!   marker it was handed, and [`resolve_chapter_markers`] turns N into a real
//!   time this module already knows. The model is never asked for a timestamp,
//!   because that is the one thing it cannot know.
//! - **It is a durable row, not a task.** A dozen model calls over several
//!   minutes outlives a foreground session on iOS many times over, so the row
//!   is written first and [`resume_unfinished`] re-drives it (ADR-0018).
//! - **It is not tied to imports.** Any note with a long transcript can be
//!   read this way, including a three-hour meeting recorded last year.
//!
//! Nothing here touches `june-api/`: the passes go to `/v1/chat/completions`
//! through the sidecar, the same seam `agent_lite` and memory extraction use.

pub mod chunk;
pub mod prompts;

use crate::db::repositories::Repositories;
use crate::domain::types::{AppError, NoteSummaryDto};
use crate::june_api;
use chunk::{Chunk, Turn};
use prompts::LONGFORM_PROMPT_VERSION;
use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

/// Emitted whenever a summary row changes, so both shells can follow a run
/// without polling. Polling is what ADR-0018 exists to prevent.
pub const NOTE_SUMMARY_EVENT: &str = "june://note-summary";

/// Transcripts shorter than this are not worth summarizing at all — the note
/// already says everything the summary would.
pub const MIN_SUMMARIZABLE_CHARS: usize = 2_000;

/// Ceiling on chunks for one run. A transcript past this is extraordinary
/// (roughly twelve hours of speech) and the cost of running away with it is
/// real money, so it is refused by name rather than silently truncated.
const MAX_CHUNKS: usize = 60;

/// Notes with a run live in this process right now.
///
/// A row parked in `running` means one of two things — a run is working on it,
/// or the process died mid-run — and the row alone cannot tell them apart. The
/// same problem, and the same answer, as `domain::processing::ACTIVE_NOTES`.
static ACTIVE: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

fn active() -> MutexGuard<'static, HashSet<String>> {
    ACTIVE.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// RAII claim over a note's run.
struct RunClaim(String);

impl RunClaim {
    /// `None` when a run is already in flight for this note in this process.
    fn take(note_id: &str) -> Option<Self> {
        let mut active = active();
        if !active.insert(note_id.to_string()) {
            return None;
        }
        Some(Self(note_id.to_string()))
    }
}

impl Drop for RunClaim {
    fn drop(&mut self) {
        active().remove(&self.0);
    }
}

/// Whether a run for this note is live in this process.
pub fn is_running(note_id: &str) -> bool {
    active().contains(note_id)
}

fn emit(app: &AppHandle, summary: &NoteSummaryDto) {
    let _ = app.emit(NOTE_SUMMARY_EVENT, summary);
}

/// Build the turn list for a note from its persisted transcripts.
async fn turns_for_note(repos: &Repositories, note_id: &str) -> Result<Vec<Turn>, AppError> {
    let note = repos.get_note(note_id).await?;
    // Source transcripts are the turn-shaped rows and carry the times that
    // make chapters possible. The flat `transcript` is the fallback for a
    // single continuous source, which yields an untimed summary.
    let rows: Vec<chunk::TranscriptRow<'_>> = note
        .source_transcripts
        .iter()
        .filter(|transcript| transcript.status == "ready" || transcript.status == "completed")
        .map(|transcript| chunk::TranscriptRow {
            text: transcript.text.as_str(),
            source: transcript.source.as_deref(),
            start_ms: transcript.start_ms,
            end_ms: transcript.end_ms,
            turn_index: transcript.turn_index,
        })
        .collect();
    if !rows.is_empty() {
        return Ok(chunk::turns_from_rows(rows));
    }
    let Some(transcript) = note
        .transcript
        .as_ref()
        .filter(|transcript| !transcript.text.trim().is_empty())
    else {
        return Ok(Vec::new());
    };
    Ok(chunk::turns_from_rows([chunk::TranscriptRow {
        text: transcript.text.trim(),
        source: transcript.source.as_deref(),
        start_ms: transcript.start_ms,
        end_ms: transcript.end_ms,
        turn_index: transcript.turn_index,
    }]))
}

/// What a run would cost, before spending anything.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryPlan {
    pub note_id: String,
    pub transcript_chars: i64,
    pub chunk_count: i64,
    /// Map passes, plus the merge and short passes when there is more than one
    /// chunk. What the user is actually being asked to pay for.
    pub model_calls: i64,
    pub summarizable: bool,
    /// Why not, when `summarizable` is false.
    pub reason: Option<String>,
}

pub async fn plan(repos: &Repositories, note_id: &str) -> Result<SummaryPlan, AppError> {
    let turns = turns_for_note(repos, note_id).await?;
    let transcript_chars: usize = turns.iter().map(|turn| turn.text.chars().count()).sum();
    let chunks = chunk::chunk_turns(&turns, chunk::CHUNK_BUDGET_CHARS, chunk::OVERLAP_TURNS);
    let chunk_count = chunks.len();
    let (summarizable, reason) = if transcript_chars < MIN_SUMMARIZABLE_CHARS {
        (
            false,
            Some("This recording is too short to be worth a long-form summary.".to_string()),
        )
    } else if chunk_count > MAX_CHUNKS {
        (
            false,
            Some(format!(
                "This transcript would take {chunk_count} passes to read, past the {MAX_CHUNKS} this app will run at once."
            )),
        )
    } else {
        (true, None)
    };
    Ok(SummaryPlan {
        note_id: note_id.to_string(),
        transcript_chars: transcript_chars as i64,
        chunk_count: chunk_count as i64,
        model_calls: model_calls_for(chunk_count) as i64,
        summarizable,
        reason,
    })
}

fn model_calls_for(chunk_count: usize) -> usize {
    match chunk_count {
        0 => 0,
        // One map pass and the closing paragraph. No merge: there is nothing
        // to merge, and no provisional paragraph, because the real one is
        // already seconds away.
        1 => 2,
        // One map pass per chunk, the provisional paragraph written after the
        // first one, the merge, and the closing paragraph. The provisional
        // costs a call and the user is paying for it, so it is counted.
        count => count + 3,
    }
}

/// Start (or restart) the long-form summary for a note.
///
/// Returns as soon as the row is claimed; the work runs on a task and reports
/// through [`NOTE_SUMMARY_EVENT`] and the row itself.
pub async fn start(app: &AppHandle, note_id: &str) -> Result<NoteSummaryDto, AppError> {
    let repos = crate::commands::repositories(app).await?;
    let plan = plan(&repos, note_id).await?;
    if !plan.summarizable {
        return Err(AppError::new(
            "longform_not_summarizable",
            plan.reason
                .unwrap_or_else(|| "This recording cannot be summarized.".to_string()),
        ));
    }
    if is_running(note_id) {
        // Already working: hand back the row it is working on. If there is no
        // row, the user stopped that run a moment ago and it has not noticed
        // yet — say so rather than starting a second one on top of it.
        return repos.note_summary(note_id).await?.ok_or_else(|| {
            AppError::new(
                "longform_stopping",
                "That reading is still stopping. Try again in a moment.",
            )
        });
    }
    let summary = repos
        .begin_note_summary(
            note_id,
            plan.transcript_chars,
            plan.chunk_count,
            &crate::providers::generation_model(),
            LONGFORM_PROMPT_VERSION,
        )
        .await?;
    emit(app, &summary);
    spawn_run(app.clone(), note_id.to_string());
    Ok(summary)
}

fn spawn_run(app: AppHandle, note_id: String) {
    tauri::async_runtime::spawn(async move {
        let Some(claim) = RunClaim::take(&note_id) else {
            return;
        };
        let background = crate::ios_background::BackgroundTask::begin("longform-summary");
        let result = run(&app, &note_id).await;
        drop(background);
        drop(claim);
        if let Err(error) = result {
            tracing::warn!(note_id = %note_id, code = %error.code, "long-form summary failed");
            if let Ok(repos) = crate::commands::repositories(&app).await {
                if let Ok(Some(summary)) = repos
                    .set_note_summary_failed(&note_id, &error.message)
                    .await
                {
                    emit(&app, &summary);
                }
            }
        }
    });
}

async fn run(app: &AppHandle, note_id: &str) -> Result<(), AppError> {
    let repos = crate::commands::repositories(app).await?;
    // The run's identity. Deleting the row is the cancel, and a *new* row may
    // exist by the time this notices — the user pressing Stop and then
    // Summarize again. Comparing `created_at` means the old run stands down
    // instead of adopting the new row and doubling the bill.
    let started_at = repos
        .note_summary(note_id)
        .await?
        .map(|row| row.created_at)
        .unwrap_or_default();
    let turns = turns_for_note(&repos, note_id).await?;
    let chunks = chunk::chunk_turns(&turns, chunk::CHUNK_BUDGET_CHARS, chunk::OVERLAP_TURNS);
    if chunks.is_empty() {
        return Err(AppError::new(
            "longform_empty_transcript",
            "This note has no transcript to summarize.",
        ));
    }

    // Resume where a previous attempt stopped. Chunking is a pure function of
    // the transcript, so the indices line up as long as the transcript has not
    // changed — and `chunk_count` is how we know it has not.
    let mut parts = resumable_parts(repos.note_summary(note_id).await?.as_ref(), chunks.len());
    if !parts.is_empty() {
        tracing::info!(
            note_id = %note_id,
            resumed_at = parts.len(),
            of = chunks.len(),
            "resuming a long-form summary from its finished parts"
        );
    }

    for (index, chunk) in chunks.iter().enumerate().skip(parts.len()) {
        if !still_ours(&repos, note_id, &started_at).await {
            tracing::info!(note_id = %note_id, "long-form summary cancelled");
            return Ok(());
        }
        let part = map_pass(index, chunks.len(), chunk).await?;
        parts.push(part);
        // A provisional paragraph after the first part, so a long run is
        // useful within seconds instead of at the end. Replaced below.
        let provisional = if index == 0 && chunks.len() > 1 {
            short_pass(&parts[0]).await.ok()
        } else {
            None
        };
        let parts_json = serde_json::to_string(&parts).unwrap_or_else(|_| "[]".to_string());
        if let Ok(Some(summary)) = repos
            .set_note_summary_progress(
                note_id,
                index as i64 + 1,
                &parts_json,
                provisional
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty()),
            )
            .await
        {
            emit(app, &summary);
        }
    }
    if !still_ours(&repos, note_id, &started_at).await {
        return Ok(());
    }

    let merged = if parts.len() == 1 {
        parts.into_iter().next().unwrap_or_default()
    } else {
        merge_pass(&parts).await?
    };
    let detailed = resolve_chapter_markers(&merged, &turns);
    let short = short_pass(&detailed).await?;

    if let Some(summary) = repos
        .set_note_summary_ready(note_id, short.trim(), detailed.trim())
        .await?
    {
        emit(app, &summary);
    }
    Ok(())
}

/// The finished map passes a resume may reuse.
///
/// Chunking is a pure function of the transcript, so the parts of an earlier
/// attempt line up with this one's chunks — as long as the transcript has not
/// changed underneath, which `chunk_count` is what tells us. A note that was
/// re-transcribed between attempts chunks differently, and reusing parts then
/// would splice an account of the old audio into a summary of the new.
fn resumable_parts(row: Option<&NoteSummaryDto>, chunk_count: usize) -> Vec<String> {
    let Some(row) = row else {
        return Vec::new();
    };
    if row.chunk_count as usize != chunk_count {
        return Vec::new();
    }
    let mut parts = row.parts.clone();
    parts.truncate(chunk_count);
    parts
}

/// Whether the row this run started on is still the row on disk.
///
/// False means one of two things, and both mean stop: the user deleted it
/// (the cancel), or they deleted it and asked again, in which case a newer
/// run owns the note.
async fn still_ours(repos: &Repositories, note_id: &str, started_at: &str) -> bool {
    match repos.note_summary(note_id).await {
        Ok(row) => row_is_ours(row.as_ref(), started_at),
        // A database error is not a cancellation. Carrying on is the lesser
        // harm: the worst case is finishing work nobody wanted, the
        // alternative is dropping work they did.
        Err(_) => true,
    }
}

/// The decision itself, apart from the database.
fn row_is_ours(row: Option<&NoteSummaryDto>, started_at: &str) -> bool {
    match row {
        // Gone: the user cancelled.
        None => false,
        // A different row: they cancelled and asked again, so a newer run owns
        // this note now.
        Some(row) => row.created_at == started_at,
    }
}

async fn map_pass(index: usize, count: usize, chunk: &Chunk) -> Result<String, AppError> {
    completion(
        prompts::MAP_SYSTEM,
        &prompts::map_user_message(index, count, &chunk.render()),
        "longform_map_failed",
    )
    .await
}

async fn merge_pass(parts: &[String]) -> Result<String, AppError> {
    completion(
        prompts::MERGE_SYSTEM,
        &prompts::merge_user_message(parts),
        "longform_merge_failed",
    )
    .await
}

async fn short_pass(detailed: &str) -> Result<String, AppError> {
    completion(
        prompts::SHORT_SYSTEM,
        &prompts::short_user_message(detailed),
        "longform_short_failed",
    )
    .await
}

/// One non-streaming completion through the sidecar — the same seam the agent,
/// memory extraction and session titles use, so prompt-cache accounting and
/// rail handling stay in one place.
async fn completion(system: &str, user: &str, error_code: &str) -> Result<String, AppError> {
    let response = june_api::proxy_agent_chat_completions(serde_json::json!({
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        // Low but not zero: the material is fixed, the prose should not be
        // mechanical.
        "temperature": 0.3,
        // Sized for reasoning models, whose hidden thinking spends from the
        // same budget as the answer.
        "max_tokens": 8000
    }))
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(AppError::new(
            error_code,
            format!("The model returned status {}.", response.status),
        ));
    }
    let body = response.collect_body().await?;
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|error| AppError::new(error_code, error.to_string()))?;
    let text = june_api::extract_chat_completion_text(&value)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| AppError::new(error_code, "The model returned no text."))?;
    Ok(text)
}

/// Turn every `[t:N]` marker the model handed back into a real timestamp.
///
/// This is the half of the contract the app owns. A marker outside the
/// transcript's range is clamped rather than trusted, and an unresolvable one
/// is dropped so a heading never shows the plumbing.
pub fn resolve_chapter_markers(markdown: &str, turns: &[Turn]) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut rest = markdown;
    while let Some(open) = rest.find("[t:") {
        out.push_str(&rest[..open]);
        let after = &rest[open + 3..];
        let Some(close) = after.find(']') else {
            // Not a marker after all; copy it through untouched.
            out.push_str(&rest[open..]);
            return out;
        };
        let digits = &after[..close];
        match digits.trim().parse::<usize>() {
            Ok(index) => match timestamp_for_index(index, turns) {
                Some(stamp) => out.push_str(&format!("[{stamp}]")),
                // The transcript had no times at all: say nothing rather than
                // something wrong.
                None => trim_trailing_space(&mut out),
            },
            Err(_) => out.push_str(&rest[open..open + 3 + close + 1]),
        }
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    // A dropped marker can leave "## " followed by a space.
    out.replace("##  ", "## ").replace("#  ", "# ")
}

fn trim_trailing_space(out: &mut String) {
    while out.ends_with(' ') {
        out.pop();
    }
}

/// The start time of the turn a marker points at, clamped into range.
fn timestamp_for_index(index: usize, turns: &[Turn]) -> Option<String> {
    if turns.is_empty() {
        return None;
    }
    let clamped = index.min(turns.len() - 1);
    let turn = &turns[clamped];
    // A turn without a start time can still borrow the nearest earlier one:
    // partially-timed transcripts are better served by an approximate anchor
    // than by no chapter times at all.
    let start = turn.start_ms.or_else(|| {
        turns[..=clamped]
            .iter()
            .rev()
            .find_map(|earlier| earlier.start_ms)
    })?;
    Some(chunk::format_timestamp(start))
}

/// Re-drive summaries that were asked for and never finished. Called by
/// [`crate::background::sweep`].
pub async fn resume_unfinished(app: &AppHandle) {
    let Ok(repos) = crate::commands::repositories(app).await else {
        return;
    };
    let Ok(note_ids) = repos.unfinished_note_summaries().await else {
        return;
    };
    for note_id in note_ids {
        if is_running(&note_id) {
            continue;
        }
        tracing::info!(note_id = %note_id, "resuming an unfinished long-form summary");
        spawn_run(app.clone(), note_id);
    }
}

// --- Commands --------------------------------------------------------------

#[tauri::command]
pub async fn note_summary(
    app: AppHandle,
    note_id: String,
) -> Result<Option<NoteSummaryDto>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    Ok(repos.note_summary(&note_id).await?)
}

#[tauri::command]
pub async fn note_summary_plan(app: AppHandle, note_id: String) -> Result<SummaryPlan, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    plan(&repos, &note_id).await
}

#[tauri::command]
pub async fn summarize_note_longform(
    app: AppHandle,
    note_id: String,
) -> Result<NoteSummaryDto, AppError> {
    start(&app, &note_id).await
}

#[tauri::command]
pub async fn forget_note_summary(app: AppHandle, note_id: String) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    repos.delete_note_summary(&note_id).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(index: usize, start_ms: Option<i64>) -> Turn {
        Turn {
            index,
            source: None,
            start_ms,
            end_ms: start_ms.map(|value| value + 500),
            text: format!("turn {index}"),
        }
    }

    #[test]
    fn markers_become_timestamps_the_app_computed() {
        let turns = vec![
            turn(0, Some(0)),
            turn(1, Some(65_000)),
            turn(2, Some(3_600_000)),
        ];

        let resolved = resolve_chapter_markers(
            "## [t:1] The pricing question\nBody.\n\n## [t:2] Closing\nMore.",
            &turns,
        );

        assert!(resolved.contains("## [01:05] The pricing question"));
        assert!(resolved.contains("## [01:00:00] Closing"));
    }

    #[test]
    fn a_marker_past_the_end_is_clamped_rather_than_trusted() {
        let turns = vec![turn(0, Some(0)), turn(1, Some(10_000))];

        let resolved = resolve_chapter_markers("## [t:999] Invented", &turns);

        assert!(
            resolved.contains("## [00:10] Invented"),
            "expected a clamp to the last turn, got {resolved}"
        );
    }

    #[test]
    fn an_untimed_transcript_yields_headings_with_no_timestamp_at_all() {
        let turns = vec![turn(0, None), turn(1, None)];

        let resolved = resolve_chapter_markers("## [t:1] A section\nBody.", &turns);

        assert_eq!(resolved, "## A section\nBody.");
        assert!(!resolved.contains("[t:"), "the plumbing leaked: {resolved}");
    }

    #[test]
    fn a_partially_timed_transcript_borrows_the_nearest_earlier_anchor() {
        let turns = vec![turn(0, Some(30_000)), turn(1, None), turn(2, None)];

        let resolved = resolve_chapter_markers("## [t:2] Later", &turns);

        assert!(resolved.contains("## [00:30] Later"), "got {resolved}");
    }

    #[test]
    fn text_that_merely_looks_like_a_marker_survives_untouched() {
        let turns = vec![turn(0, Some(0))];

        let resolved =
            resolve_chapter_markers("He wrote [t:abc] on the board, then [t: left", &turns);

        assert!(resolved.contains("[t:abc]"));
        assert!(resolved.contains("[t: left"));
    }

    fn row(chunk_count: i64, parts: &[&str]) -> NoteSummaryDto {
        NoteSummaryDto {
            note_id: "note-1".to_string(),
            status: "running".to_string(),
            short_summary: None,
            detailed_summary: None,
            transcript_chars: 0,
            chunk_count,
            chunks_done: parts.len() as i64,
            parts: parts.iter().map(|part| part.to_string()).collect(),
            model: String::new(),
            prompt_version: String::new(),
            last_error: None,
            created_at: "2026-08-23T09:00:00Z".to_string(),
            updated_at: "2026-08-23T09:00:00Z".to_string(),
        }
    }

    /// Deleting the row is the cancel, and a run must tell "my row is gone"
    /// apart from "somebody started a newer run". Both stop this run, and
    /// getting the second one wrong is how one note gets paid for twice.
    #[test]
    fn a_run_stands_down_for_a_cancel_and_for_a_newer_run_alike() {
        let mine = row(4, &[]);
        let started_at = mine.created_at.clone();

        assert!(row_is_ours(Some(&mine), &started_at));
        assert!(!row_is_ours(None, &started_at), "a deleted row is a cancel");

        let mut newer = row(4, &[]);
        newer.created_at = "2999-01-01T00:00:00Z".to_string();
        assert!(
            !row_is_ours(Some(&newer), &started_at),
            "a newer run owns the note now"
        );
    }

    #[test]
    fn a_resume_reuses_the_parts_that_already_landed() {
        let existing = row(12, &["part one", "part two"]);

        let parts = resumable_parts(Some(&existing), 12);

        // Eleven of twelve passes already paid for must not be bought again.
        assert_eq!(parts, vec!["part one".to_string(), "part two".to_string()]);
    }

    #[test]
    fn a_retranscribed_note_starts_over_rather_than_splicing_the_old_audio_in() {
        let existing = row(12, &["part one", "part two"]);

        // The transcript changed, so this run has a different chunk count and
        // the old parts describe audio that is no longer there.
        assert!(resumable_parts(Some(&existing), 9).is_empty());
    }

    #[test]
    fn a_first_run_has_nothing_to_resume() {
        assert!(resumable_parts(None, 5).is_empty());
    }

    /// The number this returns is shown to the user before they agree to
    /// spend it, so it has to match `run` call for call — including the
    /// provisional paragraph, which is easy to forget because it is optional
    /// in the code and unconditional in a fresh multi-part run.
    #[test]
    fn the_quoted_cost_matches_what_a_run_actually_spends() {
        // One chunk: the map pass and the closing paragraph. No merge, and no
        // provisional.
        assert_eq!(model_calls_for(1), 2);
        // Twelve chunks: twelve map passes, the provisional, the merge, the
        // closing paragraph.
        assert_eq!(model_calls_for(12), 15);
        assert_eq!(model_calls_for(2), 5);
        assert_eq!(model_calls_for(0), 0);
    }
}
