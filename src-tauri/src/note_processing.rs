//! Stopping a note's pipeline, settling a note whose pipeline ended, and
//! choosing which notes a resume sweep should pick back up.
//!
//! The pipeline itself (`domain::processing`) knows nothing of Tauri, so the
//! command that reaches into it lives here, next to the one rule every spawn
//! site needs when a run returns an error: a run the user stopped is not a run
//! that failed.

use serde::Deserialize;
use tauri::AppHandle;

use crate::{
    db::repositories::Repositories,
    domain::{
        processing_progress::{self, CANCELLED_CODE},
        processing_queue,
        types::{AppError, NoteDto, ProcessingStatus},
    },
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelProcessingRequest {
    pub note_id: String,
}

/// Stop whatever is being done to this note, and whatever was waiting its
/// turn behind it.
///
/// Returns at once. The pipeline stops at its next boundary: between two
/// chunks or two turns (what is in flight finishes, because it is already paid
/// for and its text is kept), or immediately if it is waiting on the note
/// generation. The note then lands in `stopped` with its audio intact.
///
/// Idempotent, and a no-op for a note nothing is working on - a second press,
/// or a press that races the run finishing, changes nothing.
#[tauri::command]
pub fn cancel_processing(request: CancelProcessingRequest) {
    processing_queue::stop_pending(&request.note_id);
    processing_progress::request_stop(&request.note_id);
}

/// Record how a pipeline run that returned an error should leave its note.
///
/// Every spawn site used to write `Failed` with the error's message. That is
/// wrong for exactly one error: the user pressing stop. Nothing failed, the
/// note should not read "needs attention", and on mobile the resume sweep
/// re-runs failed notes - which would quietly restart what was just stopped.
/// This runs after whatever the pipeline wrote on its way out, so it is the
/// last word on the row.
pub async fn settle_failed_run(repos: &Repositories, note_id: &str, error: AppError) {
    let (status, message) = if error.code == CANCELLED_CODE {
        (ProcessingStatus::Stopped, None)
    } else {
        (ProcessingStatus::Failed, Some(error.message))
    };
    let _ = repos.set_note_status(note_id, status, message).await;
}

/// Leave a note the way a finished pipeline run should, whichever way it
/// finished. A note that came out ready is announced: a long transcription
/// usually lands while the app is in the background, which is exactly when
/// the webview is frozen and cannot tell anyone, and that is as true of a run
/// the resume sweep restarted as of the first one (crate::moments).
pub async fn settle_run(
    app: &AppHandle,
    repos: &Repositories,
    note_id: &str,
    result: Result<NoteDto, AppError>,
) {
    match result {
        Err(error) => settle_failed_run(repos, note_id, error).await,
        Ok(ready) => {
            // It has a real title now, which is what makes it findable.
            crate::spotlight::reindex_detached(app);
            crate::moments::announce_note_ready(
                app,
                &ready.id,
                &ready.title,
                ready
                    .edited_content
                    .as_deref()
                    .or(ready.generated_content.as_deref())
                    .unwrap_or_default(),
            );
        }
    }
}

/// The notes a resume sweep should restart: the ones whose request died in
/// transit, and the ones parked mid-pipeline by a process that was killed.
///
/// The row alone cannot tell a dead pipeline from a live one, so both lists
/// are filtered through what this process knows: a note a pipeline holds, or
/// one already waiting its turn in the queue, is left alone. Without the queue
/// check, a second sweep landing between a retry being queued and its pipeline
/// claiming the note queued the same note again, and it was transcribed twice.
pub async fn notes_to_resume(repos: &Repositories) -> Result<Vec<String>, AppError> {
    let mut note_ids = repos.list_notes_failed_in_transit().await?;
    note_ids.extend(repos.list_notes_stuck_in_processing().await?);
    note_ids.retain(|note_id| {
        !crate::domain::processing::is_processing(note_id)
            && !processing_queue::is_enqueued(note_id)
    });
    Ok(note_ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_note_already_queued_or_running_is_not_resumed_again() {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::run_migrations(&pool).await.unwrap();
        let repos = Repositories::new(pool);
        let stuck = repos.create_note(None).await.unwrap().id;
        repos
            .set_note_status(&stuck, ProcessingStatus::Transcribing, None)
            .await
            .unwrap();
        let dropped = repos.create_note(None).await.unwrap().id;
        repos
            .set_note_status(
                &dropped,
                ProcessingStatus::Failed,
                Some("error sending request for url".to_string()),
            )
            .await
            .unwrap();

        let mut found = notes_to_resume(&repos).await.unwrap();
        found.sort();
        let mut expected = vec![stuck.clone(), dropped.clone()];
        expected.sort();
        assert_eq!(found, expected, "nothing holds either note, so both resume");

        let (ticket, _) = processing_queue::enqueue(&stuck);
        let claim = crate::domain::processing::ProcessingClaim::hold(&dropped);
        assert!(
            notes_to_resume(&repos).await.unwrap().is_empty(),
            "a queued note and a running note are already being taken care of"
        );
        drop(ticket);
        drop(claim);
        assert_eq!(notes_to_resume(&repos).await.unwrap().len(), 2);
    }
}
