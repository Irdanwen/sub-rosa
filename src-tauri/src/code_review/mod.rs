//! Code mode (ADR-0090): a chat that works on the code in its working folder
//! (ADR-0014), and a review of every file it changed, each one kept or
//! reverted by the person.
//!
//! The agent edits files the way it already can in a working folder: its own
//! file tools, or the Claude Code / Codex CLI the person installed, which the
//! runtime already drives. What this module adds is the record of where the
//! folder started, so the review can show what this chat changed, and only
//! that:
//!
//! - **In a git repository with a commit**, the start is the commit the folder
//!   was on, plus a copy of every file that already differed from it or was
//!   untracked. The diff is against that start, not against whatever HEAD is
//!   now, so a commit the agent makes does not hide its work, and work the
//!   person had in progress before the mode started is not offered for
//!   revert.
//! - **Elsewhere**, the start is a copy of the folder's files (rebuilt folders
//!   like `node_modules` skipped, 20 000 files at most).
//!
//! Reverting is the dangerous half, so it is narrow: only a file listed as
//! changed at the moment of the revert, named by a plain relative path, in
//! the folder (a link that leads out is refused), restored from a copy taken
//! at the start or removed if it did not exist. Keeping a change makes the
//! file's current state its new start. The record lives in the app's data
//! folder, never in the working folder, and stopping the mode removes it and
//! touches nothing else.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::domain::types::AppError;

mod review;
#[cfg(test)]
mod tests;
mod tree;

pub use review::{ChangeStatus, FileChange};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeReviewRequest {
    pub session_id: String,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodeReviewStatus {
    pub active: bool,
    pub folder: Option<String>,
    /// `git` or `snapshot`.
    pub base: Option<&'static str>,
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeReviewChanges {
    pub status: CodeReviewStatus,
    pub changes: Vec<FileChange>,
    /// The list was cut (too many files changed, or too many to walk).
    pub truncated: bool,
}

const INACTIVE: CodeReviewStatus = CodeReviewStatus {
    active: false,
    folder: None,
    base: None,
    started_at: None,
};

fn status_of(review: &review::Review) -> CodeReviewStatus {
    CodeReviewStatus {
        active: true,
        folder: Some(review.folder.to_string_lossy().into_owned()),
        base: Some(match review.base {
            review::Base::Git { .. } => "git",
            review::Base::Snapshot => "snapshot",
        }),
        started_at: Some(review.started_at.clone()),
    }
}

/// The session's store, named by a hash of its id so no id can name a path.
fn store(app: &AppHandle, session_id: &str) -> Result<PathBuf, AppError> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err(AppError::new(
            "code_review_invalid",
            "Code mode needs a chat.",
        ));
    }
    let base = crate::app_paths::app_data_dir(app)
        .map_err(|error| AppError::new("code_review_failed", error.to_string()))?;
    Ok(store_in(&base, session_id))
}

fn store_in(base: &std::path::Path, session_id: &str) -> PathBuf {
    let hash = tree::sha(session_id.as_bytes());
    base.join("code-review").join(&hash[..32])
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| AppError::new("code_review_failed", error.to_string()))?
}

/// The folder still passes the working-folder gate (it may have been moved,
/// or replaced by a link, since the mode started).
fn revalidate(app: &AppHandle, review: &review::Review) -> Result<(), AppError> {
    let validated =
        crate::hermes_working_dir::validate_working_dir(app, &review.folder.to_string_lossy())?;
    if validated.path != review.folder {
        return Err(AppError::new(
            "code_review_folder_moved",
            "The working folder has moved since Code mode started. Turn Code mode off and on again.",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn code_review_start(
    app: AppHandle,
    request: CodeReviewRequest,
) -> Result<CodeReviewStatus, AppError> {
    let store = store(&app, &request.session_id)?;
    let folder = request.folder.unwrap_or_default();
    let validated = crate::hermes_working_dir::validate_working_dir(&app, &folder)?;
    let review = blocking(move || review::start(&store, &validated.path)).await?;
    Ok(status_of(&review))
}

#[tauri::command]
pub async fn code_review_status(
    app: AppHandle,
    request: CodeReviewRequest,
) -> Result<CodeReviewStatus, AppError> {
    let store = store(&app, &request.session_id)?;
    let review = blocking(move || review::load(&store)).await?;
    Ok(review.as_ref().map_or(INACTIVE, status_of))
}

#[tauri::command]
pub async fn code_review_changes(
    app: AppHandle,
    request: CodeReviewRequest,
) -> Result<CodeReviewChanges, AppError> {
    let store = store(&app, &request.session_id)?;
    let loaded = {
        let store = store.clone();
        blocking(move || review::load(&store)).await?
    };
    let Some(review) = loaded else {
        return Ok(CodeReviewChanges {
            status: INACTIVE,
            changes: Vec::new(),
            truncated: false,
        });
    };
    let status = status_of(&review);
    let (changes, truncated) = blocking(move || review::changes(&store, &review)).await?;
    Ok(CodeReviewChanges {
        status,
        changes,
        truncated,
    })
}

async fn with_review(
    app: &AppHandle,
    request: CodeReviewRequest,
    act: fn(&std::path::Path, &mut review::Review, &str) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let store = store(app, &request.session_id)?;
    let path = request.path.unwrap_or_default();
    let loaded = {
        let store = store.clone();
        blocking(move || review::load(&store)).await?
    };
    let Some(mut review) = loaded else {
        return Err(AppError::new(
            "code_review_inactive",
            "Code mode is off for this chat.",
        ));
    };
    revalidate(app, &review)?;
    blocking(move || act(&store, &mut review, &path)).await
}

#[tauri::command]
pub async fn code_review_keep(app: AppHandle, request: CodeReviewRequest) -> Result<(), AppError> {
    with_review(&app, request, review::keep).await
}

#[tauri::command]
pub async fn code_review_revert(
    app: AppHandle,
    request: CodeReviewRequest,
) -> Result<(), AppError> {
    with_review(&app, request, |store, review, path| {
        review::revert(store, review, path)
    })
    .await
}

#[tauri::command]
pub async fn code_review_stop(app: AppHandle, request: CodeReviewRequest) -> Result<(), AppError> {
    let store = store(&app, &request.session_id)?;
    blocking(move || review::stop(&store)).await
}
