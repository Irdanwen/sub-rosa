//! How the Studio gallery is organised: collections (the gallery's folders),
//! favourites and hidden items (ADR-0073).
//!
//! Kept apart from `studio_artifact_metadata`, which records what produced a
//! file and stays on the device. These two tables travel with the account
//! (`account::sync`'s registry), so a folder made on the phone is there on the
//! Mac. Both are keyed by UUIDs, which is what the sync service accepts: a
//! collection gets a fresh one, and a mark takes the UUID stem of the gallery
//! file name, the same on every device the file reaches.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{query::query, row::Row};
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;

const INVALID: &str = "studio_library_invalid";
const STORAGE: &str = "studio_library_storage_error";
const MAX_NAME_CHARS: usize = 80;
const MAX_BATCH: usize = 500;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    /// The UUID stem of the gallery file this mark is about.
    pub id: String,
    pub collection_id: Option<String>,
    pub favorite: bool,
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub collections: Vec<Collection>,
    pub marks: Vec<Mark>,
}

/// A change to some gallery files' marks. A field left out is left alone;
/// `collection_id: Some(None)` takes the files out of any collection.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkRequest {
    /// Gallery file names (or their stems).
    pub ids: Vec<String>,
    pub favorite: Option<bool>,
    pub hidden: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    pub collection_id: Option<Option<String>>,
}

/// Tells "not sent" (leave alone) from "sent as null" (clear).
fn present<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

fn storage<E: std::fmt::Display>(error: E) -> String {
    eprintln!("studio library: {error}");
    STORAGE.into()
}

/// The UUID a gallery file is known by everywhere: its stem. Anything else is
/// not a gallery file this app wrote.
pub(crate) fn mark_id(file: &str) -> Result<String, String> {
    let stem = file.rsplit_once('.').map_or(file, |(stem, _)| stem);
    uuid::Uuid::parse_str(stem)
        .map(|id| id.hyphenated().to_string())
        .map_err(|_| INVALID.to_owned())
}

fn collection_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty()
        || name.chars().count() > MAX_NAME_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(INVALID.into());
    }
    Ok(name.to_owned())
}

async fn pool(app: &AppHandle) -> Result<SqlitePool, String> {
    crate::commands::repositories(app)
        .await
        .map(|repos| repos.pool)
        .map_err(|_| STORAGE.to_owned())
}

pub(crate) async fn list(pool: &SqlitePool) -> Result<Library, String> {
    let collections = query(
        "SELECT id, name, created_at, updated_at FROM studio_collections ORDER BY name COLLATE NOCASE",
    )
    .fetch_all(pool)
    .await
    .map_err(storage)?
    .into_iter()
    .map(|row| Collection {
        id: row.get("id"),
        name: row.get("name"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
    .collect();
    let marks = query("SELECT id, collection_id, favorite, hidden FROM studio_marks")
        .fetch_all(pool)
        .await
        .map_err(storage)?
        .into_iter()
        .map(|row| Mark {
            id: row.get("id"),
            collection_id: row.get("collection_id"),
            favorite: row.get::<i64, _>("favorite") != 0,
            hidden: row.get::<i64, _>("hidden") != 0,
        })
        .collect();
    Ok(Library { collections, marks })
}

pub(crate) async fn mark(pool: &SqlitePool, request: MarkRequest) -> Result<(), String> {
    if request.ids.is_empty() || request.ids.len() > MAX_BATCH {
        return Err(INVALID.into());
    }
    let ids = request
        .ids
        .iter()
        .map(|id| mark_id(id))
        .collect::<Result<Vec<_>, _>>()?;
    let mut tx = pool.begin().await.map_err(storage)?;
    if let Some(Some(collection)) = &request.collection_id {
        let exists = query("SELECT 1 FROM studio_collections WHERE id = ?")
            .bind(collection)
            .fetch_optional(&mut *tx)
            .await
            .map_err(storage)?;
        if exists.is_none() {
            return Err(INVALID.into());
        }
    }
    let now = Utc::now().to_rfc3339();
    for id in ids {
        query("INSERT INTO studio_marks (id, updated_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
            .bind(&id)
            .bind(&now)
            .execute(&mut *tx)
            .await
            .map_err(storage)?;
        // One statement per change, so the sync trigger sees only real changes
        // (it compares old and new values column by column).
        if let Some(favorite) = request.favorite {
            query("UPDATE studio_marks SET favorite = ?, updated_at = ? WHERE id = ?")
                .bind(i64::from(favorite))
                .bind(&now)
                .bind(&id)
                .execute(&mut *tx)
                .await
                .map_err(storage)?;
        }
        if let Some(hidden) = request.hidden {
            query("UPDATE studio_marks SET hidden = ?, updated_at = ? WHERE id = ?")
                .bind(i64::from(hidden))
                .bind(&now)
                .bind(&id)
                .execute(&mut *tx)
                .await
                .map_err(storage)?;
        }
        if let Some(collection) = &request.collection_id {
            query("UPDATE studio_marks SET collection_id = ?, updated_at = ? WHERE id = ?")
                .bind(collection)
                .bind(&now)
                .bind(&id)
                .execute(&mut *tx)
                .await
                .map_err(storage)?;
        }
        // A mark that says nothing is not kept: it would travel for nothing.
        query("DELETE FROM studio_marks WHERE id = ? AND favorite = 0 AND hidden = 0 AND collection_id IS NULL")
            .bind(&id)
            .execute(&mut *tx)
            .await
            .map_err(storage)?;
    }
    tx.commit().await.map_err(storage)
}

pub(crate) async fn save_collection(
    pool: &SqlitePool,
    id: Option<String>,
    name: &str,
) -> Result<Collection, String> {
    let name = collection_name(name)?;
    let now = Utc::now().to_rfc3339();
    let id = match id {
        Some(id) => uuid::Uuid::parse_str(&id)
            .map_err(|_| INVALID.to_owned())?
            .hyphenated()
            .to_string(),
        None => uuid::Uuid::now_v7().hyphenated().to_string(),
    };
    query("INSERT INTO studio_collections (id, name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at")
        .bind(&id)
        .bind(&name)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await
        .map_err(storage)?;
    let row = query("SELECT id, name, created_at, updated_at FROM studio_collections WHERE id = ?")
        .bind(&id)
        .fetch_one(pool)
        .await
        .map_err(storage)?;
    Ok(Collection {
        id: row.get("id"),
        name: row.get("name"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

/// Deletes a collection, never what was in it: its files go back to the
/// whole gallery, keeping their favourite and hidden marks.
pub(crate) async fn delete_collection(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(storage)?;
    let now = Utc::now().to_rfc3339();
    query("UPDATE studio_marks SET collection_id = NULL, updated_at = ? WHERE collection_id = ?")
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(storage)?;
    query("DELETE FROM studio_marks WHERE favorite = 0 AND hidden = 0 AND collection_id IS NULL")
        .execute(&mut *tx)
        .await
        .map_err(storage)?;
    query("DELETE FROM studio_collections WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(storage)?;
    tx.commit().await.map_err(storage)
}

/// A deleted gallery file takes its mark with it, and its synchronised entry:
/// removing `account_studio_files` is what tells the account's other devices
/// to remove their copy (a clean deletion is applied there, ADR-0072). Before
/// this, deleting on the phone left the file on the Mac for good. A pending
/// upload of it is dropped too, or the file lane would retry a file that is
/// gone.
pub(crate) async fn forget(app: &AppHandle, file: &str) {
    let Ok(id) = mark_id(file) else { return };
    let Ok(pool) = pool(app).await else { return };
    if let Err(error) = forget_in(&pool, &id).await {
        eprintln!("studio library: could not forget a deleted file: {error}");
    }
}

async fn forget_in(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(storage)?;
    for statement in [
        "DELETE FROM studio_marks WHERE id = ?",
        "DELETE FROM account_file_uploads WHERE artifact_id = ?",
        "DELETE FROM account_studio_files WHERE id = ?",
    ] {
        query(statement)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(storage)?;
    }
    tx.commit().await.map_err(storage)
}

#[tauri::command]
pub async fn studio_library_list(app: AppHandle) -> Result<Library, String> {
    list(&pool(&app).await?).await
}

#[tauri::command]
pub async fn studio_library_mark(app: AppHandle, request: MarkRequest) -> Result<(), String> {
    mark(&pool(&app).await?, request).await
}

#[tauri::command]
pub async fn studio_collection_save(
    app: AppHandle,
    id: Option<String>,
    name: String,
) -> Result<Collection, String> {
    save_collection(&pool(&app).await?, id, &name).await
}

#[tauri::command]
pub async fn studio_collection_delete(app: AppHandle, id: String) -> Result<(), String> {
    delete_collection(&pool(&app).await?, &id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx_sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    const CLIP: &str = "0192f1a0-7c3e-7d4b-9a10-2f9f5b8e4c11.mp4";
    const STILL: &str = "0192f1a0-7c3e-7d4b-9a10-2f9f5b8e4c12.png";

    async fn open() -> (tempfile::TempDir, SqlitePool) {
        let dir = tempfile::tempdir().expect("dir");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(dir.path().join("library.sqlite"))
                    .create_if_missing(true),
            )
            .await
            .expect("database");
        for statement in crate::db::migrations::split_sql_statements(include_str!(
            "../migrations/039_studio_library.sql"
        )) {
            query(&statement).execute(&pool).await.expect("migration");
        }
        (dir, pool)
    }

    #[test]
    fn a_mark_is_known_by_the_uuid_stem_of_its_file() {
        assert_eq!(
            mark_id(CLIP).unwrap(),
            "0192f1a0-7c3e-7d4b-9a10-2f9f5b8e4c11"
        );
        assert!(mark_id("holiday.mp4").is_err());
        assert!(mark_id("../0192f1a0-7c3e-7d4b-9a10-2f9f5b8e4c11.mp4").is_err());
    }

    #[tokio::test]
    async fn marks_and_collections_round_trip_and_a_folder_never_takes_its_files() {
        let (_dir, pool) = open().await;
        let album = save_collection(&pool, None, "  Storyboard ").await.unwrap();
        assert_eq!(album.name, "Storyboard");
        mark(
            &pool,
            MarkRequest {
                ids: vec![CLIP.into(), STILL.into()],
                collection_id: Some(Some(album.id.clone())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mark(
            &pool,
            MarkRequest {
                ids: vec![CLIP.into()],
                favorite: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let library = list(&pool).await.unwrap();
        assert_eq!(library.collections.len(), 1);
        assert_eq!(library.marks.len(), 2);

        delete_collection(&pool, &album.id).await.unwrap();
        let library = list(&pool).await.unwrap();
        assert!(library.collections.is_empty());
        // The favourite keeps its mark; the still, now unmarked, is not kept.
        assert_eq!(
            library.marks,
            vec![Mark {
                id: "0192f1a0-7c3e-7d4b-9a10-2f9f5b8e4c11".into(),
                collection_id: None,
                favorite: true,
                hidden: false,
            }]
        );
    }

    #[tokio::test]
    async fn refuses_a_collection_that_does_not_exist_and_a_blank_name() {
        let (_dir, pool) = open().await;
        let missing = mark(
            &pool,
            MarkRequest {
                ids: vec![CLIP.into()],
                collection_id: Some(Some("0192f1a0-7c3e-7d4b-9a10-000000000000".into())),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(missing, Err(INVALID.into()));
        assert_eq!(
            save_collection(&pool, None, "   ").await,
            Err(INVALID.into())
        );
    }

    #[test]
    fn a_null_collection_clears_and_an_absent_one_leaves_alone() {
        let clear: MarkRequest =
            serde_json::from_value(serde_json::json!({ "ids": [CLIP], "collectionId": null }))
                .unwrap();
        assert_eq!(clear.collection_id, Some(None));
        let leave: MarkRequest =
            serde_json::from_value(serde_json::json!({ "ids": [CLIP], "hidden": true })).unwrap();
        assert_eq!(leave.collection_id, None);
    }
}
