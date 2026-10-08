//! A run on agent-lite: the phone has no Hermes, so a run is an ordinary chat
//! whose first message is the run's prompt, answered by the same tool loop as
//! any other. The chat is the durable row (ADR-0018): if the phone locks
//! mid-run, the user message is persisted and the background sweep finishes
//! the turn; the harvest reads the reply when it lands.
//!
//! What the run may use is decided by the assignment, not by the chat. The
//! allowed tools ride in a task-local for the length of the turn, and
//! `assistants::runtime::allows_tool` reads it, so the gate is the same one
//! that already narrows a custom assistant's tools.

use std::collections::BTreeSet;
use std::sync::Arc;

use tauri::AppHandle;

use crate::agent_lite::{AgentLiteRunRequest, TurnClaim};
use crate::domain::types::{AgentMessageRole, AgentTaskStatus, AppError};

tokio::task_local! {
    static ALLOWED: Arc<BTreeSet<&'static str>>;
}

/// Inside a scheduled run: whether the run may be offered this tool. Outside
/// one, `None`, and the ordinary rules apply.
pub fn scoped_allows(name: &str) -> Option<bool> {
    ALLOWED.try_with(|allowed| allowed.contains(name)).ok()
}

/// File the run's chat and start its turn. Returns the chat's id, which is
/// the run's handle.
pub async fn start(
    app: &AppHandle,
    title: &str,
    prompt: &str,
    allowed: BTreeSet<&'static str>,
) -> Result<String, AppError> {
    let repos = crate::commands::repositories(app).await?;
    let task = repos
        .create_agent_task(prompt, Some(title), Default::default(), None)
        .await?;
    let Some(claim) = TurnClaim::try_hold(&task.id) else {
        return Err(AppError::new(
            "assignment_run_busy",
            "This run is already under way.",
        ));
    };
    spawn_turn(app, task.id.clone(), allowed, claim);
    Ok(task.id)
}

/// Run again a turn that a suspension cut in half, under the run's tools.
/// Nothing happens when the turn is live in this process (its claim is held)
/// or when it is not waiting for a reply.
pub async fn resume_if_interrupted(
    app: &AppHandle,
    task_id: &str,
    allowed: BTreeSet<&'static str>,
) {
    let Ok(repos) = crate::commands::repositories(app).await else {
        return;
    };
    let Ok(task) = repos.get_agent_task(task_id).await else {
        return;
    };
    let waiting = matches!(
        task.status,
        AgentTaskStatus::Queued | AgentTaskStatus::Running | AgentTaskStatus::Paused
    ) && task
        .messages
        .last()
        .is_some_and(|message| message.role == AgentMessageRole::User);
    if !waiting {
        return;
    }
    let Some(claim) = TurnClaim::try_hold(task_id) else {
        return;
    };
    spawn_turn(app, task_id.to_string(), allowed, claim);
}

fn spawn_turn(app: &AppHandle, task_id: String, allowed: BTreeSet<&'static str>, claim: TurnClaim) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let request = AgentLiteRunRequest {
            task_id,
            model: None,
            attachments: None,
            reasoning_effort: None,
        };
        let _ = ALLOWED
            .scope(
                Arc::new(allowed),
                crate::agent_lite::run_claimed(handle.clone(), request, claim),
            )
            .await;
        // Close the run while the answer is fresh, rather than at the next tick.
        super::tick(&handle).await;
    });
}

/// Where a run's chat has got to.
pub enum Outcome {
    Pending,
    Answer(String),
    Failed(String),
}

pub async fn poll(app: &AppHandle, task_id: &str) -> Outcome {
    let Ok(repos) = crate::commands::repositories(app).await else {
        return Outcome::Pending;
    };
    let Ok(task) = repos.get_agent_task(task_id).await else {
        return Outcome::Failed("The chat this run wrote in was deleted.".into());
    };
    match task.status {
        AgentTaskStatus::Completed => task
            .messages
            .iter()
            .rev()
            .find(|message| message.role == AgentMessageRole::Assistant)
            .map(|message| Outcome::Answer(message.content.clone()))
            .unwrap_or_else(|| Outcome::Failed("The run left no answer.".into())),
        AgentTaskStatus::Failed | AgentTaskStatus::Cancelled => Outcome::Failed(
            task.last_error
                .unwrap_or_else(|| "The run did not finish.".into()),
        ),
        _ => Outcome::Pending,
    }
}
