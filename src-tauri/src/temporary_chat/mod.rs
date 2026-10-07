//! Temporary chats (ADR-0083): a conversation that is not saved and not
//! remembered.
//!
//! A temporary chat is an ordinary `agent_tasks` row with `ephemeral = 1`
//! (migration 046), so the chat itself runs on the same machinery as any
//! other. What makes it temporary is that every path that would carry it
//! further asks the flag first: the history lists and search, the full-text
//! index (its triggers), past-chat recall, memory extraction, chat titles,
//! the portable copy of a desktop session, the account outbox (its triggers,
//! down to the tombstone of its deletion) and the archive. Each of those has
//! its own test in `tests.rs`.
//!
//! It is deleted when the person leaves it, and whatever a crash or a quit
//! left behind is deleted at the next launch. On the desktop the chat lives in
//! a Hermes session too, which goes through the runtime's own delete. Whether
//! a temporary chat is still open is an in-process question (the `LIVE`
//! registry), never a database one: a row from an earlier process is, by
//! definition, one nobody is looking at.

#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

use serde::Deserialize;
use sqlx::{query::query, row::Row};
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;

use crate::domain::types::{AgentSafetyProfile, AgentTaskDto, AppError};

/// What a temporary chat is called, everywhere. It is never titled by the
/// model: a title is a summary of the conversation, which is what it keeps.
pub const TEMPORARY_TITLE: &str = "Temporary chat";

/// Hermes sessions opened as temporary chats by this process and not left
/// yet. The sweep never touches these.
static LIVE: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

fn live() -> std::sync::MutexGuard<'static, HashSet<String>> {
    LIVE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub async fn is_temporary(pool: &SqlitePool, task_id: &str) -> Result<bool, sqlx::error::Error> {
    Ok(
        query("SELECT 1 FROM agent_tasks WHERE id = ? AND ephemeral = 1")
            .bind(task_id)
            .fetch_optional(pool)
            .await?
            .is_some(),
    )
}

pub async fn is_temporary_session(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<bool, sqlx::error::Error> {
    Ok(
        query("SELECT 1 FROM agent_tasks WHERE hermes_session_id = ? AND ephemeral = 1")
            .bind(session_id)
            .fetch_optional(pool)
            .await?
            .is_some(),
    )
}

/// The `WHERE` the archive reads a table with: a temporary chat is not part
/// of what a person carries away.
pub fn archive_filter(table: &str) -> &'static str {
    match table {
        "agent_tasks" => " WHERE ephemeral = 0",
        "agent_messages" | "agent_tool_events" | "assistant_conversations" => {
            " WHERE task_id NOT IN (SELECT id FROM agent_tasks WHERE ephemeral = 1)"
        }
        "session_folders" => {
            " WHERE session_id NOT IN (SELECT id FROM agent_tasks WHERE ephemeral = 1)"
        }
        _ => "",
    }
}

/// Opens a temporary chat on its first message (the phone). The flag is in
/// the `INSERT` itself, so not even the creation is ever journaled.
pub async fn create(
    pool: &SqlitePool,
    prompt: &str,
    model: Option<&str>,
) -> Result<String, sqlx::error::Error> {
    let now = crate::db::repositories::timestamp();
    let task_id = uuid::Uuid::new_v4().to_string();
    let model = model.map(str::trim).filter(|value| !value.is_empty());
    let mut tx = pool.begin().await?;
    query(
        "INSERT INTO agent_tasks
         (id, title, prompt, status, safety_profile, progress_summary, model, created_at, updated_at, ephemeral)
         VALUES (?, ?, ?, 'queued', ?, 'Queued for the agent runtime.', ?, ?, ?, 1)",
    )
    .bind(&task_id)
    .bind(TEMPORARY_TITLE)
    .bind(prompt)
    .bind(AgentSafetyProfile::default().as_db())
    .bind(model)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    query(
        "INSERT INTO agent_messages (id, task_id, role, content, created_at)
         VALUES (?, ?, 'user', ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&task_id)
    .bind(prompt)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(task_id)
}

/// Records a desktop Hermes session as a temporary chat, before its first
/// message is ever read back, so nothing copies it in the meantime.
pub async fn register_session(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<(), sqlx::error::Error> {
    let now = crate::db::repositories::timestamp();
    query(
        "INSERT INTO agent_tasks
         (id, title, prompt, status, safety_profile, hermes_session_id, created_at, updated_at, ephemeral)
         SELECT ?, ?, '', 'completed', ?, ?, ?, ?, 1
         WHERE NOT EXISTS (SELECT 1 FROM agent_tasks WHERE hermes_session_id = ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(TEMPORARY_TITLE)
    .bind(AgentSafetyProfile::default().as_db())
    .bind(session_id)
    .bind(&now)
    .bind(&now)
    .bind(session_id)
    .execute(pool)
    .await?;
    live().insert(session_id.to_string());
    Ok(())
}

/// Deletes temporary chats and everything that hangs off them. Children go
/// first, while the chat row is still there to say they are temporary: the
/// outbox triggers ask it, and a cascade would ask too late.
async fn delete_rows(pool: &SqlitePool, task_ids: &[String]) -> Result<(), sqlx::error::Error> {
    let mut tx = pool.begin().await?;
    for task_id in task_ids {
        for statement in [
            "DELETE FROM memory_sources WHERE EXISTS (SELECT 1 FROM memory_source_records r JOIN agent_tasks t ON t.id = r.task_id WHERE r.owner_kind = memory_sources.owner_kind AND r.owner_id = memory_sources.owner_id AND r.task_id = ? AND t.ephemeral = 1)",
            "DELETE FROM memory_source_records WHERE task_id = ? AND task_id IN (SELECT id FROM agent_tasks WHERE ephemeral = 1)",
            "DELETE FROM agent_messages WHERE task_id = ? AND task_id IN (SELECT id FROM agent_tasks WHERE ephemeral = 1)",
            "DELETE FROM agent_tool_events WHERE task_id = ? AND task_id IN (SELECT id FROM agent_tasks WHERE ephemeral = 1)",
            "DELETE FROM session_folders WHERE session_id = ? AND session_id IN (SELECT id FROM agent_tasks WHERE ephemeral = 1)",
            "DELETE FROM agent_tasks WHERE id = ? AND ephemeral = 1",
        ] {
            query(statement).bind(task_id).execute(&mut *tx).await?;
        }
    }
    tx.commit().await
}

/// Leaves a temporary chat on the phone: its rows go at once.
pub async fn discard_task(pool: &SqlitePool, task_id: &str) -> Result<(), sqlx::error::Error> {
    delete_rows(pool, &[task_id.to_string()]).await
}

/// The rows of a desktop temporary chat, once its Hermes session is gone.
pub async fn forget_session(pool: &SqlitePool, session_id: &str) -> Result<(), sqlx::error::Error> {
    live().remove(session_id);
    let ids: Vec<String> =
        query("SELECT id FROM agent_tasks WHERE hermes_session_id = ? AND ephemeral = 1")
            .bind(session_id)
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|row| row.get("id"))
            .collect();
    delete_rows(pool, &ids).await
}

/// At the first open of the database in a process: every temporary chat
/// found is left over from an earlier one. A desktop session waits for the
/// runtime to be reachable ([`stale_sessions`]); the rest goes now.
pub async fn sweep_on_open(pool: &SqlitePool) {
    let result = async {
        let ids: Vec<String> =
            query("SELECT id FROM agent_tasks WHERE ephemeral = 1 AND hermes_session_id IS NULL")
                .fetch_all(pool)
                .await?
                .into_iter()
                .map(|row| row.get("id"))
                .collect();
        delete_rows(pool, &ids).await
    }
    .await;
    if let Err(error) = result {
        tracing::warn!(%error, "temporary chats left from an earlier launch were not swept");
    }
}

/// Desktop temporary chats no open window holds: their Hermes session is
/// deleted, then their rows.
pub async fn stale_sessions(pool: &SqlitePool) -> Result<Vec<String>, sqlx::error::Error> {
    let live = live().clone();
    Ok(query(
        "SELECT hermes_session_id FROM agent_tasks WHERE ephemeral = 1 AND hermes_session_id IS NOT NULL",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|row| row.get::<String, _>("hermes_session_id"))
    .filter(|session_id| !live.contains(session_id))
    .collect())
}

/// Every desktop session that is a temporary chat, live or waiting to be
/// deleted: the history lists leave them out.
pub async fn session_ids(pool: &SqlitePool) -> Result<Vec<String>, sqlx::error::Error> {
    Ok(query(
        "SELECT hermes_session_id FROM agent_tasks WHERE ephemeral = 1 AND hermes_session_id IS NOT NULL",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|row| row.get("hermes_session_id"))
    .collect())
}

/// Deletes the Hermes session through the runtime's own delete, which takes
/// its messages and its search index rows out of `state.db`. `Ok(false)`
/// when the runtime cannot be reached: the rows stay, hidden, until it can.
#[cfg(desktop)]
async fn delete_hermes_session(app: &AppHandle, session_id: &str) -> Result<bool, AppError> {
    use tauri::Manager as _;
    let Some(bridge) = app.try_state::<crate::hermes_bridge::HermesBridge>() else {
        return Ok(false);
    };
    match crate::hermes_bridge::hermes_api_json(
        &bridge,
        reqwest::Method::DELETE,
        &format!("/api/sessions/{}", urlencoding::encode(session_id)),
        None,
    )
    .await
    {
        Ok(_) => Ok(true),
        Err(error) if error.code == "hermes_bridge_not_running" => Ok(false),
        // Already gone is what was asked for.
        Err(error)
            if error.code == "hermes_bridge_api_failed"
                && error.message.starts_with("Hermes API returned 404") =>
        {
            Ok(true)
        }
        Err(error) => Err(error),
    }
}

#[cfg(mobile)]
async fn delete_hermes_session(_app: &AppHandle, _session_id: &str) -> Result<bool, AppError> {
    Ok(true)
}

async fn pool(app: &AppHandle) -> Result<SqlitePool, AppError> {
    Ok(crate::commands::repositories(app).await?.pool.clone())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTemporaryChatRequest {
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporaryChatRequest {
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}

/// The phone's first message of a temporary chat.
#[tauri::command]
pub async fn temporary_chat_create(
    app: AppHandle,
    request: CreateTemporaryChatRequest,
) -> Result<AgentTaskDto, AppError> {
    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err(AppError::new(
            "agent_prompt_required",
            "Describe what the agent should do.",
        ));
    }
    let repos = crate::commands::repositories(&app).await?;
    let task_id = create(&repos.pool, prompt, request.model.as_deref()).await?;
    Ok(repos.get_agent_task(&task_id).await?)
}

/// The desktop's new session, marked temporary as soon as Hermes names it.
#[tauri::command]
pub async fn temporary_chat_register(app: AppHandle, session_id: String) -> Result<(), AppError> {
    let session_id = session_id.trim();
    if session_id.is_empty() || session_id.len() > 200 {
        return Err(AppError::new(
            "temporary_chat_invalid",
            "This temporary chat could not be found.",
        ));
    }
    Ok(register_session(&pool(&app).await?, session_id).await?)
}

/// Leaving a temporary chat. Best effort by design: what fails here is
/// deleted at the next launch, and is hidden until then.
#[tauri::command]
pub async fn temporary_chat_discard(
    app: AppHandle,
    request: TemporaryChatRequest,
) -> Result<(), AppError> {
    let pool = pool(&app).await?;
    if let Some(task_id) = request.task_id.as_deref() {
        discard_task(&pool, task_id).await?;
    }
    if let Some(session_id) = request.session_id.as_deref() {
        if !is_temporary_session(&pool, session_id).await? {
            return Ok(());
        }
        live().remove(session_id);
        if delete_hermes_session(&app, session_id).await? {
            forget_session(&pool, session_id).await?;
        }
    }
    Ok(())
}

/// Deletes the desktop temporary chats an earlier launch left behind, once
/// the runtime that holds their sessions is up.
#[tauri::command]
pub async fn temporary_chat_sweep(app: AppHandle) -> Result<(), AppError> {
    let pool = pool(&app).await?;
    for session_id in stale_sessions(&pool).await? {
        match delete_hermes_session(&app, &session_id).await {
            Ok(true) => forget_session(&pool, &session_id).await?,
            Ok(false) => break,
            Err(error) => {
                tracing::warn!(code = %error.code, "a temporary chat's session was not deleted");
            }
        }
    }
    Ok(())
}

/// The desktop sessions the history lists leave out.
#[tauri::command]
pub async fn temporary_chat_sessions(app: AppHandle) -> Result<Vec<String>, AppError> {
    Ok(session_ids(&pool(&app).await?).await?)
}
