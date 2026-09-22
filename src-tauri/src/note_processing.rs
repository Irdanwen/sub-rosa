//! Stopping a note's pipeline, and settling a note whose pipeline ended badly.
//!
//! The pipeline itself (`domain::processing`) knows nothing of Tauri, so the
//! command that reaches into it lives here, next to the one rule every spawn
//! site needs when a run returns an error: a run the user stopped is not a run
//! that failed.

use serde::Deserialize;

use crate::{
    db::repositories::Repositories,
    domain::{
        processing_progress::{self, CANCELLED_CODE},
        processing_queue,
        types::{AppError, ProcessingStatus},
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
