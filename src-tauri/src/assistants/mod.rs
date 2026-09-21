//! Portable, private assistant definitions. Runtime permissions are enforced natively.
use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use sqlx::{query::query, row::Row};
use sqlx_sqlite::{SqlitePool, SqliteRow};
use tauri::AppHandle;
pub mod draft;
pub(crate) mod general;
pub mod media;
mod media_settings;
mod references;
pub mod runtime;
pub use references::*;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AssistantDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub instructions: String,
    pub model: String,
    pub opening_message: String,
    pub tools: Vec<String>,
    pub allow_notes: bool,
    pub allow_memory: bool,
    pub avatar_ref: Option<String>,
    pub cover_ref: Option<String>,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}
pub(super) fn error(code: &str) -> AppError {
    match code {
        "assistant_not_found" => AppError::new(
            "assistant_not_found",
            "This assistant is no longer available. Return to your assistants and choose another.",
        ),
        "assistant_conflict" => AppError::new(
            "assistant_conflict",
            "This assistant changed on another screen. Reload it before saving your changes.",
        ),
        "assistant_image_invalid" => AppError::new(
            "assistant_image_invalid",
            "Choose a valid image belonging to this assistant.",
        ),
        "assistant_reference_unavailable" => AppError::new(
            "assistant_reference_unavailable",
            "The file could not be opened. Choose it again.",
        ),
        "assistant_reference_format" => AppError::new(
            "assistant_reference_format",
            "Choose a text, Markdown, PDF, Office document or supported image.",
        ),
        "assistant_reference_invalid" => AppError::new(
            "assistant_reference_invalid",
            "This document could not be read. Export a new copy and try again.",
        ),
        "assistant_reference_too_large" => AppError::new(
            "assistant_reference_too_large",
            "This reference is too large. Choose a file under 20 MB with less than 240 KB of text.",
        ),
        "assistant_reference_missing" => AppError::new(
            "assistant_reference_missing",
            "This reference is not on this device yet. Let synchronization finish or add it again.",
        ),
        "assistant_reference_encoding" => AppError::new(
            "assistant_reference_encoding",
            "Save this text file as UTF-8 and add it again.",
        ),
        "assistant_reference_needs_ocr" => AppError::new(
            "assistant_reference_needs_ocr",
            "This PDF has no readable text. Convert its scanned pages to text and add it again.",
        ),
        "note_not_found" => AppError::new(
            "note_not_found",
            "The original note is no longer available. Your saved reference has been kept.",
        ),
        _ => AppError::new(
            "assistant_invalid",
            "Check the assistant name, instructions and selected tools, then try again.",
        ),
    }
}
pub(super) async fn pool(app: &AppHandle) -> Result<SqlitePool, AppError> {
    Ok(crate::commands::repositories(app).await?.pool)
}
fn decode(row: SqliteRow) -> Result<AssistantDefinition, AppError> {
    Ok(AssistantDefinition {
        id: row.get("id"),
        name: row.get("name"),
        description: row.get("description"),
        instructions: row.get("instructions"),
        model: row.get("model"),
        opening_message: row.get("opening_message"),
        tools: serde_json::from_str(&row.get::<String, _>("tools_json"))
            .map_err(|_| error("assistant_invalid"))?,
        allow_notes: row.get("allow_notes"),
        allow_memory: row.get("allow_memory"),
        avatar_ref: row.get("avatar_ref"),
        cover_ref: row.get("cover_ref"),
        revision: row.get("revision"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}
pub async fn snapshot(pool: &SqlitePool, id: &str) -> Result<AssistantDefinition, AppError> {
    let row = query("SELECT * FROM assistants WHERE id=?")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| error("assistant_not_found"))?;
    decode(row)
}
pub async fn save(
    pool: &SqlitePool,
    mut definition: AssistantDefinition,
) -> Result<AssistantDefinition, AppError> {
    definition.name = definition.name.trim().to_owned();
    if definition.name.is_empty()
        || definition.name.len() > 200
        || definition.description.len() > 4000
        || definition.instructions.len() > 64000
        || definition.opening_message.len() > 8000
        || definition.model.len() > 200
        || definition
            .tools
            .iter()
            .any(|key| !matches!(key.as_str(), "web" | "image" | "video" | "music" | "speech"))
    {
        return Err(error("assistant_invalid"));
    }
    definition.tools.sort();
    definition.tools.dedup();
    let fresh = definition.id.is_empty();
    if fresh {
        definition.id = uuid::Uuid::new_v4().to_string();
    }
    uuid::Uuid::parse_str(&definition.id).map_err(|_| error("assistant_invalid"))?;
    let mut tx = pool.begin().await?;
    for id in [&definition.avatar_ref, &definition.cover_ref]
        .into_iter()
        .flatten()
    {
        if query("SELECT 1 FROM assistant_references WHERE id=? AND assistant_id=? AND format IN ('png','jpg','jpeg','webp','gif') AND status='ready'")
            .bind(id).bind(&definition.id).fetch_optional(&mut *tx).await?.is_none() {return Err(error("assistant_image_invalid"));}
    }
    definition.updated_at = chrono::Utc::now().to_rfc3339();
    if fresh {
        definition.created_at = definition.updated_at.clone();
        definition.revision = 1;
    } else {
        let old = query("SELECT revision,created_at FROM assistants WHERE id=?")
            .bind(&definition.id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| error("assistant_not_found"))?;
        if old.get::<i64, _>("revision") != definition.revision {
            return Err(error("assistant_conflict"));
        }
        definition.created_at = old.get("created_at");
        definition.revision += 1;
    }
    query("INSERT INTO assistants(id,name,description,instructions,model,opening_message,tools_json,allow_notes,allow_memory,avatar_ref,cover_ref,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,instructions=excluded.instructions,model=excluded.model,opening_message=excluded.opening_message,tools_json=excluded.tools_json,allow_notes=excluded.allow_notes,allow_memory=excluded.allow_memory,avatar_ref=excluded.avatar_ref,cover_ref=excluded.cover_ref,revision=excluded.revision,updated_at=excluded.updated_at")
        .bind(&definition.id).bind(&definition.name).bind(&definition.description).bind(&definition.instructions).bind(&definition.model).bind(&definition.opening_message)
        .bind(serde_json::to_string(&definition.tools).map_err(|_|error("assistant_invalid"))?).bind(definition.allow_notes).bind(definition.allow_memory)
        .bind(&definition.avatar_ref).bind(&definition.cover_ref).bind(definition.revision).bind(&definition.created_at).bind(&definition.updated_at)
        .execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(definition)
}
#[tauri::command]
pub async fn assistant_list(app: AppHandle) -> Result<Vec<AssistantDefinition>, AppError> {
    query("SELECT * FROM assistants ORDER BY updated_at DESC")
        .fetch_all(&pool(&app).await?)
        .await?
        .into_iter()
        .map(decode)
        .collect()
}
#[tauri::command]
pub async fn assistant_save(
    app: AppHandle,
    definition: AssistantDefinition,
) -> Result<AssistantDefinition, AppError> {
    save(&pool(&app).await?, definition).await
}
#[tauri::command]
pub async fn assistant_delete(app: AppHandle, id: String, revision: i64) -> Result<(), AppError> {
    let result = query("DELETE FROM assistants WHERE id=? AND revision=?")
        .bind(id)
        .bind(revision)
        .execute(&pool(&app).await?)
        .await?;
    if result.rows_affected() != 1 {
        return Err(error("assistant_conflict"));
    }
    Ok(())
}
#[tauri::command]
pub async fn assistant_duplicate(
    app: AppHandle,
    id: String,
) -> Result<AssistantDefinition, AppError> {
    let pool = pool(&app).await?;
    let mut definition = snapshot(&pool, &id).await?;
    let avatar = definition.avatar_ref.take();
    let cover = definition.cover_ref.take();
    definition.id.clear();
    let mut copy = save(&pool, definition).await?;
    for reference in list_references(&pool, &id).await? {
        let ref_id = uuid::Uuid::new_v4().to_string();
        if avatar.as_deref() == Some(&reference.id) {
            copy.avatar_ref = Some(ref_id.clone());
        }
        if cover.as_deref() == Some(&reference.id) {
            copy.cover_ref = Some(ref_id.clone());
        }
        query("INSERT INTO assistant_references(id,assistant_id,name,format,text,status,error,note_id,file_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
            .bind(ref_id).bind(&copy.id).bind(reference.name).bind(reference.format).bind(reference.text)
            .bind(reference.status).bind(reference.error).bind(reference.note_id).bind(reference.file_name).bind(&copy.created_at).bind(&copy.created_at).execute(&pool).await?;
    }
    save(&pool, copy).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn revisions_are_checked_and_context_is_opt_in() {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for statement in include_str!("../../migrations/027_assistants.sql")
            .split(';')
            .filter(|v| !v.trim().is_empty())
        {
            query(statement).execute(&pool).await.unwrap();
        }
        let first = save(
            &pool,
            AssistantDefinition {
                name: "Writer".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(!first.allow_notes && !first.allow_memory);
        let next = save(&pool, first.clone()).await.unwrap();
        assert_eq!(next.revision, 2);
        assert_eq!(
            save(&pool, first).await.unwrap_err().code,
            "assistant_conflict"
        );
        assert!(save(
            &pool,
            AssistantDefinition {
                name: "Bad".into(),
                tools: vec!["terminal".into()],
                ..Default::default()
            }
        )
        .await
        .is_err());
        let foreign = save(
            &pool,
            AssistantDefinition {
                name: "Other".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let reference = uuid::Uuid::new_v4().to_string();
        query("INSERT INTO assistant_references(id,assistant_id,name,format,status,created_at,updated_at) VALUES(?,?,'Image','png','ready','now','now')").bind(&reference).bind(&foreign.id).execute(&pool).await.unwrap();
        let mut malicious = next.clone();
        malicious.avatar_ref = Some(reference);
        assert_eq!(
            save(&pool, malicious).await.unwrap_err().code,
            "assistant_image_invalid"
        );
    }
}
