//! The everyday controls on a sent conversation: ask the last question again,
//! edit a question, and the reasoning effort a turn asks for.
//!
//! Only the tail of a conversation is ever rewritten in place: the replies
//! after the last question (Regenerate), or the last question itself and what
//! followed it (Edit). Editing anything earlier branches the chat at that
//! question and asks the edited one there, so nothing the user already read
//! disappears (ADR-0079). Each command takes the turn's claim before it
//! writes and hands it to the run, so a resume sweep in between can never
//! answer the rewound question a second time.

use super::{AgentLiteAttachment, AgentLiteRunRequest, TurnClaim};
use crate::db::repositories::conversations::ForkCut;
use crate::domain::types::{AgentTaskDto, AppError};
use serde::Deserialize;
use tauri::AppHandle;

/// What `reasoning_effort` may say on the wire. Anything else is dropped
/// rather than sent: an unknown value is a 400 the user cannot act on.
pub(super) fn accepted_effort(value: Option<String>) -> Option<String> {
    value.filter(|effort| matches!(effort.as_str(), "low" | "medium" | "high"))
}

fn claim(task_id: &str) -> Result<TurnClaim, AppError> {
    TurnClaim::try_hold(task_id)
        .ok_or_else(|| AppError::new("agent_lite_running", "This chat is already running."))
}

/// Answer the conversation's last question again, dropping the replies it
/// already had.
#[tauri::command]
pub async fn agent_lite_regenerate(
    app: AppHandle,
    request: AgentLiteRunRequest,
) -> Result<AgentTaskDto, AppError> {
    let claim = claim(&request.task_id)?;
    let repos = crate::commands::repositories(&app).await?;
    crate::assistants::general::ensure_general_continuation(&repos.pool, &request.task_id).await?;
    repos
        .rewind_to_last_user_message(&request.task_id)
        .await
        .map_err(|error| match error {
            sqlx::error::Error::RowNotFound => AppError::new(
                "agent_lite_nothing_to_answer",
                "There is no message to answer in this chat.",
            ),
            other => other.into(),
        })?;
    super::run_claimed(app, request, claim).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLiteEditRequest {
    pub task_id: String,
    /// The question being edited.
    pub message_id: String,
    pub content: String,
    pub model: Option<String>,
    pub attachments: Option<Vec<AgentLiteAttachment>>,
    pub reasoning_effort: Option<String>,
}

fn edited_content(content: &str) -> Result<&str, AppError> {
    let content = content.trim();
    if content.is_empty() {
        return Err(AppError::new(
            "agent_message_required",
            "Message content is required.",
        ));
    }
    Ok(content)
}

/// Rewrite the last question and answer it again. Waits for the answer, like
/// [`super::agent_lite_run`].
#[tauri::command]
pub async fn agent_lite_edit_last(
    app: AppHandle,
    request: AgentLiteEditRequest,
) -> Result<AgentTaskDto, AppError> {
    let content = edited_content(&request.content)?;
    let claim = claim(&request.task_id)?;
    let repos = crate::commands::repositories(&app).await?;
    crate::assistants::general::ensure_general_continuation(&repos.pool, &request.task_id).await?;
    if !repos
        .rewrite_last_user_message(&request.task_id, &request.message_id, content)
        .await?
    {
        return Err(AppError::new(
            "agent_lite_edit_stale",
            "This message is no longer the last one. Reopen the chat and try again.",
        ));
    }
    super::run_claimed(
        app,
        AgentLiteRunRequest {
            task_id: request.task_id,
            model: request.model,
            attachments: request.attachments,
            reasoning_effort: request.reasoning_effort,
        },
        claim,
    )
    .await
}

/// Edit an earlier question: a new chat holding everything before it, ending
/// on the edited question, answered in the background. Returns the new chat at
/// once so the screen can open it and watch the answer arrive; the queued row
/// is what lets the resume sweep finish it if the phone suspends first.
#[tauri::command]
pub async fn agent_lite_edit_branch(
    app: AppHandle,
    request: AgentLiteEditRequest,
) -> Result<AgentTaskDto, AppError> {
    let content = edited_content(&request.content)?;
    let repos = crate::commands::repositories(&app).await?;
    crate::assistants::general::ensure_general_continuation(&repos.pool, &request.task_id).await?;
    let branch = repos
        .fork_agent_task_until(
            &request.task_id,
            request.model.as_deref(),
            Some(ForkCut::Before(&request.message_id)),
            Some(content),
        )
        .await?;
    // The branch is committed queued, so a resume sweep may already be
    // answering it. Then there is nothing to start here.
    if let Some(claim) = TurnClaim::try_hold(&branch.id) {
        let run = AgentLiteRunRequest {
            task_id: branch.id.clone(),
            model: request.model,
            attachments: request.attachments,
            reasoning_effort: request.reasoning_effort,
        };
        tauri::async_runtime::spawn(async move {
            let _ = super::run_claimed(app, run, claim).await;
        });
    }
    Ok(branch)
}
