//! The versions of a workflow the person kept ("Save a version", ⌘S on the
//! canvas): the whole stored graph as it was, under a name they can change,
//! to compare with and to go back to. A run already keeps the graph it ran
//! (workflow_runs), so these are the deliberate ones. Local to the device.

use serde::{Deserialize, Serialize};
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;

use crate::domain::types::AppError;

/// Versions one workflow keeps; the oldest goes when another is saved.
const MAX_VERSIONS: i64 = 100;
/// The largest graph worth keeping: a workflow's own limit.
const MAX_DEFINITION_BYTES: usize = 2 * 1024 * 1024;

fn invalid(message: &str) -> AppError {
    AppError::new("workflow_version_invalid", message)
}

fn storage(error: sqlx::Error) -> AppError {
    AppError::new("workflow_version_storage", error.to_string())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveVersionRequest {
    pub id: String,
    pub workflow_id: String,
    pub label: String,
    pub definition: String,
    pub format_version: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VersionEntry {
    pub id: String,
    pub label: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: String,
    pub workflow_id: String,
    pub label: String,
    pub definition: String,
    pub format_version: i64,
    pub created_at: i64,
}

pub async fn save(pool: &SqlitePool, request: SaveVersionRequest) -> Result<(), AppError> {
    if !valid_id(&request.id) || !valid_id(&request.workflow_id) {
        return Err(invalid("A version needs a valid id and workflow."));
    }
    let label = request.label.trim();
    if label.is_empty() || label.chars().count() > 120 {
        return Err(invalid("A version needs a short name."));
    }
    if request.definition.len() > MAX_DEFINITION_BYTES
        || serde_json::from_str::<serde_json::Value>(&request.definition)
            .map(|value| !value.is_object())
            .unwrap_or(true)
    {
        return Err(invalid("A version's graph is not a workflow."));
    }
    query(
        "INSERT INTO studio_workflow_versions (id, workflow_id, label, definition, format_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&request.id)
    .bind(&request.workflow_id)
    .bind(label)
    .bind(&request.definition)
    .bind(request.format_version.unwrap_or(1))
    .bind(request.created_at)
    .execute(pool)
    .await
    .map_err(storage)?;
    // Keep the newest; the oldest goes.
    query(
        "DELETE FROM studio_workflow_versions WHERE workflow_id = ? AND id NOT IN (
           SELECT id FROM studio_workflow_versions WHERE workflow_id = ?
           ORDER BY created_at DESC LIMIT ?)",
    )
    .bind(&request.workflow_id)
    .bind(&request.workflow_id)
    .bind(MAX_VERSIONS)
    .execute(pool)
    .await
    .map_err(storage)?;
    Ok(())
}

pub async fn list(pool: &SqlitePool, workflow_id: &str) -> Result<Vec<VersionEntry>, AppError> {
    let rows = query(
        "SELECT id, label, created_at FROM studio_workflow_versions
         WHERE workflow_id = ? ORDER BY created_at DESC",
    )
    .bind(workflow_id)
    .fetch_all(pool)
    .await
    .map_err(storage)?;
    rows.iter()
        .map(|row| {
            Ok(VersionEntry {
                id: row.try_get("id").map_err(storage)?,
                label: row.try_get("label").map_err(storage)?,
                created_at: row.try_get("created_at").map_err(storage)?,
            })
        })
        .collect()
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<Version>, AppError> {
    let row = query(
        "SELECT id, workflow_id, label, definition, format_version, created_at
         FROM studio_workflow_versions WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(storage)?;
    row.map(|row| {
        Ok(Version {
            id: row.try_get("id").map_err(storage)?,
            workflow_id: row.try_get("workflow_id").map_err(storage)?,
            label: row.try_get("label").map_err(storage)?,
            definition: row.try_get("definition").map_err(storage)?,
            format_version: row.try_get("format_version").map_err(storage)?,
            created_at: row.try_get("created_at").map_err(storage)?,
        })
    })
    .transpose()
}

pub async fn rename(pool: &SqlitePool, id: &str, label: &str) -> Result<(), AppError> {
    let label = label.trim();
    if label.is_empty() || label.chars().count() > 120 {
        return Err(invalid("A version needs a short name."));
    }
    query("UPDATE studio_workflow_versions SET label = ? WHERE id = ?")
        .bind(label)
        .bind(id)
        .execute(pool)
        .await
        .map_err(storage)?;
    Ok(())
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    query("DELETE FROM studio_workflow_versions WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(storage)?;
    Ok(())
}

#[tauri::command]
pub async fn workflow_version_save(
    app: AppHandle,
    request: SaveVersionRequest,
) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    save(&repos.pool, request).await
}

#[tauri::command]
pub async fn workflow_version_list(
    app: AppHandle,
    workflow_id: String,
) -> Result<Vec<VersionEntry>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    list(&repos.pool, &workflow_id).await
}

#[tauri::command]
pub async fn workflow_version_get(app: AppHandle, id: String) -> Result<Option<Version>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    get(&repos.pool, &id).await
}

#[tauri::command]
pub async fn workflow_version_rename(
    app: AppHandle,
    id: String,
    label: String,
) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    rename(&repos.pool, &id, &label).await
}

#[tauri::command]
pub async fn workflow_version_delete(app: AppHandle, id: String) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    delete(&repos.pool, &id).await
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

    fn version(id: &str, workflow: &str, at: i64) -> SaveVersionRequest {
        SaveVersionRequest {
            id: id.into(),
            workflow_id: workflow.into(),
            label: format!("Version {at}"),
            definition: r#"{"nodes":[],"edges":[]}"#.into(),
            format_version: Some(2),
            created_at: at,
        }
    }

    #[tokio::test]
    async fn versions_come_back_newest_first_one_workflow_at_a_time() {
        let pool = pool().await;
        save(&pool, version("a", "w", 1)).await.unwrap();
        save(&pool, version("b", "w", 2)).await.unwrap();
        save(&pool, version("c", "other", 3)).await.unwrap();
        let listed = list(&pool, "w").await.unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            ["b", "a"]
        );
        let full = get(&pool, "a").await.unwrap().unwrap();
        assert_eq!(full.definition, r#"{"nodes":[],"edges":[]}"#);
        assert_eq!(full.format_version, 2);
    }

    #[tokio::test]
    async fn a_version_is_renamed_and_let_go_and_the_oldest_goes_past_the_cap() {
        let pool = pool().await;
        for at in 0..(MAX_VERSIONS + 2) {
            save(&pool, version(&format!("v{at}"), "w", at))
                .await
                .unwrap();
        }
        let listed = list(&pool, "w").await.unwrap();
        assert_eq!(listed.len() as i64, MAX_VERSIONS);
        assert!(listed
            .iter()
            .all(|entry| entry.id != "v0" && entry.id != "v1"));
        rename(&pool, "v5", "  Before the client call ")
            .await
            .unwrap();
        assert_eq!(
            get(&pool, "v5").await.unwrap().unwrap().label,
            "Before the client call"
        );
        delete(&pool, "v5").await.unwrap();
        assert!(get(&pool, "v5").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn what_is_not_a_workflow_or_a_name_is_refused() {
        let pool = pool().await;
        let mut bad = version("a", "w", 1);
        bad.definition = "[1]".into();
        assert!(save(&pool, bad).await.is_err());
        let mut nameless = version("b", "w", 1);
        nameless.label = "   ".into();
        assert!(save(&pool, nameless).await.is_err());
        assert!(save(&pool, version("../x", "w", 1)).await.is_err());
        assert!(rename(&pool, "a", "").await.is_err());
    }
}
