//! Local Studio documents. Media bytes remain in the gallery and are referenced by id.
//! Revision checks are atomic so another window cannot silently overwrite an edit.
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{query::query, row::Row};
use sqlx_sqlite::{SqlitePool, SqliteRow};
use std::collections::HashSet;
use tauri::AppHandle;

const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_GENERATION_BYTES: usize = 256 * 1024;
const MAX_REVISION: i64 = 9_007_199_254_740_990;
const CONFLICT: &str = "studio_project_conflict";
const INVALID_DOCUMENT: &str = "studio_project_invalid_document";
const INVALID_ID: &str = "studio_project_invalid_id";
const STORAGE_ERROR: &str = "studio_project_storage_error";

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub archived: bool,
    pub revision: i64,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    #[serde(flatten)]
    pub summary: ProjectSummary,
    pub document: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProjectRequest {
    pub id: String,
    pub name: String,
    pub archived: bool,
    pub expected_revision: Option<i64>,
    pub document: Value,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactMetadata {
    pub id: String,
    pub title: String,
    pub project_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveArtifactRequest {
    pub id: String,
    pub title: Option<String>,
    pub project_ids: Option<Vec<String>>,
    pub generation: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeArtifactRequest {
    pub id: String,
    pub title: String,
    pub project_ids: Vec<String>,
    pub expected_project_ids: Vec<String>,
}

fn storage_error(error: impl std::fmt::Display) -> String {
    tracing::error!("Studio persistence: {error}");
    STORAGE_ERROR.into()
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 256
        || id.trim() != id
        || id.chars().any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err(INVALID_ID.into());
    }
    Ok(())
}

fn bounded_json(value: &Value, limit: usize) -> Result<String, String> {
    let json = serde_json::to_string(value).map_err(storage_error)?;
    if json.len() > limit {
        return Err(INVALID_DOCUMENT.into());
    }
    Ok(json)
}

fn summary(row: &SqliteRow) -> Result<ProjectSummary, String> {
    Ok(ProjectSummary {
        id: row.try_get("id").map_err(storage_error)?,
        name: row.try_get("name").map_err(storage_error)?,
        archived: row.try_get("archived").map_err(storage_error)?,
        revision: row.try_get("revision").map_err(storage_error)?,
        updated_at: row.try_get("updated_at").map_err(storage_error)?,
    })
}

fn record(row: &SqliteRow) -> Result<ProjectRecord, String> {
    let json: String = row.try_get("document").map_err(storage_error)?;
    Ok(ProjectRecord {
        summary: summary(row)?,
        document: serde_json::from_str(&json).map_err(storage_error)?,
    })
}

async fn pool(app: &AppHandle) -> Result<SqlitePool, String> {
    crate::commands::repositories(app)
        .await
        .map(|repos| repos.pool)
        .map_err(|_| STORAGE_ERROR.into())
}

async fn list_projects(pool: &SqlitePool) -> Result<Vec<ProjectSummary>, String> {
    query("SELECT id, name, archived, revision, updated_at FROM studio_projects ORDER BY updated_at DESC, id")
        .fetch_all(pool)
        .await
        .map_err(storage_error)?
        .iter()
        .map(summary)
        .collect()
}

async fn get_project(pool: &SqlitePool, id: &str) -> Result<Option<ProjectRecord>, String> {
    validate_id(id)?;
    query("SELECT * FROM studio_projects WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(storage_error)?
        .as_ref()
        .map(record)
        .transpose()
}

async fn save_project(
    pool: &SqlitePool,
    request: SaveProjectRequest,
) -> Result<ProjectRecord, String> {
    validate_id(&request.id)?;
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 200 || name.chars().any(char::is_control) {
        return Err("studio_project_invalid_name".into());
    }
    if request
        .document
        .get("schemaVersion")
        .and_then(Value::as_u64)
        != Some(1)
    {
        return Err(INVALID_DOCUMENT.into());
    }
    let document = bounded_json(&request.document, MAX_DOCUMENT_BYTES)?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let row = if let Some(revision) = request.expected_revision {
        if !(1..MAX_REVISION).contains(&revision) {
            return Err(CONFLICT.into());
        }
        query("UPDATE studio_projects SET name = ?, archived = ?, revision = revision + 1, updated_at = ?, document = ? WHERE id = ? AND revision = ? RETURNING *")
            .bind(name).bind(request.archived).bind(now).bind(document)
            .bind(request.id).bind(revision)
            .fetch_optional(pool).await.map_err(storage_error)?
    } else {
        let artifact_ids = match request.document.get("artifactIds") {
            None => vec![],
            Some(Value::Array(ids)) => ids
                .iter()
                .map(|id| {
                    let id = id.as_str().ok_or(INVALID_DOCUMENT)?;
                    validate_id(id)?;
                    Ok(id.to_owned())
                })
                .collect::<Result<Vec<_>, String>>()?,
            _ => return Err(INVALID_DOCUMENT.into()),
        };
        let mut tx = pool.begin().await.map_err(storage_error)?;
        let row = query("INSERT INTO studio_projects (id, name, archived, revision, updated_at, document) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING *")
            .bind(&request.id).bind(name).bind(request.archived).bind(now).bind(document)
            .fetch_optional(&mut *tx).await.map_err(storage_error)?.ok_or(CONFLICT)?;
        for artifact_id in artifact_ids {
            let existing = query("SELECT project_ids FROM studio_artifact_metadata WHERE id = ?")
                .bind(&artifact_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(storage_error)?;
            let mut ids: Vec<String> = existing
                .as_ref()
                .map(|row| {
                    row.try_get::<String, _>("project_ids")
                        .map_err(storage_error)
                })
                .transpose()?
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(storage_error)?
                .unwrap_or_default();
            if !ids.contains(&request.id) {
                ids.push(request.id.clone());
            }
            ids.sort();
            ids.dedup();
            if ids.len() > 100 {
                return Err(INVALID_DOCUMENT.into());
            }
            let json = serde_json::to_string(&ids).map_err(storage_error)?;
            query("INSERT INTO studio_artifact_metadata (id, title, project_ids) VALUES (?, '', ?) ON CONFLICT(id) DO UPDATE SET project_ids = excluded.project_ids")
                .bind(&artifact_id)
                .bind(json)
                .execute(&mut *tx)
                .await
                .map_err(storage_error)?;
        }
        tx.commit().await.map_err(storage_error)?;
        Some(row)
    };
    record(&row.ok_or(CONFLICT)?)
}

fn artifact_metadata(row: &SqliteRow) -> Result<ArtifactMetadata, String> {
    let ids: String = row.try_get("project_ids").map_err(storage_error)?;
    let generation: Option<String> = row.try_get("generation").map_err(storage_error)?;
    Ok(ArtifactMetadata {
        id: row.try_get("id").map_err(storage_error)?,
        title: row.try_get("title").map_err(storage_error)?,
        project_ids: serde_json::from_str(&ids).map_err(storage_error)?,
        generation: generation
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(storage_error)?,
    })
}

async fn list_artifacts(pool: &SqlitePool) -> Result<Vec<ArtifactMetadata>, String> {
    query("SELECT id, title, project_ids, generation FROM studio_artifact_metadata ORDER BY id")
        .fetch_all(pool)
        .await
        .map_err(storage_error)?
        .iter()
        .map(artifact_metadata)
        .collect()
}

async fn save_artifact(
    pool: &SqlitePool,
    mut request: SaveArtifactRequest,
) -> Result<ArtifactMetadata, String> {
    validate_id(&request.id)?;
    if let Some(title) = &mut request.title {
        *title = title.trim().into();
        if title.chars().count() > 500 || title.chars().any(char::is_control) {
            return Err("studio_project_invalid_name".into());
        }
    }
    if let Some(ids) = &mut request.project_ids {
        if ids.len() > 100 {
            return Err(INVALID_DOCUMENT.into());
        }
        for id in ids.iter() {
            validate_id(id)?;
        }
        ids.sort();
        ids.dedup();
    }
    let ids = request
        .project_ids
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(storage_error)?;
    // A gallery path is transient on iOS and never a persisted identity.
    if let Some(Value::Object(generation)) = &mut request.generation {
        generation.remove("path");
    }
    let generation = request
        .generation
        .as_ref()
        .map(|value| bounded_json(value, MAX_GENERATION_BYTES))
        .transpose()?;
    // Observing a completed job may refresh provenance without changing the
    // title and memberships the person already edited in another window.
    let row = query("INSERT INTO studio_artifact_metadata (id, title, project_ids, generation) VALUES (?, COALESCE(?, ''), COALESCE(?, '[]'), ?) ON CONFLICT(id) DO UPDATE SET title = COALESCE(?, studio_artifact_metadata.title), project_ids = COALESCE(?, studio_artifact_metadata.project_ids), generation = COALESCE(excluded.generation, studio_artifact_metadata.generation) RETURNING *")
        .bind(&request.id).bind(&request.title).bind(&ids).bind(generation)
        .bind(&request.title).bind(&ids)
        .fetch_one(pool).await.map_err(storage_error)?;
    artifact_metadata(&row)
}

/// Keep the gallery's membership index and every project document in one
/// transaction. A failed write leaves both representations unchanged.
async fn organize_artifact(
    pool: &SqlitePool,
    mut request: OrganizeArtifactRequest,
) -> Result<ArtifactMetadata, String> {
    validate_id(&request.id)?;
    request.title = request.title.trim().into();
    if request.title.chars().count() > 500 || request.title.chars().any(char::is_control) {
        return Err("studio_project_invalid_name".into());
    }
    if request.project_ids.len() > 100 {
        return Err(INVALID_DOCUMENT.into());
    }
    for id in &request.project_ids {
        validate_id(id)?;
    }
    request.project_ids.sort();
    request.project_ids.dedup();
    if request.expected_project_ids.len() > 100 {
        return Err(INVALID_DOCUMENT.into());
    }
    for id in &request.expected_project_ids {
        validate_id(id)?;
    }
    request.expected_project_ids.sort();
    request.expected_project_ids.dedup();
    let wanted: HashSet<&str> = request.project_ids.iter().map(String::as_str).collect();
    let ids = serde_json::to_string(&request.project_ids).map_err(storage_error)?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut tx = pool.begin().await.map_err(storage_error)?;
    let projects = query("SELECT id, revision, document FROM studio_projects ORDER BY id")
        .fetch_all(&mut *tx)
        .await
        .map_err(storage_error)?;
    let stored: Option<String> =
        query("SELECT project_ids FROM studio_artifact_metadata WHERE id = ?")
            .bind(&request.id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(storage_error)?
            .map(|row| row.try_get("project_ids").map_err(storage_error))
            .transpose()?;
    let mut actual: HashSet<String> = stored
        .as_deref()
        .map(serde_json::from_str::<Vec<String>>)
        .transpose()
        .map_err(storage_error)?
        .unwrap_or_default()
        .into_iter()
        .collect();
    for row in &projects {
        let project_id: String = row.try_get("id").map_err(storage_error)?;
        let source: String = row.try_get("document").map_err(storage_error)?;
        let document: Value = serde_json::from_str(&source).map_err(storage_error)?;
        if document["artifactIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(&request.id)))
        {
            actual.insert(project_id);
        }
    }
    if actual != request.expected_project_ids.iter().cloned().collect() {
        return Err(CONFLICT.into());
    }
    for row in projects {
        let project_id: String = row.try_get("id").map_err(storage_error)?;
        let revision: i64 = row.try_get("revision").map_err(storage_error)?;
        if !(1..MAX_REVISION).contains(&revision) {
            return Err(CONFLICT.into());
        }
        let source: String = row.try_get("document").map_err(storage_error)?;
        let mut document: Value = serde_json::from_str(&source).map_err(storage_error)?;
        let object = document.as_object_mut().ok_or(INVALID_DOCUMENT)?;
        let artifacts = object
            .entry("artifactIds")
            .or_insert_with(|| Value::Array(vec![]));
        let array = artifacts.as_array_mut().ok_or(INVALID_DOCUMENT)?;
        let has = array
            .iter()
            .any(|value| value.as_str() == Some(&request.id));
        let include = wanted.contains(project_id.as_str());
        if has == include {
            continue;
        }
        if include {
            array.push(Value::String(request.id.clone()));
        } else {
            array.retain(|value| value.as_str() != Some(&request.id));
        }
        let json = bounded_json(&document, MAX_DOCUMENT_BYTES)?;
        let updated = query("UPDATE studio_projects SET revision = revision + 1, updated_at = ?, document = ? WHERE id = ? AND revision = ?")
            .bind(&now)
            .bind(json)
            .bind(&project_id)
            .bind(revision)
            .execute(&mut *tx)
            .await
            .map_err(storage_error)?;
        if updated.rows_affected() != 1 {
            return Err(CONFLICT.into());
        }
    }
    let row = query("INSERT INTO studio_artifact_metadata (id, title, project_ids) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, project_ids = excluded.project_ids RETURNING *")
        .bind(&request.id)
        .bind(&request.title)
        .bind(ids)
        .fetch_one(&mut *tx)
        .await
        .map_err(storage_error)?;
    let metadata = artifact_metadata(&row)?;
    tx.commit().await.map_err(storage_error)?;
    Ok(metadata)
}

#[tauri::command]
pub async fn studio_project_list(app: AppHandle) -> Result<Vec<ProjectSummary>, String> {
    list_projects(&pool(&app).await?).await
}

#[tauri::command]
pub async fn studio_project_get(
    app: AppHandle,
    id: String,
) -> Result<Option<ProjectRecord>, String> {
    get_project(&pool(&app).await?, &id).await
}

#[tauri::command]
pub async fn studio_project_save(
    app: AppHandle,
    request: SaveProjectRequest,
) -> Result<ProjectRecord, String> {
    save_project(&pool(&app).await?, request).await
}

#[tauri::command]
pub async fn studio_artifact_list(app: AppHandle) -> Result<Vec<ArtifactMetadata>, String> {
    list_artifacts(&pool(&app).await?).await
}

#[tauri::command]
pub async fn studio_artifact_save(
    app: AppHandle,
    request: SaveArtifactRequest,
) -> Result<ArtifactMetadata, String> {
    save_artifact(&pool(&app).await?, request).await
}

#[tauri::command]
pub async fn studio_artifact_organize(
    app: AppHandle,
    request: OrganizeArtifactRequest,
) -> Result<ArtifactMetadata, String> {
    organize_artifact(&pool(&app).await?, request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx_sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn open_database(path: &std::path::Path) -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(true),
            )
            .await
            .expect("database");
        for statement in crate::db::migrations::split_sql_statements(include_str!(
            "../migrations/032_studio_projects.sql"
        )) {
            query(&statement).execute(&pool).await.expect("migration");
        }
        pool
    }

    fn request(revision: Option<i64>, document: Value) -> SaveProjectRequest {
        SaveProjectRequest {
            id: "film-one".into(),
            name: " Concert ".into(),
            archived: false,
            expected_revision: revision,
            document,
        }
    }

    #[tokio::test]
    async fn restart_keeps_unknown_document_fields_and_provenance() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("studio.sqlite");
        let pool = open_database(&path).await;
        let document =
            json!({"schemaVersion":1,"shots":[{"id":"shot","futureField":{"nested":true}}]});
        let saved = save_project(&pool, request(None, document.clone()))
            .await
            .expect("create");
        assert_eq!(saved.summary.revision, 1);
        assert_eq!(saved.summary.name, "Concert");
        let metadata = save_artifact(
            &pool,
            SaveArtifactRequest {
                id: "artifact".into(),
                title: Some("Take 1".into()),
                project_ids: Some(vec!["film-one".into(), "film-one".into()]),
                generation: Some(
                    json!({"prompt":"concert", "model":"model", "sourceArtifactId":"reference"}),
                ),
            },
        )
        .await
        .expect("metadata");
        assert_eq!(metadata.project_ids.len(), 1);
        let observed = save_artifact(
            &pool,
            SaveArtifactRequest {
                id: "artifact".into(),
                title: None,
                project_ids: None,
                generation: None,
            },
        )
        .await
        .expect("observe");
        assert_eq!(observed, metadata);

        pool.close().await;
        // Reopening also replays the additive migration, without changing saved data.
        let pool = open_database(&path).await;
        assert_eq!(
            get_project(&pool, "film-one").await.expect("read"),
            Some(saved)
        );
        assert_eq!(
            list_artifacts(&pool).await.expect("artifacts"),
            vec![metadata]
        );
        let renamed = save_artifact(
            &pool,
            SaveArtifactRequest {
                id: "artifact".into(),
                title: Some("Final take".into()),
                project_ids: Some(vec![]),
                generation: None,
            },
        )
        .await
        .expect("rename");
        assert_eq!(renamed.generation.as_ref().unwrap()["prompt"], "concert");
        assert!(renamed.project_ids.is_empty());
        let refreshed = save_artifact(
            &pool,
            SaveArtifactRequest {
                id: "artifact".into(),
                title: None,
                project_ids: None,
                generation: Some(json!({"prompt":"updated provenance"})),
            },
        )
        .await
        .expect("refresh");
        assert_eq!(refreshed.title, "Final take");
        assert!(refreshed.project_ids.is_empty());
        let adopted = save_artifact(
            &pool,
            SaveArtifactRequest {
                id: "new-artifact".into(),
                title: None,
                project_ids: None,
                generation: None,
            },
        )
        .await
        .expect("adopt");
        assert_eq!(adopted.title, "");
        assert!(adopted.project_ids.is_empty());
    }

    #[tokio::test]
    async fn concurrent_edits_allow_one_writer_and_preserve_winner() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = open_database(&dir.path().join("studio.sqlite")).await;
        save_project(&pool, request(None, json!({"schemaVersion":1})))
            .await
            .expect("create");
        assert_eq!(
            save_project(&pool, request(None, json!({"schemaVersion":1})))
                .await
                .unwrap_err(),
            CONFLICT
        );
        let (a, b) = tokio::join!(
            save_project(
                &pool,
                request(Some(1), json!({"schemaVersion":1,"writer":"a"}))
            ),
            save_project(
                &pool,
                request(Some(1), json!({"schemaVersion":1,"writer":"b"}))
            )
        );
        let winner = match (a, b) {
            (Ok(saved), Err(error)) | (Err(error), Ok(saved)) => {
                assert_eq!(error, CONFLICT);
                saved
            }
            other => panic!("Expected one writer: {other:?}"),
        };
        assert_eq!(winner.summary.revision, 2);
        assert_eq!(get_project(&pool, "film-one").await.unwrap(), Some(winner));
        assert_eq!(
            save_project(&pool, request(Some(1), json!({"schemaVersion":1})))
                .await
                .unwrap_err(),
            CONFLICT
        );
    }

    #[tokio::test]
    async fn invalid_documents_cannot_replace_a_saved_project() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = open_database(&dir.path().join("studio.sqlite")).await;
        let saved = save_project(&pool, request(None, json!({"schemaVersion":1})))
            .await
            .unwrap();
        for document in [
            json!({}),
            json!({"schemaVersion":2}),
            json!({"schemaVersion":1,"huge":"x".repeat(MAX_DOCUMENT_BYTES)}),
        ] {
            assert_eq!(
                save_project(&pool, request(Some(1), document))
                    .await
                    .unwrap_err(),
                INVALID_DOCUMENT
            );
        }
        let mut invalid = request(Some(1), json!({"schemaVersion":1}));
        invalid.id = "../outside".into();
        assert_eq!(save_project(&pool, invalid).await.unwrap_err(), INVALID_ID);
        assert_eq!(get_project(&pool, "film-one").await.unwrap(), Some(saved));
        assert!(get_project(&pool, "missing").await.unwrap().is_none());
        assert_eq!(list_projects(&pool).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn organizing_updates_all_memberships_and_preserves_provenance() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = open_database(&dir.path().join("studio.sqlite")).await;
        save_project(
            &pool,
            request(None, json!({"schemaVersion":1,"artifactIds":["clip.mp4"]})),
        )
        .await
        .unwrap();
        let mut second = request(None, json!({"schemaVersion":1,"artifactIds":[]}));
        second.id = "film-two".into();
        save_project(&pool, second).await.unwrap();
        save_artifact(
            &pool,
            SaveArtifactRequest {
                id: "clip.mp4".into(),
                title: Some("Old title".into()),
                project_ids: Some(vec!["film-one".into()]),
                generation: Some(json!({"prompt":"A stage"})),
            },
        )
        .await
        .unwrap();

        let metadata = organize_artifact(
            &pool,
            OrganizeArtifactRequest {
                id: "clip.mp4".into(),
                title: "  New title  ".into(),
                project_ids: vec!["film-two".into(), "film-two".into()],
                expected_project_ids: vec!["film-one".into()],
            },
        )
        .await
        .unwrap();
        assert_eq!(metadata.title, "New title");
        assert_eq!(metadata.project_ids, vec!["film-two"]);
        assert_eq!(metadata.generation.unwrap()["prompt"], "A stage");
        assert_eq!(
            get_project(&pool, "film-one")
                .await
                .unwrap()
                .unwrap()
                .document["artifactIds"],
            json!([])
        );
        assert_eq!(
            get_project(&pool, "film-two")
                .await
                .unwrap()
                .unwrap()
                .document["artifactIds"],
            json!(["clip.mp4"])
        );
    }

    #[tokio::test]
    async fn stale_memberships_cannot_remove_a_new_attachment_during_a_rename() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = open_database(&dir.path().join("studio.sqlite")).await;
        save_project(
            &pool,
            request(None, json!({"schemaVersion":1,"artifactIds":["clip.mp4"]})),
        )
        .await
        .unwrap();
        let mut second = request(None, json!({"schemaVersion":1,"artifactIds":[]}));
        second.id = "film-two".into();
        save_project(&pool, second).await.unwrap();
        organize_artifact(
            &pool,
            OrganizeArtifactRequest {
                id: "clip.mp4".into(),
                title: "First title".into(),
                project_ids: vec!["film-one".into(), "film-two".into()],
                expected_project_ids: vec!["film-one".into()],
            },
        )
        .await
        .unwrap();
        save_artifact(
            &pool,
            SaveArtifactRequest {
                id: "clip.mp4".into(),
                title: Some("Renamed".into()),
                project_ids: None,
                generation: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            organize_artifact(
                &pool,
                OrganizeArtifactRequest {
                    id: "clip.mp4".into(),
                    title: "Stale rename".into(),
                    project_ids: vec!["film-one".into()],
                    expected_project_ids: vec!["film-one".into()],
                },
            )
            .await
            .unwrap_err(),
            CONFLICT
        );
        let metadata = list_artifacts(&pool).await.unwrap();
        assert_eq!(metadata[0].title, "Renamed");
        assert_eq!(metadata[0].project_ids, vec!["film-one", "film-two"]);
    }

    #[tokio::test]
    async fn creating_a_copy_registers_its_media_without_replacing_provenance() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = open_database(&dir.path().join("studio.sqlite")).await;
        save_artifact(
            &pool,
            SaveArtifactRequest {
                id: "clip.mp4".into(),
                title: Some("First take".into()),
                project_ids: Some(vec!["original".into()]),
                generation: Some(json!({"prompt":"A stage"})),
            },
        )
        .await
        .unwrap();
        save_project(
            &pool,
            request(
                None,
                json!({"schemaVersion":1,"artifactIds":["clip.mp4","still.png"]}),
            ),
        )
        .await
        .unwrap();
        let metadata = list_artifacts(&pool).await.unwrap();
        assert_eq!(metadata[0].title, "First take");
        assert_eq!(metadata[0].project_ids, vec!["film-one", "original"]);
        assert_eq!(
            metadata[0].generation.as_ref().unwrap()["prompt"],
            "A stage"
        );
        assert_eq!(metadata[1].project_ids, vec!["film-one"]);
    }

    #[tokio::test]
    async fn failed_membership_registration_rolls_back_project_creation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = open_database(&dir.path().join("studio.sqlite")).await;
        save_artifact(
            &pool,
            SaveArtifactRequest {
                id: "clip.mp4".into(),
                title: Some("First take".into()),
                project_ids: Some(vec!["original".into()]),
                generation: None,
            },
        )
        .await
        .unwrap();
        query("CREATE TRIGGER reject_membership BEFORE UPDATE ON studio_artifact_metadata WHEN NEW.id = 'clip.mp4' BEGIN SELECT RAISE(ABORT, 'blocked'); END")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            save_project(
                &pool,
                request(None, json!({"schemaVersion":1,"artifactIds":["clip.mp4"]})),
            )
            .await
            .unwrap_err(),
            STORAGE_ERROR
        );
        assert!(get_project(&pool, "film-one").await.unwrap().is_none());
        assert_eq!(
            list_artifacts(&pool).await.unwrap()[0].project_ids,
            vec!["original"]
        );
    }

    #[tokio::test]
    async fn organizing_rolls_back_all_project_updates_on_a_later_failure() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = open_database(&dir.path().join("studio.sqlite")).await;
        save_project(
            &pool,
            request(None, json!({"schemaVersion":1,"artifactIds":["clip.mp4"]})),
        )
        .await
        .unwrap();
        let mut second = request(None, json!({"schemaVersion":1,"artifactIds":[]}));
        second.id = "film-two".into();
        save_project(&pool, second).await.unwrap();
        save_artifact(
            &pool,
            SaveArtifactRequest {
                id: "clip.mp4".into(),
                title: Some("Old title".into()),
                project_ids: Some(vec!["film-one".into()]),
                generation: None,
            },
        )
        .await
        .unwrap();
        query("CREATE TRIGGER reject_second BEFORE UPDATE ON studio_projects WHEN NEW.id = 'film-two' BEGIN SELECT RAISE(ABORT, 'blocked'); END")
            .execute(&pool)
            .await
            .unwrap();

        assert_eq!(
            organize_artifact(
                &pool,
                OrganizeArtifactRequest {
                    id: "clip.mp4".into(),
                    title: "New title".into(),
                    project_ids: vec!["film-two".into()],
                    expected_project_ids: vec!["film-one".into()],
                },
            )
            .await
            .unwrap_err(),
            STORAGE_ERROR
        );
        assert_eq!(
            get_project(&pool, "film-one")
                .await
                .unwrap()
                .unwrap()
                .document["artifactIds"],
            json!(["clip.mp4"])
        );
        assert_eq!(
            get_project(&pool, "film-two")
                .await
                .unwrap()
                .unwrap()
                .document["artifactIds"],
            json!([])
        );
        let metadata = list_artifacts(&pool).await.unwrap();
        assert_eq!(metadata[0].title, "Old title");
        assert_eq!(metadata[0].project_ids, vec!["film-one"]);
    }
}
