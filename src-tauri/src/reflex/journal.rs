//! What the app changed on its own, and the way back (ADR-0065).
//!
//! A reflex that acts without a tap writes a row here in the same breath:
//! what it touched, the value before, the value after, and the probability it
//! acted on. Settings › Memory lists the rows and undoes one. An undo is a
//! compare-and-set: it restores the value before only while the row still
//! holds the value after, so undoing never overwrites something the person
//! (or another device) changed since.
//!
//! The journal is local and never synchronised. The change itself travels as
//! an ordinary revision of the row it touched; this is the record of why.

use serde::{Deserialize, Serialize};
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;

use crate::domain::types::AppError;

/// A stored memory rewritten in place because a newer fact replaced it.
pub const MEMORY_UPDATE: &str = "memory_update";
/// A stored memory switched off because a newer fact made it false.
pub const MEMORY_FORGET: &str = "memory_forget";
/// A candidate not stored because a stored memory already said it.
pub const MEMORY_SAME: &str = "memory_same";

/// The part of a memory a change touches, before or after.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryState {
    pub text: String,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutonomousChange {
    pub id: String,
    pub kind: String,
    pub subject_id: String,
    pub before: MemoryState,
    pub after: MemoryState,
    pub probability: f64,
    pub created_at: String,
    pub undone_at: Option<String>,
}

pub async fn record(
    pool: &SqlitePool,
    kind: &str,
    subject_id: &str,
    before: &MemoryState,
    after: &MemoryState,
    probability: f64,
) -> Result<(), sqlx::error::Error> {
    query(
        "INSERT INTO autonomous_changes
           (id, kind, subject_id, before_json, after_json, probability, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(kind)
    .bind(subject_id)
    .bind(serde_json::to_string(before).unwrap_or_default())
    .bind(serde_json::to_string(after).unwrap_or_default())
    .bind(probability)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list(pool: &SqlitePool, limit: i64) -> Result<Vec<AutonomousChange>, AppError> {
    let rows = query(
        "SELECT id, kind, subject_id, before_json, after_json, probability, created_at, undone_at
         FROM autonomous_changes
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?",
    )
    .bind(limit.clamp(1, 200))
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| AutonomousChange {
            id: row.get("id"),
            kind: row.get("kind"),
            subject_id: row.get("subject_id"),
            before: serde_json::from_str(row.get::<String, _>("before_json").as_str())
                .unwrap_or_default(),
            after: serde_json::from_str(row.get::<String, _>("after_json").as_str())
                .unwrap_or_default(),
            probability: row.get("probability"),
            created_at: row.get("created_at"),
            undone_at: row.get("undone_at"),
        })
        .collect())
}

/// Puts back what a change replaced, if nothing moved since.
pub async fn undo(pool: &SqlitePool, change_id: &str) -> Result<AutonomousChange, AppError> {
    let change = list(pool, 200)
        .await?
        .into_iter()
        .find(|change| change.id == change_id)
        .ok_or_else(|| AppError::new("reflex_change_not_found", "That change was not found."))?;
    if change.undone_at.is_some() {
        return Ok(change);
    }
    let restored = match change.kind.as_str() {
        MEMORY_UPDATE | MEMORY_FORGET => query(
            "UPDATE memories SET text = ?, disabled = ?, embedding = CASE WHEN text = ? THEN embedding ELSE NULL END, updated_at = ?
             WHERE id = ? AND text = ? AND disabled = ?",
        )
        .bind(&change.before.text)
        .bind(change.before.disabled as i64)
        .bind(&change.before.text)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(&change.subject_id)
        .bind(&change.after.text)
        .bind(change.after.disabled as i64)
        .execute(pool)
        .await?
        .rows_affected(),
        // Nothing was written for a duplicate left out: store it now.
        MEMORY_SAME => {
            let exists = query("SELECT 1 FROM memories WHERE lower(trim(text)) = lower(trim(?))")
                .bind(&change.before.text)
                .fetch_optional(pool)
                .await?
                .is_some();
            if !exists {
                crate::db::repositories::Repositories::new(pool.clone())
                    .insert_memory(
                        &change.before.text,
                        crate::domain::types::MemorySource::Auto,
                        5,
                    )
                    .await?;
            }
            1
        }
        _ => 0,
    };
    if restored == 0 {
        return Err(AppError::new(
            "reflex_change_moved",
            "This memory changed since, so it was left as it is.",
        ));
    }
    let now = chrono::Utc::now().to_rfc3339();
    query("UPDATE autonomous_changes SET undone_at = ? WHERE id = ?")
        .bind(&now)
        .bind(change_id)
        .execute(pool)
        .await?;
    Ok(AutonomousChange {
        undone_at: Some(now),
        ..change
    })
}

#[tauri::command]
pub async fn reflex_journal(app: AppHandle) -> Result<Vec<AutonomousChange>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    list(&repos.pool, 100).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoChangeRequest {
    pub change_id: String,
}

#[tauri::command]
pub async fn reflex_undo(
    app: AppHandle,
    request: UndoChangeRequest,
) -> Result<AutonomousChange, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let change = undo(&repos.pool, &request.change_id).await?;
    if matches!(change.kind.as_str(), MEMORY_UPDATE | MEMORY_SAME) {
        crate::memory::recall::spawn_backfill(&app);
    }
    Ok(change)
}
