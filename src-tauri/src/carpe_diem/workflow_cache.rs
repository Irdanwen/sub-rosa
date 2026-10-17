//! The workflow step cache (ADR-0115): what a paid step made, keyed by
//! exactly what it was asked, so asking the same thing again costs nothing.
//!
//! The webview computes both keys (it holds the graph, the catalog and the
//! inputs) and decides what may be cached; this module only keeps the rows.
//! An output is a reference to a gallery file or a short text, never media
//! bytes: whether the file still exists is checked by the webview on every
//! hit, and a row whose file is gone is forgotten. The cache is local to the
//! device and never synchronised.

use serde::{Deserialize, Serialize};
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;

use crate::domain::types::AppError;

/// A key is a hex digest; anything longer is not one.
const MAX_KEY_CHARS: usize = 128;
/// A reference and its metadata, or a chat step's answer. Media bytes never.
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
/// Rows kept, most recently used first. Each is a pointer, so this bounds the
/// table, not the gallery.
const MAX_ROWS: i64 = 5_000;
/// How many static keys one prediction may ask about.
const MAX_KNOWN_QUERY: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CachedStep {
    pub key: String,
    pub static_key: String,
    pub node_type: String,
    pub output: serde_json::Value,
    #[serde(default)]
    pub workflow_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
}

fn invalid(message: &str) -> AppError {
    AppError::new("workflow_cache_invalid", message)
}

fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= MAX_KEY_CHARS && key.chars().all(|c| c.is_ascii_hexdigit())
}

pub async fn get(pool: &SqlitePool, key: &str) -> Result<Option<CachedStep>, AppError> {
    if !valid_key(key) {
        return Err(invalid("A cache key is a hex digest."));
    }
    let row = query(
        "SELECT key, static_key, node_type, output, workflow_id, run_id
         FROM workflow_node_cache WHERE key = ?",
    )
    .bind(key)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    query("UPDATE workflow_node_cache SET used_at = ? WHERE key = ?")
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(key)
        .execute(pool)
        .await?;
    let output: String = row.try_get("output")?;
    Ok(Some(CachedStep {
        key: row.try_get("key")?,
        static_key: row.try_get("static_key")?,
        node_type: row.try_get("node_type")?,
        output: serde_json::from_str(&output).unwrap_or(serde_json::Value::Null),
        workflow_id: row.try_get("workflow_id")?,
        run_id: row.try_get("run_id")?,
    }))
}

pub async fn put(pool: &SqlitePool, step: &CachedStep) -> Result<(), AppError> {
    if !valid_key(&step.key) || !valid_key(&step.static_key) {
        return Err(invalid("A cache key is a hex digest."));
    }
    if step.node_type.trim().is_empty() || step.node_type.len() > 64 {
        return Err(invalid("A cached step needs its type."));
    }
    let output = step.output.to_string();
    if output.len() > MAX_OUTPUT_BYTES {
        return Err(invalid(
            "A cached step keeps a reference, not the media itself.",
        ));
    }
    let now = chrono::Utc::now().to_rfc3339();
    query(
        "INSERT INTO workflow_node_cache
           (key, static_key, node_type, output, workflow_id, run_id, created_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           static_key = excluded.static_key, node_type = excluded.node_type,
           output = excluded.output, workflow_id = excluded.workflow_id,
           run_id = excluded.run_id, used_at = excluded.used_at",
    )
    .bind(&step.key)
    .bind(&step.static_key)
    .bind(&step.node_type)
    .bind(&output)
    .bind(&step.workflow_id)
    .bind(&step.run_id)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    query(
        "DELETE FROM workflow_node_cache WHERE key IN (
           SELECT key FROM workflow_node_cache ORDER BY used_at DESC LIMIT -1 OFFSET ?)",
    )
    .bind(MAX_ROWS)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn forget(pool: &SqlitePool, key: &str) -> Result<(), AppError> {
    if !valid_key(key) {
        return Err(invalid("A cache key is a hex digest."));
    }
    query("DELETE FROM workflow_node_cache WHERE key = ?")
        .bind(key)
        .execute(pool)
        .await?;
    Ok(())
}

/// Which of these static keys have a cached result: the canvas's prediction
/// of what a run will reuse, before anything runs.
pub async fn known(pool: &SqlitePool, static_keys: &[String]) -> Result<Vec<String>, AppError> {
    if static_keys.len() > MAX_KNOWN_QUERY {
        return Err(invalid("Too many steps to look up at once."));
    }
    let mut found = Vec::new();
    for key in static_keys.iter().filter(|key| valid_key(key)) {
        let hit = query("SELECT 1 FROM workflow_node_cache WHERE static_key = ? LIMIT 1")
            .bind(key)
            .fetch_optional(pool)
            .await?;
        if hit.is_some() {
            found.push(key.clone());
        }
    }
    Ok(found)
}

#[tauri::command]
pub async fn workflow_cache_get(
    app: AppHandle,
    key: String,
) -> Result<Option<CachedStep>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    get(&repos.pool, &key).await
}

#[tauri::command]
pub async fn workflow_cache_put(app: AppHandle, step: CachedStep) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    put(&repos.pool, &step).await
}

#[tauri::command]
pub async fn workflow_cache_forget(app: AppHandle, key: String) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    forget(&repos.pool, &key).await
}

#[tauri::command]
pub async fn workflow_cache_known(
    app: AppHandle,
    static_keys: Vec<String>,
) -> Result<Vec<String>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    known(&repos.pool, &static_keys).await
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

    fn step(key: &str, static_key: &str) -> CachedStep {
        CachedStep {
            key: key.into(),
            static_key: static_key.into(),
            node_type: "image".into(),
            output: serde_json::json!({ "kind": "image", "artifactId": "a.png" }),
            workflow_id: Some("w".into()),
            run_id: Some("r".into()),
        }
    }

    #[tokio::test]
    async fn keeps_a_step_and_hands_it_back_by_its_key() {
        let pool = pool().await;
        assert_eq!(get(&pool, "aa").await.unwrap(), None);
        put(&pool, &step("aa", "bb")).await.unwrap();
        assert_eq!(get(&pool, "aa").await.unwrap(), Some(step("aa", "bb")));
        // Asking again replaces, never duplicates.
        let mut again = step("aa", "bb");
        again.run_id = Some("r2".into());
        put(&pool, &again).await.unwrap();
        assert_eq!(get(&pool, "aa").await.unwrap(), Some(again));
        forget(&pool, "aa").await.unwrap();
        assert_eq!(get(&pool, "aa").await.unwrap(), None);
    }

    #[tokio::test]
    async fn predicts_by_static_key() {
        let pool = pool().await;
        put(&pool, &step("aa", "bb")).await.unwrap();
        let found = known(&pool, &["bb".into(), "cc".into(), "not hex".into()])
            .await
            .unwrap();
        assert_eq!(found, vec!["bb".to_string()]);
    }

    #[tokio::test]
    async fn refuses_what_is_not_a_key_or_too_big_to_be_a_reference() {
        let pool = pool().await;
        assert!(get(&pool, "not a key").await.is_err());
        let mut heavy = step("aa", "bb");
        heavy.output = serde_json::json!({ "base64": "A".repeat(MAX_OUTPUT_BYTES) });
        assert!(put(&pool, &heavy).await.is_err());
    }
}
