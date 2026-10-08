//! What a person keeps from a chat: a reply, a link or a place, saved to the
//! Library (ADR-0088).
//!
//! The Library has two halves. Pictures made in a chat are gallery files
//! already, found by the `origin` their generation metadata carries, so they
//! need no table. What is kept here is everything else a chat shows that is
//! not a file: the text of a reply, a link card's row, a place.
//!
//! Kept on this device, like reply ratings (ADR-0082): no sync trigger is
//! installed on the table, and it leaves the device only inside an archive the
//! person writes on purpose. A temporary chat is refused (ADR-0083): saving is
//! one more way out of it.
//!
//! Shared by both shells. On the phone a conversation is its task id; on the
//! desktop it is the stored Hermes session id.

use serde::{Deserialize, Serialize};
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;

use crate::domain::types::AppError;

/// The kinds a card or a reply can be saved as. The table refuses any other.
pub const KINDS: &[&str] = &["reply", "link", "place"];

const MAX_TITLE_CHARS: usize = 200;
const MAX_KEY_CHARS: usize = 2_200;
/// A reply is the largest thing saved, and a long one is still well under it.
const MAX_PAYLOAD_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedItemDto {
    pub id: String,
    pub kind: String,
    pub source_key: String,
    pub title: String,
    /// The item as the card showed it.
    pub payload: serde_json::Value,
    pub conversation_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveItemRequest {
    pub kind: String,
    pub source_key: String,
    pub title: String,
    pub payload: serde_json::Value,
    #[serde(default)]
    pub conversation_id: Option<String>,
}

fn invalid() -> AppError {
    AppError::new("saved_item_invalid", "This cannot be saved to the Library.")
}

fn row_to_dto(row: &sqlx_sqlite::SqliteRow) -> SavedItemDto {
    let payload: String = row.get("payload");
    SavedItemDto {
        id: row.get("id"),
        kind: row.get("kind"),
        source_key: row.get("source_key"),
        title: row.get("title"),
        payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
        conversation_id: row.get("conversation_id"),
        created_at: row.get("created_at"),
    }
}

/// Saves one item, or answers the row already saved under the same key.
pub async fn save(pool: &SqlitePool, request: &SaveItemRequest) -> Result<SavedItemDto, AppError> {
    let kind = request.kind.trim();
    if !KINDS.contains(&kind) {
        return Err(invalid());
    }
    let source_key = request.source_key.trim();
    if source_key.is_empty() || source_key.chars().count() > MAX_KEY_CHARS {
        return Err(invalid());
    }
    if !request.payload.is_object() {
        return Err(invalid());
    }
    let payload = request.payload.to_string();
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(AppError::new(
            "saved_item_too_large",
            "This is too long to save to the Library.",
        ));
    }
    let conversation_id = request
        .conversation_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    if let Some(id) = conversation_id {
        let temporary = crate::temporary_chat::is_temporary(pool, id).await?
            || crate::temporary_chat::is_temporary_session(pool, id).await?;
        if temporary {
            return Err(AppError::new(
                "saved_item_temporary_chat",
                "A temporary chat keeps nothing, so nothing in it can be saved.",
            ));
        }
    }
    let title: String = {
        let trimmed = request.title.trim();
        let title = if trimmed.is_empty() { kind } else { trimmed };
        title.chars().take(MAX_TITLE_CHARS).collect()
    };
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    query(
        "INSERT INTO saved_items (id, kind, source_key, title, payload, conversation_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(source_key) DO NOTHING",
    )
    .bind(&id)
    .bind(kind)
    .bind(source_key)
    .bind(&title)
    .bind(&payload)
    .bind(conversation_id)
    .bind(&now)
    .execute(pool)
    .await?;
    let row = query("SELECT * FROM saved_items WHERE source_key = ?1")
        .bind(source_key)
        .fetch_one(pool)
        .await?;
    Ok(row_to_dto(&row))
}

/// Everything saved, newest first.
pub async fn list(pool: &SqlitePool) -> Result<Vec<SavedItemDto>, AppError> {
    let rows = query("SELECT * FROM saved_items ORDER BY created_at DESC, id")
        .fetch_all(pool)
        .await?;
    Ok(rows.iter().map(row_to_dto).collect())
}

/// Takes one item out of the Library. A no-op for an id that is not there.
pub async fn remove(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    query("DELETE FROM saved_items WHERE id = ?1")
        .bind(id.trim())
        .execute(pool)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn saved_items_list(app: AppHandle) -> Result<Vec<SavedItemDto>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    list(&repos.pool).await
}

#[tauri::command]
pub async fn saved_item_save(
    app: AppHandle,
    request: SaveItemRequest,
) -> Result<SavedItemDto, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    save(&repos.pool, &request).await
}

#[tauri::command]
pub async fn saved_item_remove(app: AppHandle, id: String) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    remove(&repos.pool, &id).await
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

    fn link(url: &str) -> SaveItemRequest {
        SaveItemRequest {
            kind: "link".into(),
            source_key: format!("link:{url}"),
            title: "The docs".into(),
            payload: serde_json::json!({ "url": url, "domain": "example.com" }),
            conversation_id: Some("chat-1".into()),
        }
    }

    #[tokio::test]
    async fn an_item_is_saved_listed_and_removed() {
        let pool = pool().await;
        let saved = save(&pool, &link("https://example.com/a")).await.unwrap();
        assert_eq!(saved.kind, "link");
        assert_eq!(saved.payload["url"], "https://example.com/a");
        assert_eq!(saved.conversation_id.as_deref(), Some("chat-1"));

        let listed = list(&pool).await.unwrap();
        assert_eq!(listed, vec![saved.clone()]);

        remove(&pool, &saved.id).await.unwrap();
        assert!(list(&pool).await.unwrap().is_empty());
        // Removing again is quiet.
        remove(&pool, &saved.id).await.unwrap();
    }

    #[tokio::test]
    async fn saving_the_same_thing_twice_keeps_one_row() {
        let pool = pool().await;
        let first = save(&pool, &link("https://example.com/a")).await.unwrap();
        let second = save(&pool, &link("https://example.com/a")).await.unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(list(&pool).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn refuses_an_unknown_kind_an_empty_key_and_a_bare_payload() {
        let pool = pool().await;
        let mut request = link("https://example.com/a");
        request.kind = "note".into();
        assert_eq!(
            save(&pool, &request).await.unwrap_err().code,
            "saved_item_invalid"
        );

        let mut request = link("https://example.com/a");
        request.source_key = "  ".into();
        assert_eq!(
            save(&pool, &request).await.unwrap_err().code,
            "saved_item_invalid"
        );

        let mut request = link("https://example.com/a");
        request.payload = serde_json::json!("just a string");
        assert_eq!(
            save(&pool, &request).await.unwrap_err().code,
            "saved_item_invalid"
        );
    }

    #[tokio::test]
    async fn refuses_a_payload_past_the_bound() {
        let pool = pool().await;
        let mut request = link("https://example.com/a");
        request.kind = "reply".into();
        request.payload = serde_json::json!({ "text": "a".repeat(MAX_PAYLOAD_BYTES) });
        assert_eq!(
            save(&pool, &request).await.unwrap_err().code,
            "saved_item_too_large"
        );
    }

    #[tokio::test]
    async fn an_untitled_item_takes_its_kind_and_a_long_title_is_cut() {
        let pool = pool().await;
        let mut request = link("https://example.com/a");
        request.title = "   ".into();
        assert_eq!(save(&pool, &request).await.unwrap().title, "link");

        let mut request = link("https://example.com/b");
        request.title = "é".repeat(MAX_TITLE_CHARS + 20);
        let saved = save(&pool, &request).await.unwrap();
        assert_eq!(saved.title.chars().count(), MAX_TITLE_CHARS);
    }

    #[tokio::test]
    async fn saved_items_are_never_synchronised_and_ride_the_archive() {
        let pool = pool().await;
        let triggers: i64 = query(
            "SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'saved_items'",
        )
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("n");
        assert_eq!(
            triggers, 0,
            "a sync trigger would carry the Library off the device"
        );
        assert!(crate::archive::ARCHIVED_TABLES.contains(&"saved_items"));
    }

    #[tokio::test]
    async fn a_temporary_chat_keeps_nothing() {
        let pool = pool().await;
        let task = crate::temporary_chat::create(&pool, "a temporary chat", None)
            .await
            .unwrap();
        crate::temporary_chat::register_session(&pool, "temp-session")
            .await
            .unwrap();
        for conversation in [task.as_str(), "temp-session"] {
            let mut request = link("https://example.com/a");
            request.conversation_id = Some(conversation.into());
            assert_eq!(
                save(&pool, &request).await.unwrap_err().code,
                "saved_item_temporary_chat"
            );
        }
        assert!(list(&pool).await.unwrap().is_empty());
    }
}
