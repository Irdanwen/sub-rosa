//! A project's files (ADR-0085). Stored and read exactly like assistant
//! references: the bytes under `assistant-references/<id>.<format>`, the text
//! extracted once into the row by the same extractors, a durable `queued` row
//! re-driven by the background sweep (ADR-0018), and the same encrypted file
//! lane carrying the bytes to other devices. Only the owner differs: a folder
//! instead of an assistant, which is why they have their own table.

use crate::assistants::AssistantReference;
use crate::domain::types::AppError;
use serde::Serialize;
use sqlx::{query::query, row::Row};
use sqlx_sqlite::{SqlitePool, SqliteRow};
use std::path::Path;
use tauri::AppHandle;

/// Rows looked at per sweep, and files read per sweep.
const MAX_SCAN: i64 = 256;
const MAX_EXTRACT: usize = 8;
static EXTRACTION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub id: String,
    pub folder_id: String,
    pub name: String,
    pub format: String,
    /// `queued` until read, then `ready` or `failed` (with `error`).
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Characters of extracted text, so the screen can say how much was read.
    pub chars: i64,
    pub created_at: String,
    pub updated_at: String,
}

fn decode(row: SqliteRow) -> ProjectFile {
    ProjectFile {
        id: row.get("id"),
        folder_id: row.get("folder_id"),
        name: row.get("name"),
        format: row.get("format"),
        status: row.get("status"),
        error: row.get("error"),
        chars: row.get("chars"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

const COLUMNS: &str =
    "id, folder_id, name, format, status, error, length(text) AS chars, created_at, updated_at";

pub(crate) fn unreadable() -> AppError {
    AppError::new(
        "project_file_unreadable",
        "This file could not be read. Choose it again.",
    )
}

fn too_large() -> AppError {
    AppError::new(
        "project_file_too_large",
        "This file is too large. Choose a file under 20 MB.",
    )
}

pub async fn list(pool: &SqlitePool, folder_id: &str) -> Result<Vec<ProjectFile>, AppError> {
    Ok(query(&format!(
        "SELECT {COLUMNS} FROM project_files WHERE folder_id = ? ORDER BY created_at, id"
    ))
    .bind(folder_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(decode)
    .collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<ProjectFile, AppError> {
    query(&format!("SELECT {COLUMNS} FROM project_files WHERE id = ?"))
        .bind(id)
        .fetch_optional(pool)
        .await?
        .map(decode)
        .ok_or_else(|| {
            AppError::new(
                "project_file_missing",
                "This file is no longer in the project.",
            )
        })
}

/// Stores a file for the project and queues it for reading.
pub async fn add(
    pool: &SqlitePool,
    root: &Path,
    folder_id: &str,
    name: &str,
    bytes: Vec<u8>,
) -> Result<ProjectFile, AppError> {
    let name = Path::new(name.trim())
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(unreadable)?
        .to_string();
    let format = crate::documents::format_of(&name);
    let format = match format.as_str() {
        "jpeg" => "jpg".to_string(),
        _ => format,
    };
    if crate::assistants::reference_extension(&format).is_err() {
        return Err(AppError::new(
            "project_file_format",
            "Choose a PDF, Word, Excel, PowerPoint, text, Markdown, CSV or image file.",
        ));
    }
    if bytes.is_empty() {
        return Err(unreadable());
    }
    if bytes.len() as u64 > crate::assistants::MAX_BYTES {
        return Err(too_large());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let file_name = format!("{id}.{format}");
    let target = crate::assistants::reference_file(root, &file_name)?;
    tokio::fs::write(&target, bytes)
        .await
        .map_err(|_| unreadable())?;
    let now = chrono::Utc::now().to_rfc3339();
    query(
        "INSERT INTO project_files (id, folder_id, name, format, file_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(folder_id)
    .bind(&name)
    .bind(&format)
    .bind(&file_name)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    get(pool, &id).await
}

pub async fn delete(pool: &SqlitePool, root: &Path, id: &str) -> Result<(), AppError> {
    let names: Vec<Option<String>> =
        query("DELETE FROM project_files WHERE id = ? RETURNING file_name")
            .bind(id)
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|row| row.get("file_name"))
            .collect();
    for name in names.into_iter().flatten() {
        if let Ok(path) = crate::assistants::reference_file(root, &name) {
            match tokio::fs::remove_file(path).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(unreadable()),
            }
        }
    }
    Ok(())
}

/// Reads the queued files whose bytes are on this device. Metadata can
/// arrive from another device before its file does; such rows are skipped
/// and read on a later sweep.
pub async fn resume_unfinished(app: &AppHandle) {
    let _background = crate::ios_background::BackgroundTask::begin("project-files");
    let Ok(repos) = crate::commands::repositories(app).await else {
        return;
    };
    let Ok(root) = crate::assistants::references_dir(app) else {
        return;
    };
    if let Err(error) = resume_batch(&repos.pool, &root).await {
        tracing::warn!("Project files could not be read: {}", error.message);
    }
}

pub(crate) async fn resume_batch(pool: &SqlitePool, root: &Path) -> Result<usize, AppError> {
    let _claim = EXTRACTION.lock().await;
    // Oldest change first, so a file that keeps missing cannot sit ahead of
    // one that arrived: the scan covers every queued row a project plausibly
    // holds, and only reading is bounded.
    let rows = query(
        "SELECT id, format, file_name FROM project_files
         WHERE status = 'queued' AND file_name IS NOT NULL
         ORDER BY updated_at, id LIMIT ?",
    )
    .bind(MAX_SCAN)
    .fetch_all(pool)
    .await?;
    let mut extracted = 0;
    for row in rows {
        if extracted >= MAX_EXTRACT {
            break;
        }
        let id: String = row.get("id");
        let format: String = row.get("format");
        let name: String = row.get("file_name");
        let Ok(path) = crate::assistants::reference_file(root, &name) else {
            continue;
        };
        if !path.is_file() {
            continue;
        }
        extracted += 1;
        let outcome =
            tokio::task::spawn_blocking(move || crate::assistants::extract(&path, &format)).await;
        let (status, text, error) = match outcome {
            Ok(Ok(text)) => ("ready", text, None),
            Ok(Err(error)) => ("failed", String::new(), Some(error.message)),
            Err(_) => ("failed", String::new(), Some(unreadable().message)),
        };
        query(
            "UPDATE project_files SET status = ?, text = ?, error = ?, updated_at = ?
             WHERE id = ? AND status = 'queued'",
        )
        .bind(status)
        .bind(text)
        .bind(error)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(&id)
        .execute(pool)
        .await?;
    }
    Ok(extracted)
}

/// The project's read files, in the shape the reference search reads.
pub(crate) async fn readable(
    pool: &SqlitePool,
    folder_id: &str,
) -> Result<Vec<AssistantReference>, AppError> {
    Ok(query(
        "SELECT id, folder_id, name, format, text, status, error, file_name, created_at, updated_at
         FROM project_files WHERE folder_id = ? AND status = 'ready' ORDER BY created_at, id",
    )
    .bind(folder_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|row| AssistantReference {
        id: row.get("id"),
        assistant_id: row.get("folder_id"),
        name: row.get("name"),
        format: row.get("format"),
        text: row.get("text"),
        status: row.get("status"),
        error: row.get("error"),
        note_id: None,
        file_name: row.get("file_name"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
    .collect())
}

/// The passages of the project's files that bear on `query_text`, as the
/// `search_project_files` tool returns them. File text is evidence, never an
/// instruction; the prompt that offers the tool says so.
pub async fn search(pool: &SqlitePool, folder_id: &str, query_text: &str) -> String {
    let refs = match readable(pool, folder_id).await {
        Ok(refs) => refs,
        Err(error) => return format!("Project file search failed: {}", error.message),
    };
    if refs.is_empty() {
        return "This project has no readable files yet.".to_string();
    }
    match crate::assistants::reference_context_over(&refs, query_text).await {
        Ok(found) if found.trim().is_empty() => {
            "No passage of the project's files matches that.".to_string()
        }
        Ok(found) => found,
        Err(error) => format!("Project file search failed: {}", error.message),
    }
}

/// The names of the project's files, for the prompt that offers the search.
pub async fn names(pool: &SqlitePool, folder_id: &str) -> Vec<String> {
    query("SELECT name FROM project_files WHERE folder_id = ? ORDER BY created_at, id")
        .bind(folder_id)
        .fetch_all(pool)
        .await
        .map(|rows| rows.into_iter().map(|row| row.get("name")).collect())
        .unwrap_or_default()
}
