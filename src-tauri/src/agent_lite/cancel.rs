//! Stopping a reply: the composer's Stop button.
//!
//! Whether a turn is live stays an in-process question (ADR-0018): every
//! [`TurnClaim`] registers a stop signal under its task id, and the turn
//! checks it between completions and tool rounds and races it against the
//! request and the stream it is reading, so a stop lands mid-sentence rather
//! than at the end of the reply.
//!
//! What was already shown stays, as it does in the chat apps people know: the
//! partial text becomes the assistant message and the task turns `cancelled`
//! in the same transaction. Neither the resume sweep nor a reopened screen
//! ever asks for that reply again, so it is never paid for twice.

use super::{TurnClaim, AGENT_LITE_DONE_EVENT};
use crate::domain::types::{AgentTaskDto, AgentTaskRequest, AppError};
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

/// The error code a stopped turn unwinds with. Never shown: the caller turns
/// it into a saved, cancelled turn.
pub(crate) const STOPPED: &str = "agent_lite_stopped";

#[derive(Default)]
pub(crate) struct StopSignal {
    stopped: AtomicBool,
    wake: Notify,
    /// The reply text on screen when the turn noticed the stop.
    partial: Mutex<String>,
}

impl StopSignal {
    pub(crate) fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.wake.notify_waiters();
    }

    pub(crate) fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Resolves once [`Self::stop`] has been called, including before this
    /// was first polled.
    pub(crate) async fn stopped(&self) {
        let mut notified = std::pin::pin!(self.wake.notified());
        // Registered before the flag is read, so a stop between the two is
        // not missed.
        notified.as_mut().enable();
        if self.is_stopped() {
            return;
        }
        notified.await;
    }

    /// The error a stopped turn returns, keeping what it had shown.
    pub(crate) fn halt(&self, shown: &str) -> AppError {
        shown.clone_into(&mut lock(&self.partial));
        AppError::new(STOPPED, "The reply was stopped.")
    }

    fn partial(&self) -> String {
        lock(&self.partial).clone()
    }
}

/// `work`, unless the turn is stopped first. A stop drops `work` where it
/// stands: the connection closes and nothing more is generated or billed.
pub(crate) async fn unless_stopped<T>(
    signal: &StopSignal,
    work: impl Future<Output = T>,
) -> Option<T> {
    tokio::select! {
        biased;
        () = signal.stopped() => None,
        output = work => Some(output),
    }
}

static SIGNALS: LazyLock<Mutex<HashMap<String, Arc<StopSignal>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// A fresh signal for a turn whose claim was just won, so a stop pressed for
/// an earlier turn never stops the next one. Called under the claims lock.
pub(super) fn register(task_id: &str) {
    lock(&SIGNALS).insert(task_id.to_string(), Arc::default());
}

/// Called under the claims lock as the claim drops.
pub(super) fn release(task_id: &str) {
    lock(&SIGNALS).remove(task_id);
}

/// The live turn's signal; a detached one when nothing holds the task.
pub(crate) fn signal(task_id: &str) -> Arc<StopSignal> {
    lock(&SIGNALS).get(task_id).cloned().unwrap_or_default()
}

/// Stop the task's reply. A turn running in this process notices and saves
/// what it had shown; a turn nobody drives (a suspension left it for the
/// resume sweep) is marked cancelled here, under the claim, so the sweep can
/// never start it afterwards.
#[tauri::command]
pub async fn agent_lite_cancel(
    app: AppHandle,
    request: AgentTaskRequest,
) -> Result<AgentTaskDto, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let task_id = request.task_id;
    let live = {
        let held = super::claims();
        held.contains(&task_id).then(|| signal(&task_id))
    };
    if let Some(signal) = live {
        signal.stop();
        return Ok(repos.get_agent_task(&task_id).await?);
    }
    let Some(_claim) = TurnClaim::try_hold(&task_id) else {
        // A turn started between the two checks: it registered its signal
        // before it could be seen as held.
        signal(&task_id).stop();
        return Ok(repos.get_agent_task(&task_id).await?);
    };
    let task = repos.get_agent_task(&task_id).await?;
    if !super::turn_needs_resume(&task) {
        return Ok(task);
    }
    persist_stopped(&repos, &task_id, "").await?;
    let task = repos.get_agent_task(&task_id).await?;
    let _ = app.emit(AGENT_LITE_DONE_EVENT, &task);
    Ok(task)
}

/// Save a stopped turn: what it had shown (if anything) as the reply, and the
/// task cancelled, in one transaction. A crash between the two would leave
/// either a reply under a running row or a cancelled row the user saw text in.
pub(super) async fn persist_stopped(
    repos: &crate::db::repositories::Repositories,
    task_id: &str,
    partial: &str,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().to_rfc3339();
    let partial = partial.trim();
    let mut tx = repos.pool.begin().await?;
    if !partial.is_empty() {
        sqlx::query::query("INSERT INTO agent_messages(id,task_id,role,content,created_at) VALUES(?,?,'assistant',?,?)")
            .bind(uuid::Uuid::new_v4().to_string()).bind(task_id).bind(partial).bind(&now).execute(&mut *tx).await?;
        crate::chat_titles::mark_first_reply(&mut tx, task_id, &now).await?;
    }
    sqlx::query::query("UPDATE agent_tasks SET status='cancelled',progress_summary='Stopped by the user.',last_error=NULL,updated_at=?,completed_at=? WHERE id=?")
        .bind(&now).bind(&now).bind(task_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// The end of a turn that unwound with [`STOPPED`]. Called while its claim is
/// still held, so the signal (and the partial text on it) is still there.
pub(super) async fn finish_stopped(
    app: &AppHandle,
    repos: &crate::db::repositories::Repositories,
    task_id: &str,
) -> Result<AgentTaskDto, AppError> {
    let partial = signal(task_id).partial();
    persist_stopped(repos, task_id, &partial).await?;
    let task = repos.get_agent_task(task_id).await?;
    let _ = app.emit(AGENT_LITE_DONE_EVENT, &task);
    if !partial.trim().is_empty() {
        crate::chat_titles::spawn(app, task_id.to_string());
    }
    Ok(task)
}
