//! Durable Studio workflow runs (ADR-0021): the rows, not the work.
//!
//! A production launched from the workflow canvas outlives the session that
//! started it. The graph itself executes in the webview — two of its node
//! types (frame extraction, assembly) need WebKit's decoders and MediaRecorder,
//! which Rust deliberately does not replicate (no ffmpeg to bundle, notarize,
//! or license) — but every state transition is written here *before* the work
//! it describes, and the long renders ride `media_jobs`, whose Rust pollers
//! run with or without a webview.
//!
//! So a kill or a suspension loses nothing: the renders keep polling, and the
//! next foreground session reads these rows, replays the finished nodes from
//! their dehydrated outputs, re-attaches to pending render jobs by id, and
//! stitches on. The webview is the *executor* of a run, never the *record* of
//! one.

use crate::domain::types::{AppError, WorkflowRunDto, WorkflowRunNodeDto, WorkflowRunStatus};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkflowRunRequest {
    pub id: String,
    pub workflow_id: String,
    pub name: String,
    /// The workflow graph as launched, frozen for the run's lifetime.
    pub definition: serde_json::Value,
    /// Every node id in the graph; one pending row each.
    pub node_ids: Vec<String>,
    /// Per-node cost figures the run was confirmed at, in credits.
    #[serde(default)]
    pub node_costs: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunDetailDto {
    pub run: WorkflowRunDto,
    pub nodes: Vec<WorkflowRunNodeDto>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetWorkflowRunNodeRequest {
    pub run_id: String,
    pub node_id: String,
    /// Mirrors the engine: pending, running, done or error.
    pub status: String,
    #[serde(default)]
    pub output: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishWorkflowRunRequest {
    pub id: String,
    /// "completed" | "failed" | "cancelled" | "awaitingGate".
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
}

/// Record a run the webview is about to execute. The row exists before the
/// first node starts, so there is no window where work is untracked.
#[tauri::command]
pub async fn workflow_run_create(
    app: AppHandle,
    request: CreateWorkflowRunRequest,
) -> Result<WorkflowRunDto, AppError> {
    if request.id.trim().is_empty() || request.node_ids.is_empty() {
        return Err(AppError::new(
            "workflow_run_invalid",
            "A run needs an id and at least one node.",
        ));
    }
    let run = WorkflowRunDto {
        id: request.id,
        workflow_id: request.workflow_id,
        name: request.name,
        definition: request.definition.to_string(),
        status: WorkflowRunStatus::Running,
        error: None,
        node_costs: request.node_costs.map(|value| value.to_string()),
        created_at: String::new(),
        updated_at: String::new(),
    };
    let repos = crate::commands::repositories(&app).await?;
    repos.insert_workflow_run(&run, &request.node_ids).await?;
    let (stored, _) = repos
        .get_workflow_run(&run.id)
        .await?
        .ok_or_else(|| AppError::new("workflow_run_invalid", "The run could not be recorded."))?;
    Ok(stored)
}

/// Every run the UI should know about, newest first.
#[tauri::command]
pub async fn workflow_run_list(app: AppHandle) -> Result<Vec<WorkflowRunDto>, AppError> {
    Ok(crate::commands::repositories(&app)
        .await?
        .list_workflow_runs()
        .await?)
}

/// One run with its per-node state — what a resume reads.
#[tauri::command]
pub async fn workflow_run_get(
    app: AppHandle,
    id: String,
) -> Result<WorkflowRunDetailDto, AppError> {
    let (run, nodes) = crate::commands::repositories(&app)
        .await?
        .get_workflow_run(&id)
        .await?
        .ok_or_else(|| AppError::new("workflow_run_missing", "That run no longer exists."))?;
    Ok(WorkflowRunDetailDto { run, nodes })
}

/// Persist one node's transition. Written before the webview acts on it, so
/// the rows never claim less than what happened.
#[tauri::command]
pub async fn workflow_run_set_node(
    app: AppHandle,
    request: SetWorkflowRunNodeRequest,
) -> Result<(), AppError> {
    crate::commands::repositories(&app)
        .await?
        .set_workflow_run_node(
            &request.run_id,
            &request.node_id,
            &request.status,
            request.output.map(|value| value.to_string()).as_deref(),
            request.error.as_deref(),
        )
        .await?;
    Ok(())
}

/// Settle a run. Completed and failed productions notify — the whole point is
/// that the user may be in another app by the time the last node lands.
#[tauri::command]
pub async fn workflow_run_finish(
    app: AppHandle,
    request: FinishWorkflowRunRequest,
) -> Result<(), AppError> {
    let status = WorkflowRunStatus::from(request.status.as_str());
    let updated = crate::commands::repositories(&app)
        .await?
        .set_workflow_run_status(&request.id, status, request.error.as_deref())
        .await?;
    if let Some(run) = updated {
        match status {
            WorkflowRunStatus::Completed => notify(&app, &run.name, "Your production is ready"),
            WorkflowRunStatus::Failed => notify(&app, &run.name, "Your production stopped"),
            // The production is holding for a decision only the user can
            // make - the one notification that shortens a pause.
            WorkflowRunStatus::AwaitingGate => {
                notify(&app, &run.name, "Your production is waiting on you")
            }
            // A cancel is the user's own act; telling them about it is noise.
            _ => {}
        }
    }
    Ok(())
}

/// Forget a settled run (the UI acknowledged it), or abandon an interrupted
/// one the user does not want to resume.
#[tauri::command]
pub async fn workflow_run_dismiss(app: AppHandle, id: String) -> Result<(), AppError> {
    crate::commands::repositories(&app)
        .await?
        .delete_workflow_run(&id)
        .await?;
    Ok(())
}

/// Best-effort, same contract as the per-job notification in `jobs.rs`:
/// permission was asked for when the production started, a refusal is fine.
fn notify(app: &AppHandle, name: &str, title: &str) {
    let body = if name.trim().is_empty() {
        "Open Sub Rosa to see it.".to_string()
    } else {
        name.trim().chars().take(120).collect::<String>()
    };
    let _ = app.notification().builder().title(title).body(body).show();
}
