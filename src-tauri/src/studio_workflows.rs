//! The Studio's workflow library: every workflow the person drew or imported,
//! durable in SQLite rather than in the webview's local storage (ADR-0075).
//!
//! The graph itself is opaque here: the webview owns its shape and its
//! version, and this module only stores it, bounded, and hands it back. The
//! card's picture is a gallery file id, never a path (gallery paths move on
//! iOS between installs).

use serde::{Deserialize, Serialize};
use sqlx::{query::query, row::Row};
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;

const INVALID: &str = "studio_workflow_invalid";
const STORAGE: &str = "studio_workflow_storage_error";
const MAX_NAME_CHARS: usize = 120;
const MAX_DESCRIPTION_CHARS: usize = 20_000;
/// A large film compiles to a few hundred KB; this leaves ample room.
const MAX_DEFINITION_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredWorkflow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// The graph, as the webview wrote it: `{ nodes, edges }`.
    pub definition: String,
    pub format_version: i64,
    pub origin: String,
    pub cover_artifact_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkflowRequest {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub definition: String,
    pub format_version: Option<i64>,
    pub origin: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}

fn storage<E: std::fmt::Display>(error: E) -> String {
    eprintln!("studio workflows: {error}");
    STORAGE.into()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

async fn pool(app: &AppHandle) -> Result<SqlitePool, String> {
    crate::commands::repositories(app)
        .await
        .map(|repos| repos.pool)
        .map_err(|_| STORAGE.to_owned())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub(crate) async fn list(pool: &SqlitePool) -> Result<Vec<StoredWorkflow>, String> {
    let rows = query(
        "SELECT id, name, description, definition, format_version, origin, cover_artifact_id, created_at, updated_at \
         FROM studio_workflows ORDER BY updated_at DESC",
    )
    .fetch_all(pool)
    .await
    .map_err(storage)?;
    rows.into_iter()
        .map(|row| {
            Ok(StoredWorkflow {
                id: row.try_get("id").map_err(storage)?,
                name: row.try_get("name").map_err(storage)?,
                description: row.try_get("description").map_err(storage)?,
                definition: row.try_get("definition").map_err(storage)?,
                format_version: row.try_get("format_version").map_err(storage)?,
                origin: row.try_get("origin").map_err(storage)?,
                cover_artifact_id: row.try_get("cover_artifact_id").map_err(storage)?,
                created_at: row.try_get("created_at").map_err(storage)?,
                updated_at: row.try_get("updated_at").map_err(storage)?,
            })
        })
        .collect()
}

/// Insert or replace one workflow. Its cover is kept: it belongs to the
/// library, not to the graph the editor sends.
pub(crate) async fn save(pool: &SqlitePool, request: SaveWorkflowRequest) -> Result<(), String> {
    if !valid_id(&request.id) {
        return Err(INVALID.into());
    }
    let name: String = request.name.trim().chars().take(MAX_NAME_CHARS).collect();
    let description = request
        .description
        .map(|text| text.chars().take(MAX_DESCRIPTION_CHARS).collect::<String>())
        .filter(|text| !text.trim().is_empty());
    if request.definition.len() > MAX_DEFINITION_BYTES
        || serde_json::from_str::<serde_json::Value>(&request.definition)
            .map(|value| !value.is_object())
            .unwrap_or(true)
    {
        return Err(INVALID.into());
    }
    let origin = match request.origin.as_deref() {
        Some("import") => "import",
        _ => "mine",
    };
    let now = now_ms();
    query(
        "INSERT INTO studio_workflows (id, name, description, definition, format_version, origin, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, \
         definition = excluded.definition, format_version = excluded.format_version, \
         updated_at = excluded.updated_at",
    )
    .bind(&request.id)
    .bind(&name)
    .bind(&description)
    .bind(&request.definition)
    .bind(request.format_version.unwrap_or(1))
    .bind(origin)
    .bind(request.created_at.unwrap_or(now))
    .bind(request.updated_at.unwrap_or(now))
    .execute(pool)
    .await
    .map_err(storage)?;
    Ok(())
}

pub(crate) async fn delete(pool: &SqlitePool, id: &str) -> Result<(), String> {
    query("DELETE FROM studio_workflows WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(storage)?;
    Ok(())
}

pub(crate) async fn set_cover(
    pool: &SqlitePool,
    id: &str,
    artifact_id: Option<&str>,
) -> Result<(), String> {
    if artifact_id.is_some_and(|value| value.is_empty() || value.len() > 200 || value.contains('/'))
    {
        return Err(INVALID.into());
    }
    query("UPDATE studio_workflows SET cover_artifact_id = ? WHERE id = ?")
        .bind(artifact_id)
        .bind(id)
        .execute(pool)
        .await
        .map_err(storage)?;
    Ok(())
}

#[tauri::command]
pub async fn studio_workflow_list(app: AppHandle) -> Result<Vec<StoredWorkflow>, String> {
    list(&pool(&app).await?).await
}

#[tauri::command]
pub async fn studio_workflow_save(
    app: AppHandle,
    request: SaveWorkflowRequest,
) -> Result<(), String> {
    save(&pool(&app).await?, request).await
}

#[tauri::command]
pub async fn studio_workflow_delete(app: AppHandle, id: String) -> Result<(), String> {
    delete(&pool(&app).await?, &id).await
}

#[tauri::command]
pub async fn studio_workflow_set_cover(
    app: AppHandle,
    id: String,
    artifact_id: Option<String>,
) -> Result<(), String> {
    set_cover(&pool(&app).await?, &id, artifact_id.as_deref()).await
}

/// Desktop: write a workflow file where the person chooses, in the native
/// save dialog, so no destination path crosses from the webview. Resolves to
/// the saved path, or `None` when the dialog was cancelled.
#[cfg(desktop)]
#[tauri::command]
pub async fn studio_workflow_export(
    app: AppHandle,
    name: String,
    contents: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    if contents.len() > MAX_DEFINITION_BYTES {
        return Err(INVALID.into());
    }
    let stem: String = name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .take(80)
        .collect();
    let stem = if stem.trim().is_empty() {
        "Workflow".to_string()
    } else {
        stem.trim().to_string()
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(format!("{stem}.json"))
        .add_filter("Workflow", &["json"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let picked = rx.await.map_err(storage)?;
    let Some(target) = picked.and_then(|path| path.into_path().ok()) else {
        return Ok(None);
    };
    std::fs::write(&target, contents.as_bytes()).map_err(storage)?;
    Ok(Some(target.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx_sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn open() -> (tempfile::TempDir, SqlitePool) {
        let dir = tempfile::tempdir().expect("dir");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(dir.path().join("workflows.sqlite"))
                    .create_if_missing(true),
            )
            .await
            .expect("database");
        for statement in crate::db::migrations::split_sql_statements(include_str!(
            "../migrations/040_studio_workflows.sql"
        )) {
            query(&statement).execute(&pool).await.expect("migration");
        }
        (dir, pool)
    }

    fn request(id: &str, name: &str, updated_at: i64) -> SaveWorkflowRequest {
        SaveWorkflowRequest {
            id: id.into(),
            name: name.into(),
            description: None,
            definition: r#"{"nodes":[],"edges":[]}"#.into(),
            format_version: Some(1),
            origin: None,
            created_at: Some(1),
            updated_at: Some(updated_at),
        }
    }

    #[tokio::test]
    async fn a_saved_workflow_comes_back_newest_first_and_keeps_its_cover() {
        let (_dir, pool) = open().await;
        save(&pool, request("a", "First", 10)).await.unwrap();
        save(&pool, request("b", "Second", 20)).await.unwrap();
        set_cover(&pool, "a", Some("cover.png")).await.unwrap();
        save(&pool, request("a", "First, renamed", 30))
            .await
            .unwrap();
        let listed = list(&pool).await.unwrap();
        assert_eq!(
            listed.iter().map(|w| w.name.as_str()).collect::<Vec<_>>(),
            ["First, renamed", "Second"]
        );
        assert_eq!(listed[0].cover_artifact_id.as_deref(), Some("cover.png"));
        delete(&pool, "a").await.unwrap();
        assert_eq!(list(&pool).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_graph_that_is_not_an_object_or_an_odd_id_is_refused() {
        let (_dir, pool) = open().await;
        let mut bad = request("a", "x", 1);
        bad.definition = "[1,2]".into();
        assert_eq!(save(&pool, bad).await, Err(INVALID.to_string()));
        assert_eq!(
            save(&pool, request("../x", "x", 1)).await,
            Err(INVALID.to_string())
        );
        assert_eq!(
            set_cover(&pool, "a", Some("../../etc")).await,
            Err(INVALID.to_string())
        );
    }

    #[tokio::test]
    async fn an_import_is_remembered_as_one() {
        let (_dir, pool) = open().await;
        let mut imported = request("a", "From Comfy", 1);
        imported.origin = Some("import".into());
        save(&pool, imported).await.unwrap();
        assert_eq!(list(&pool).await.unwrap()[0].origin, "import");
    }
}
