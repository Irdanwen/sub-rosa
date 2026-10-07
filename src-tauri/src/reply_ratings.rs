//! A thumbs up or down on a chat reply, kept on this device (ADR-0082).
//!
//! The person rates a reply for themselves: to find the good answers again,
//! and to remember which ones misled them. Nothing here is synchronised (the
//! table has no sync trigger, see `account::sync::TABLES`) and nothing reads
//! it to send it anywhere. It leaves the device only inside an archive the
//! person writes on purpose (ADR-0042). One row per reply: rating it again
//! replaces the row, clearing it deletes the row.
//!
//! Shared by both shells. On the phone a conversation is its task id; on the
//! desktop it is the stored Hermes session id.

use serde::{Deserialize, Serialize};
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;

use crate::domain::types::AppError;

/// Why a reply was rated down. The chips the UI offers, by id.
pub const DOWN_REASONS: &[&str] = &[
    "not_accurate",
    "not_helpful",
    "too_long",
    "wrong_language",
    "other",
];

/// A free-text reason is a sentence, not an essay.
pub const MAX_NOTE_CHARS: usize = 500;
const MAX_ID_CHARS: usize = 200;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplyRatingDto {
    pub conversation_id: String,
    pub message_id: String,
    /// `up` or `down`.
    pub rating: String,
    pub reason: Option<String>,
    pub note: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetReplyRatingRequest {
    pub conversation_id: String,
    pub message_id: String,
    /// `up`, `down`, or nothing to clear the rating.
    pub rating: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListReplyRatingsRequest {
    pub conversation_id: String,
}

fn checked_id(value: &str) -> Result<&str, AppError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > MAX_ID_CHARS {
        return Err(AppError::new(
            "reply_rating_invalid",
            "This reply cannot be rated.",
        ));
    }
    Ok(value)
}

/// Records, replaces or clears the rating of one reply. Answers the row as
/// stored, or nothing once cleared. A reason and a note belong to a thumbs
/// down only; on a thumbs up they are dropped.
pub async fn set_rating(
    pool: &SqlitePool,
    request: &SetReplyRatingRequest,
) -> Result<Option<ReplyRatingDto>, AppError> {
    let conversation_id = checked_id(&request.conversation_id)?;
    let message_id = checked_id(&request.message_id)?;
    let Some(rating) = request.rating.as_deref().map(str::trim) else {
        query("DELETE FROM reply_ratings WHERE conversation_id = ?1 AND message_id = ?2")
            .bind(conversation_id)
            .bind(message_id)
            .execute(pool)
            .await?;
        return Ok(None);
    };
    if rating != "up" && rating != "down" {
        return Err(AppError::new(
            "reply_rating_invalid",
            "This reply cannot be rated.",
        ));
    }
    let down = rating == "down";
    let reason = request
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|reason| down && !reason.is_empty());
    if let Some(reason) = reason {
        if !DOWN_REASONS.contains(&reason) {
            return Err(AppError::new(
                "reply_rating_invalid",
                "This reason is not one the app offers.",
            ));
        }
    }
    let note = request
        .note
        .as_deref()
        .map(str::trim)
        .filter(|note| down && !note.is_empty())
        .map(|note| note.chars().take(MAX_NOTE_CHARS).collect::<String>());
    let now = chrono::Utc::now().to_rfc3339();
    query(
        "INSERT INTO reply_ratings (conversation_id, message_id, rating, reason, note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(conversation_id, message_id) DO UPDATE SET
           rating = excluded.rating,
           reason = excluded.reason,
           note = excluded.note,
           updated_at = excluded.updated_at",
    )
    .bind(conversation_id)
    .bind(message_id)
    .bind(rating)
    .bind(reason)
    .bind(note.as_deref())
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(Some(ReplyRatingDto {
        conversation_id: conversation_id.to_string(),
        message_id: message_id.to_string(),
        rating: rating.to_string(),
        reason: reason.map(str::to_string),
        note,
        updated_at: now,
    }))
}

/// Every rating in one conversation.
pub async fn ratings_for(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<Vec<ReplyRatingDto>, AppError> {
    let rows = query(
        "SELECT conversation_id, message_id, rating, reason, note, updated_at
         FROM reply_ratings WHERE conversation_id = ?1 ORDER BY created_at",
    )
    .bind(conversation_id.trim())
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| ReplyRatingDto {
            conversation_id: row.get("conversation_id"),
            message_id: row.get("message_id"),
            rating: row.get("rating"),
            reason: row.get("reason"),
            note: row.get("note"),
            updated_at: row.get("updated_at"),
        })
        .collect())
}

/// Deletes every rating in one conversation. A chat with a task row loses its
/// ratings through a trigger when that row goes (migration 050). A desktop
/// chat kept by the runtime alone has no such row, so its delete calls this.
pub async fn forget_conversation(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<(), sqlx::error::Error> {
    query("DELETE FROM reply_ratings WHERE conversation_id = ?1")
        .bind(conversation_id.trim())
        .execute(pool)
        .await?;
    Ok(())
}

/// [`forget_conversation`] after a desktop session was deleted. Best effort:
/// the chat is already gone, and a rating left behind is never shown again.
pub async fn forget_deleted_session(app: &AppHandle, session_id: &str) {
    let result = async {
        let repos = crate::commands::repositories(app).await?;
        forget_conversation(&repos.pool, session_id)
            .await
            .map_err(AppError::from)
    }
    .await;
    if let Err(error) = result {
        tracing::warn!(code = %error.code, "could not delete the ratings of a deleted chat");
    }
}

#[tauri::command]
pub async fn reply_rating_set(
    app: AppHandle,
    request: SetReplyRatingRequest,
) -> Result<Option<ReplyRatingDto>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    set_rating(&repos.pool, &request).await
}

#[tauri::command]
pub async fn reply_ratings_list(
    app: AppHandle,
    request: ListReplyRatingsRequest,
) -> Result<Vec<ReplyRatingDto>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    ratings_for(&repos.pool, &request.conversation_id).await
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

    fn request(
        rating: Option<&str>,
        reason: Option<&str>,
        note: Option<&str>,
    ) -> SetReplyRatingRequest {
        SetReplyRatingRequest {
            conversation_id: "chat".into(),
            message_id: "m1".into(),
            rating: rating.map(str::to_string),
            reason: reason.map(str::to_string),
            note: note.map(str::to_string),
        }
    }

    #[tokio::test]
    async fn a_rating_is_set_changed_and_cleared() {
        let pool = pool().await;
        let up = set_rating(
            &pool,
            &request(Some("up"), Some("too_long"), Some("ignored")),
        )
        .await
        .unwrap()
        .unwrap();
        // A thumbs up carries no reason.
        assert_eq!((up.rating.as_str(), up.reason, up.note), ("up", None, None));

        set_rating(
            &pool,
            &request(Some("down"), Some("not_accurate"), Some("  wrong date  ")),
        )
        .await
        .unwrap();
        let stored = ratings_for(&pool, "chat").await.unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].rating, "down");
        assert_eq!(stored[0].reason.as_deref(), Some("not_accurate"));
        assert_eq!(stored[0].note.as_deref(), Some("wrong date"));

        assert_eq!(
            set_rating(&pool, &request(None, None, None)).await.unwrap(),
            None
        );
        assert!(ratings_for(&pool, "chat").await.unwrap().is_empty());
        assert!(ratings_for(&pool, "other chat").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn only_the_offered_values_are_stored() {
        let pool = pool().await;
        assert!(set_rating(&pool, &request(Some("meh"), None, None))
            .await
            .is_err());
        assert!(
            set_rating(&pool, &request(Some("down"), Some("rude"), None))
                .await
                .is_err()
        );
        let mut blank = request(Some("up"), None, None);
        blank.message_id = "   ".into();
        assert!(set_rating(&pool, &blank).await.is_err());
        let long = "x".repeat(MAX_NOTE_CHARS + 50);
        let stored = set_rating(&pool, &request(Some("down"), Some("other"), Some(&long)))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            stored.note.map(|note| note.chars().count()),
            Some(MAX_NOTE_CHARS)
        );
    }

    async fn rate(pool: &SqlitePool, conversation_id: &str, message_id: &str) {
        set_rating(
            pool,
            &SetReplyRatingRequest {
                conversation_id: conversation_id.into(),
                message_id: message_id.into(),
                rating: Some("up".into()),
                reason: None,
                note: None,
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn deleting_a_phone_chat_deletes_its_ratings() {
        let pool = pool().await;
        let repos = crate::db::repositories::Repositories::new(pool.clone());
        let gone = repos
            .create_agent_task("a chat", None, Default::default(), None)
            .await
            .unwrap();
        let kept = repos
            .create_agent_task("another chat", None, Default::default(), None)
            .await
            .unwrap();
        rate(&pool, &gone.id, "m1").await;
        rate(&pool, &kept.id, "m1").await;

        repos.delete_agent_task(&gone.id).await.unwrap();

        assert!(ratings_for(&pool, &gone.id).await.unwrap().is_empty());
        assert_eq!(ratings_for(&pool, &kept.id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_reply_removed_on_its_own_takes_its_rating() {
        let pool = pool().await;
        let repos = crate::db::repositories::Repositories::new(pool.clone());
        let task = repos
            .create_agent_task("a chat", None, Default::default(), None)
            .await
            .unwrap();
        for id in ["old reply", "kept reply"] {
            query("INSERT INTO agent_messages (id, task_id, role, content, created_at) VALUES (?, ?, 'assistant', 'text', 'now')")
                .bind(id)
                .bind(&task.id)
                .execute(&pool)
                .await
                .unwrap();
            rate(&pool, &task.id, id).await;
        }

        query("DELETE FROM agent_messages WHERE id = 'old reply'")
            .execute(&pool)
            .await
            .unwrap();

        let left: Vec<_> = ratings_for(&pool, &task.id)
            .await
            .unwrap()
            .into_iter()
            .map(|rating| rating.message_id)
            .collect();
        assert_eq!(left, vec!["kept reply".to_string()]);
    }

    #[tokio::test]
    async fn deleting_a_desktop_session_deletes_its_ratings() {
        let pool = pool().await;
        rate(&pool, "hermes-session", "41").await;
        rate(&pool, "other-session", "41").await;

        forget_conversation(&pool, "hermes-session").await.unwrap();

        assert!(ratings_for(&pool, "hermes-session")
            .await
            .unwrap()
            .is_empty());
        assert_eq!(ratings_for(&pool, "other-session").await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn ratings_are_never_synchronised_and_ride_the_archive() {
        let pool = pool().await;
        let triggers: i64 = query(
            "SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'reply_ratings'",
        )
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("n");
        assert_eq!(
            triggers, 0,
            "a sync trigger would carry ratings off the device"
        );
        assert!(crate::archive::ARCHIVED_TABLES.contains(&"reply_ratings"));
    }
}
