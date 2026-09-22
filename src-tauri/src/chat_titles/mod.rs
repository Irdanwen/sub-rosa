//! A chat's title, named by the model after its first reply.
//!
//! A chat was titled once, at creation, by cutting its first message at 64
//! characters: the history read as a list of half-sentences, and a chat that
//! opened with a photo was called "[Image: IMG_0042.jpg]". A title suggester
//! existed, and the phone called it and threw the answer away.
//!
//! The marker is a row (`agent_task_titles`), written in the same transaction
//! as the first reply, so the work survives iOS suspending the app between the
//! reply and the title (ADR-0018): the background sweep picks up whatever is
//! still pending. Writing the title is a compare-and-set on the title the row
//! expected, so a rename made in the meantime, here or synced from another
//! device, always wins. Everything here is best effort: a failure logs and the
//! chat keeps its first words.
//!
//! Only general chats are titled. A custom assistant's conversation and a
//! desktop Hermes session are named elsewhere and are never touched.

pub mod prompt;

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use sqlx::{query::query, row::Row};
use sqlx_sqlite::{Sqlite, SqlitePool};
use tauri::{AppHandle, Emitter};

use crate::domain::types::{AgentTaskDto, AppError};

/// The list and the open chat listen for this to show a new title at once.
pub const CHAT_TITLE_EVENT: &str = "june://chat-title";
const MAX_ATTEMPTS: i64 = 3;
const SWEEP_BATCH: i64 = 5;
const MAX_TITLE_CHARS: usize = 120;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTitleEvent {
    pub task_id: String,
    pub title: String,
    /// "ai" or "user".
    pub source: &'static str,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameAgentTaskRequest {
    pub task_id: String,
    pub title: String,
}

/// Marks a general chat for titling, inside the transaction that stores its
/// first reply. Does nothing for a custom assistant, a Hermes session, a
/// fork or a later reply: the row is written exactly when the first reply is.
pub(crate) async fn mark_first_reply(
    tx: &mut sqlx::transaction::Transaction<'_, Sqlite>,
    task_id: &str,
    now: &str,
) -> Result<(), AppError> {
    query(
        "INSERT OR IGNORE INTO agent_task_titles(task_id,state,expected_title,attempts,created_at,updated_at) \
         SELECT t.id,'pending',t.title,0,?,? FROM agent_tasks t \
         WHERE t.id=? \
         AND t.safety_profile NOT IN ('custom_assistant','customAssistant') \
         AND t.hermes_session_id IS NULL \
         AND NOT EXISTS (SELECT 1 FROM assistant_conversations c WHERE c.task_id=t.id) \
         AND (SELECT count(*) FROM agent_messages m WHERE m.task_id=t.id AND m.role='assistant')=1",
    )
    .bind(now)
    .bind(now)
    .bind(task_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Chats being titled in this process right now: whether a title is under
/// way is an in-process question, never a database one, or a warm resume
/// would title the same chat twice.
static TITLING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

struct TitleClaim(String);

impl TitleClaim {
    fn take(task_id: &str) -> Option<Self> {
        let mut running = TITLING.lock().ok()?;
        running
            .insert(task_id.to_string())
            .then(|| Self(task_id.to_string()))
    }
}

impl Drop for TitleClaim {
    fn drop(&mut self) {
        if let Ok(mut running) = TITLING.lock() {
            running.remove(&self.0);
        }
    }
}

/// Titles one chat in the background, after its reply has been shown.
pub fn spawn(app: &AppHandle, task_id: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _background = crate::ios_background::BackgroundTask::begin("chat-title");
        if let Err(error) = title_one(&app, &task_id).await {
            tracing::warn!(code = %error.code, "Chat title deferred");
        }
    });
}

/// The sweep's share: the chats whose title is still pending, a few per pass.
pub async fn resume_pending(app: &AppHandle) {
    let Ok(repos) = crate::commands::repositories(app).await else {
        return;
    };
    let pending = query(
        "SELECT task_id FROM agent_task_titles WHERE state='pending' AND attempts<? \
         ORDER BY created_at LIMIT ?",
    )
    .bind(MAX_ATTEMPTS)
    .bind(SWEEP_BATCH)
    .fetch_all(&repos.pool)
    .await
    .unwrap_or_default();
    for row in pending {
        let task_id: String = row.get("task_id");
        if let Err(error) = title_one(app, &task_id).await {
            tracing::warn!(code = %error.code, "Chat title deferred");
        }
    }
}

async fn title_one(app: &AppHandle, task_id: &str) -> Result<(), AppError> {
    let Some(_claim) = TitleClaim::take(task_id) else {
        return Ok(());
    };
    let repos = crate::commands::repositories(app).await?;
    if !is_pending(&repos.pool, task_id).await? {
        return Ok(());
    }
    let task = repos.get_agent_task(task_id).await?;
    let first = |role: &str| {
        task.messages
            .iter()
            .find(|message| message.role.as_db() == role)
            .map(|message| message.content.clone())
            .unwrap_or_default()
    };
    let (first_user, first_reply) = (first("user"), first("assistant"));
    let now = chrono::Utc::now().to_rfc3339();
    match prompt::generate(&first_user, &first_reply).await {
        Ok(Some(title)) => {
            if apply(&repos.pool, task_id, &title, &now).await? {
                let _ = app.emit(
                    CHAT_TITLE_EVENT,
                    ChatTitleEvent {
                        task_id: task_id.to_string(),
                        title,
                        source: "ai",
                    },
                );
            }
            Ok(())
        }
        Ok(None) => settle(&repos.pool, task_id, "skipped", &now).await,
        Err(error) => {
            query(
                "UPDATE agent_task_titles SET attempts=attempts+1, \
                 state=CASE WHEN attempts+1>=? THEN 'failed' ELSE state END, updated_at=? \
                 WHERE task_id=?",
            )
            .bind(MAX_ATTEMPTS)
            .bind(&now)
            .bind(task_id)
            .execute(&repos.pool)
            .await?;
            Err(error)
        }
    }
}

async fn is_pending(pool: &SqlitePool, task_id: &str) -> Result<bool, AppError> {
    Ok(
        query("SELECT 1 FROM agent_task_titles WHERE task_id=? AND state='pending'")
            .bind(task_id)
            .fetch_optional(pool)
            .await?
            .is_some(),
    )
}

async fn settle(pool: &SqlitePool, task_id: &str, state: &str, now: &str) -> Result<(), AppError> {
    query("UPDATE agent_task_titles SET state=?, updated_at=? WHERE task_id=?")
        .bind(state)
        .bind(now)
        .bind(task_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Writes the title only if the chat still carries the title the marker was
/// made with. `updated_at` is left alone: naming a chat is not a new message,
/// and the history must not reorder under the person reading it.
pub(crate) async fn apply(
    pool: &SqlitePool,
    task_id: &str,
    title: &str,
    now: &str,
) -> Result<bool, AppError> {
    let mut tx = pool.begin().await?;
    let changed = query(
        "UPDATE agent_tasks SET title=? WHERE id=? \
         AND title=(SELECT expected_title FROM agent_task_titles WHERE task_id=? AND state='pending')",
    )
    .bind(title)
    .bind(task_id)
    .bind(task_id)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;
    // Only a pending marker settles here: a rename's `user` stays what it is.
    query("UPDATE agent_task_titles SET state=?, updated_at=? WHERE task_id=? AND state='pending'")
        .bind(if changed { "done" } else { "skipped" })
        .bind(now)
        .bind(task_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(changed)
}

fn valid_title(raw: &str) -> Result<String, AppError> {
    let title = raw.trim();
    if title.is_empty()
        || title.chars().count() > MAX_TITLE_CHARS
        || title.chars().any(char::is_control)
    {
        return Err(AppError::new(
            "chat_title_invalid",
            "A chat name needs between 1 and 120 characters, on one line.",
        ));
    }
    Ok(title.to_string())
}

/// Renames a chat. The person's name for it is final: the marker moves to
/// `user`, so a title still being generated can never replace it.
pub(crate) async fn rename(
    pool: &SqlitePool,
    task_id: &str,
    raw: &str,
    now: &str,
) -> Result<String, AppError> {
    let title = valid_title(raw)?;
    let mut tx = pool.begin().await?;
    let changed = query("UPDATE agent_tasks SET title=? WHERE id=?")
        .bind(&title)
        .bind(task_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if changed == 0 {
        return Err(AppError::new(
            "chat_not_found",
            "That chat no longer exists.",
        ));
    }
    query(
        "INSERT INTO agent_task_titles(task_id,state,expected_title,attempts,created_at,updated_at) \
         VALUES(?,'user',?,0,?,?) \
         ON CONFLICT(task_id) DO UPDATE SET state='user', updated_at=excluded.updated_at",
    )
    .bind(task_id)
    .bind(&title)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(title)
}

#[tauri::command]
pub async fn rename_agent_task(
    app: AppHandle,
    request: RenameAgentTaskRequest,
) -> Result<AgentTaskDto, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let now = chrono::Utc::now().to_rfc3339();
    let title = rename(&repos.pool, &request.task_id, &request.title, &now).await?;
    let _ = app.emit(
        CHAT_TITLE_EVENT,
        ChatTitleEvent {
            task_id: request.task_id.clone(),
            title,
            source: "user",
        },
    );
    Ok(repos.get_agent_task(&request.task_id).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::run_migrations(&pool).await.unwrap();
        pool
    }

    async fn chat(pool: &SqlitePool, id: &str, profile: &str, hermes: Option<&str>) {
        query("INSERT INTO agent_tasks(id,title,prompt,status,safety_profile,hermes_session_id,created_at,updated_at) VALUES(?,'What did I decide about the','What did I decide about the','completed',?,?,'t0','t0')")
            .bind(id).bind(profile).bind(hermes).execute(pool).await.unwrap();
        query("INSERT INTO agent_messages(id,task_id,role,content,created_at) VALUES(?,?,'user','What did I decide about the budget?','t0')")
            .bind(format!("{id}-u")).bind(id).execute(pool).await.unwrap();
    }

    async fn reply(pool: &SqlitePool, id: &str, n: u32) {
        let mut tx = pool.begin().await.unwrap();
        query("INSERT INTO agent_messages(id,task_id,role,content,created_at) VALUES(?,?,'assistant','An answer','t1')")
            .bind(format!("{id}-a{n}")).bind(id).execute(&mut *tx).await.unwrap();
        mark_first_reply(&mut tx, id, "t1").await.unwrap();
        tx.commit().await.unwrap();
    }

    async fn state(pool: &SqlitePool, id: &str) -> Option<String> {
        query("SELECT state FROM agent_task_titles WHERE task_id=?")
            .bind(id)
            .fetch_optional(pool)
            .await
            .unwrap()
            .map(|row| row.get("state"))
    }

    async fn title(pool: &SqlitePool, id: &str) -> String {
        query("SELECT title FROM agent_tasks WHERE id=?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
            .get("title")
    }

    #[tokio::test]
    async fn marks_only_the_first_reply_of_a_general_chat() {
        let pool = pool().await;
        chat(&pool, "general", "autonomous_private", None).await;
        chat(&pool, "custom", "custom_assistant", None).await;
        chat(&pool, "hermes", "autonomous_private", Some("h-1")).await;
        for id in ["general", "custom", "hermes"] {
            reply(&pool, id, 1).await;
        }
        assert_eq!(state(&pool, "general").await.as_deref(), Some("pending"));
        assert_eq!(state(&pool, "custom").await, None);
        assert_eq!(state(&pool, "hermes").await, None);

        // A second reply to a chat that was never marked marks nothing.
        chat(&pool, "late", "autonomous_private", None).await;
        reply(&pool, "late", 1).await;
        query("DELETE FROM agent_task_titles WHERE task_id='late'")
            .execute(&pool)
            .await
            .unwrap();
        reply(&pool, "late", 2).await;
        assert_eq!(state(&pool, "late").await, None);
    }

    #[tokio::test]
    async fn a_generated_title_replaces_the_first_words() {
        let pool = pool().await;
        chat(&pool, "c", "autonomous_private", None).await;
        reply(&pool, "c", 1).await;
        assert!(apply(&pool, "c", "Budget decisions", "t2").await.unwrap());
        assert_eq!(title(&pool, "c").await, "Budget decisions");
        assert_eq!(state(&pool, "c").await.as_deref(), Some("done"));
    }

    #[tokio::test]
    async fn a_rename_always_wins() {
        let pool = pool().await;
        chat(&pool, "c", "autonomous_private", None).await;
        reply(&pool, "c", 1).await;
        rename(&pool, "c", "  My budget  ", "t2").await.unwrap();
        assert_eq!(title(&pool, "c").await, "My budget");
        assert!(!apply(&pool, "c", "Budget decisions", "t3").await.unwrap());
        assert_eq!(title(&pool, "c").await, "My budget");
        assert_eq!(state(&pool, "c").await.as_deref(), Some("user"));
    }

    #[tokio::test]
    async fn a_synced_title_change_is_not_overwritten() {
        let pool = pool().await;
        chat(&pool, "c", "autonomous_private", None).await;
        reply(&pool, "c", 1).await;
        // Another device renamed it; the revision landed here before the model answered.
        query("UPDATE agent_tasks SET title='Named elsewhere' WHERE id='c'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(!apply(&pool, "c", "Budget decisions", "t3").await.unwrap());
        assert_eq!(title(&pool, "c").await, "Named elsewhere");
    }

    #[tokio::test]
    async fn refuses_an_empty_or_multiline_name() {
        let pool = pool().await;
        chat(&pool, "c", "autonomous_private", None).await;
        assert_eq!(
            rename(&pool, "c", "   ", "t").await.unwrap_err().code,
            "chat_title_invalid"
        );
        assert_eq!(
            rename(&pool, "c", "a\nb", "t").await.unwrap_err().code,
            "chat_title_invalid"
        );
        assert_eq!(
            rename(&pool, "missing", "Name", "t")
                .await
                .unwrap_err()
                .code,
            "chat_not_found"
        );
    }
}
