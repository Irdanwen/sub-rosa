//! Projects (ADR-0085): a folder that holds notes and chats, given what a
//! chat started in it should know. Instructions the person writes, files
//! read once and searched on demand, and a memory mode:
//!
//! - **Default**: the project's chats use and feed the person's own memory.
//! - **Project only**: what the project's chats learn stays in the project
//!   (`memories.scope` = the folder id), and only that is given back to them.
//!
//! A chat belongs to the project whose folder it is filed in (the "Archive"
//! folder is never a project). The phone's agent-lite rebuilds its prompt every
//! turn, so it reads the project then. The desktop's Hermes runtime shares one
//! SOUL across every chat, so the desktop sends the project as context with a
//! chat's first message instead, and again when the project changes
//! ([`context::desktop_block`]).
//!
//! Settings and files live in their own tables keyed to the folder, so the
//! folder row older devices read is unchanged. Files reuse the assistant
//! reference extractors, directory and file lane.

use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use sqlx::{query::query, row::Row};
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;

pub mod context;
pub mod files;
#[cfg(test)]
mod tests;

pub use files::ProjectFile;

/// The project's chats use and feed the person's own memory.
pub const MEMORY_DEFAULT: &str = "default";
/// The project keeps its memory to itself.
pub const MEMORY_PROJECT: &str = "project";
const MAX_INSTRUCTIONS_CHARS: usize = 8_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub folder_id: String,
    pub instructions: String,
    pub memory_mode: String,
    /// Absent while the project has never been given settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDto {
    pub settings: ProjectSettings,
    pub files: Vec<ProjectFile>,
}

pub(crate) fn not_found() -> AppError {
    AppError::new(
        "project_not_found",
        "This project is no longer available. Go back to your projects and choose another.",
    )
}

/// A live folder, or the error a deleted one gets.
async fn require_folder(pool: &SqlitePool, folder_id: &str) -> Result<String, AppError> {
    query("SELECT name FROM folders WHERE id = ? AND deleted_at IS NULL")
        .bind(folder_id)
        .fetch_optional(pool)
        .await?
        .map(|row| row.get("name"))
        .ok_or_else(not_found)
}

/// The project's settings; the defaults when it has none yet.
pub async fn settings(pool: &SqlitePool, folder_id: &str) -> Result<ProjectSettings, AppError> {
    let row =
        query("SELECT instructions, memory_mode, updated_at FROM project_settings WHERE id = ?")
            .bind(folder_id)
            .fetch_optional(pool)
            .await?;
    Ok(match row {
        Some(row) => ProjectSettings {
            folder_id: folder_id.to_string(),
            instructions: row.get("instructions"),
            memory_mode: normalized_mode(&row.get::<String, _>("memory_mode")).to_string(),
            updated_at: Some(row.get("updated_at")),
        },
        None => ProjectSettings {
            folder_id: folder_id.to_string(),
            instructions: String::new(),
            memory_mode: MEMORY_DEFAULT.to_string(),
            updated_at: None,
        },
    })
}

/// An unknown mode (a newer device's, say) reads as the default, which keeps
/// the person's memory where it always was rather than splitting it.
fn normalized_mode(mode: &str) -> &'static str {
    if mode == MEMORY_PROJECT {
        MEMORY_PROJECT
    } else {
        MEMORY_DEFAULT
    }
}

pub async fn save_settings(
    pool: &SqlitePool,
    folder_id: &str,
    instructions: &str,
    memory_mode: &str,
) -> Result<ProjectSettings, AppError> {
    require_folder(pool, folder_id).await?;
    let instructions = instructions.trim();
    if instructions.chars().count() > MAX_INSTRUCTIONS_CHARS {
        return Err(AppError::new(
            "project_instructions_too_long",
            "Keep project instructions under 8000 characters.",
        ));
    }
    if memory_mode != MEMORY_DEFAULT && memory_mode != MEMORY_PROJECT {
        return Err(AppError::new(
            "project_memory_mode_invalid",
            "Choose Default or Project only for this project's memory.",
        ));
    }
    let current = settings(pool, folder_id).await?;
    if current.updated_at.is_some()
        && current.instructions == instructions
        && current.memory_mode == memory_mode
    {
        return Ok(current);
    }
    query(
        "INSERT INTO project_settings (id, folder_id, instructions, memory_mode, updated_at)
         VALUES (?1, ?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET instructions = excluded.instructions,
           memory_mode = excluded.memory_mode, updated_at = excluded.updated_at",
    )
    .bind(folder_id)
    .bind(instructions)
    .bind(memory_mode)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await?;
    settings(pool, folder_id).await
}

async fn pool(app: &AppHandle) -> Result<SqlitePool, AppError> {
    Ok(crate::commands::repositories(app).await?.pool)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSaveRequest {
    pub folder_id: String,
    pub instructions: String,
    pub memory_mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileAddRequest {
    pub folder_id: String,
    pub name: String,
    /// The file's bytes in base64, optionally as a `data:` URL.
    pub data: String,
}

#[tauri::command]
pub async fn project_get(app: AppHandle, folder_id: String) -> Result<ProjectDto, AppError> {
    let pool = pool(&app).await?;
    require_folder(&pool, &folder_id).await?;
    Ok(ProjectDto {
        settings: settings(&pool, &folder_id).await?,
        files: files::list(&pool, &folder_id).await?,
    })
}

#[tauri::command]
pub async fn project_save(
    app: AppHandle,
    request: ProjectSaveRequest,
) -> Result<ProjectSettings, AppError> {
    save_settings(
        &pool(&app).await?,
        &request.folder_id,
        &request.instructions,
        &request.memory_mode,
    )
    .await
}

#[tauri::command]
pub async fn project_file_add(
    app: AppHandle,
    request: ProjectFileAddRequest,
) -> Result<ProjectFile, AppError> {
    use base64::Engine;
    let encoded = match request.data.split_once(";base64,") {
        Some((_, rest)) => rest,
        None => request.data.as_str(),
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|_| files::unreadable())?;
    let pool = pool(&app).await?;
    require_folder(&pool, &request.folder_id).await?;
    let root = crate::assistants::references_dir(&app)?;
    let file = files::add(&pool, &root, &request.folder_id, &request.name, bytes).await?;
    // The row is durable; the sweep re-drives it if this is cut short.
    files::resume_unfinished(&app).await;
    files::get(&pool, &file.id).await
}

#[tauri::command]
pub async fn project_file_delete(app: AppHandle, id: String) -> Result<(), AppError> {
    let root = crate::assistants::references_dir(&app)?;
    files::delete(&pool(&app).await?, &root, &id).await
}

#[tauri::command]
pub async fn project_context(
    app: AppHandle,
    request: context::ProjectContextRequest,
) -> Result<Option<context::DesktopProjectContext>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    context::desktop_context(&repos, &request).await
}
