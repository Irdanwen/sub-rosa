//! How the Studio gallery is organised: collections (the gallery's folders),
//! favourites and hidden items (ADR-0073).
//!
//! Kept apart from `studio_artifact_metadata`, which records what produced a
//! file and stays on the device. These two tables travel with the account
//! (`account::sync`'s registry), so a folder made on the phone is there on the
//! Mac. Both are keyed by UUIDs, which is what the sync service accepts: a
//! collection gets a fresh one, and a mark's id is derived from the UUID stem
//! of the gallery file name, the same on every device the file reaches. Never
//! the stem itself: the file's own synchronised record (`account_studio_files`)
//! already travels under that id with the same routing kind, and the outbox
//! keeps one unsent row per object, so a mark would have overwritten the
//! file's record on its way out, or the other way round.

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
    /// The mark's own synchronised id, derived from `file_id`.
    pub id: String,
    /// The UUID stem of the gallery file this mark is about.
    pub file_id: String,
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
pub(crate) fn file_id(file: &str) -> Result<String, String> {
    let stem = file.rsplit_once('.').map_or(file, |(stem, _)| stem);
    uuid::Uuid::parse_str(stem)
        .map(|id| id.hyphenated().to_string())
        .map_err(|_| INVALID.to_owned())
}

/// The id a file's mark travels under: a name-based UUID of the file's own,
/// so every device derives the same one, and never the file's id itself.
pub(crate) fn mark_id(file_id: &str) -> String {
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!("subrosa:studio-mark:{file_id}").as_bytes(),
    )
    .hyphenated()
    .to_string()
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
    let marks = query("SELECT id, file_id, collection_id, favorite, hidden FROM studio_marks")
        .fetch_all(pool)
        .await
        .map_err(storage)?
        .into_iter()
        .map(|row| Mark {
            id: row.get("id"),
            file_id: row.get("file_id"),
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
        .map(|id| file_id(id))
        .collect::<Result<Vec<_>, _>>()?;
    // Whether this change says anything at all about a file that has no mark
    // yet. If not, there is nothing to create: a row made and emptied in one
    // go would leave as a tombstone for an object no device ever held.
    let says_something = request.favorite == Some(true)
        || request.hidden == Some(true)
        || matches!(request.collection_id, Some(Some(_)));
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
        let exists = query("SELECT 1 FROM studio_marks WHERE file_id = ?")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(storage)?
            .is_some();
        if !exists && !says_something {
            continue;
        }
        query("INSERT INTO studio_marks (id, file_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(file_id) DO NOTHING")
            .bind(mark_id(&id))
            .bind(&id)
            .bind(&now)
            .execute(&mut *tx)
            .await
            .map_err(storage)?;
        // One statement per change, so the sync trigger sees only real changes
        // (it compares old and new values column by column).
        if let Some(favorite) = request.favorite {
            query("UPDATE studio_marks SET favorite = ?, updated_at = ? WHERE file_id = ?")
                .bind(i64::from(favorite))
                .bind(&now)
                .bind(&id)
                .execute(&mut *tx)
                .await
                .map_err(storage)?;
        }
        if let Some(hidden) = request.hidden {
            query("UPDATE studio_marks SET hidden = ?, updated_at = ? WHERE file_id = ?")
                .bind(i64::from(hidden))
                .bind(&now)
                .bind(&id)
                .execute(&mut *tx)
                .await
                .map_err(storage)?;
        }
        if let Some(collection) = &request.collection_id {
            query("UPDATE studio_marks SET collection_id = ?, updated_at = ? WHERE file_id = ?")
                .bind(collection)
                .bind(&now)
                .bind(&id)
                .execute(&mut *tx)
                .await
                .map_err(storage)?;
        }
        // A mark that says nothing is not kept: it would travel for nothing.
        query("DELETE FROM studio_marks WHERE file_id = ? AND favorite = 0 AND hidden = 0 AND collection_id IS NULL")
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
/// whole gallery, keeping their favourite and hidden marks. A mark left with
/// nothing to say is removed, and only those: an unrelated empty mark would
/// be a bug elsewhere, not this call's to tidy.
pub(crate) async fn delete_collection(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(id)
        .map_err(|_| INVALID.to_owned())?
        .hyphenated()
        .to_string();
    let mut tx = pool.begin().await.map_err(storage)?;
    let now = Utc::now().to_rfc3339();
    let emptied: Vec<String> = query(
        "SELECT file_id FROM studio_marks WHERE collection_id = ? AND favorite = 0 AND hidden = 0",
    )
    .bind(&id)
    .fetch_all(&mut *tx)
    .await
    .map_err(storage)?
    .into_iter()
    .map(|row| row.get("file_id"))
    .collect();
    query("UPDATE studio_marks SET collection_id = NULL, updated_at = ? WHERE collection_id = ?")
        .bind(&now)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(storage)?;
    for file in emptied {
        query("DELETE FROM studio_marks WHERE file_id = ?")
            .bind(file)
            .execute(&mut *tx)
            .await
            .map_err(storage)?;
    }
    query("DELETE FROM studio_collections WHERE id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(storage)?;
    tx.commit().await.map_err(storage)
}

/// A deleted gallery file takes its mark with it, and its synchronised entry:
/// removing `account_studio_files` is what tells the account's other devices
/// to remove their copy (a clean deletion is applied there, ADR-0072). Before
/// this, deleting on the phone left the file on the Mac for good.
///
/// Everything the file lane knows about it goes too: a pending upload (or the
/// lane would retry a file that is gone), its manifest (or this very device
/// would download its own file back, since a manifest with no upload row is
/// exactly what the download lane looks for), and any download of it.
pub(crate) async fn forget(app: &AppHandle, file: &str) {
    let Ok(id) = file_id(file) else { return };
    let Ok(pool) = pool(app).await else { return };
    if let Err(error) = forget_in(&pool, &id).await {
        eprintln!("studio library: could not forget a deleted file: {error}");
    }
}

pub(crate) async fn forget_in(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(storage)?;
    for statement in [
        "DELETE FROM studio_marks WHERE file_id = ?",
        "DELETE FROM account_file_uploads WHERE artifact_id = ?",
        "DELETE FROM account_file_downloads WHERE manifest_id IN (SELECT id FROM account_file_manifests WHERE artifact_id = ?)",
        "DELETE FROM account_file_manifests WHERE artifact_id = ?",
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
    fn a_mark_is_known_by_the_uuid_stem_of_its_file_but_travels_under_its_own_id() {
        let stem = file_id(CLIP).unwrap();
        assert_eq!(stem, "0192f1a0-7c3e-7d4b-9a10-2f9f5b8e4c11");
        assert!(file_id("holiday.mp4").is_err());
        assert!(file_id("../0192f1a0-7c3e-7d4b-9a10-2f9f5b8e4c11.mp4").is_err());
        // Derived, stable, and never the file's own id.
        assert_eq!(mark_id(&stem), mark_id(&stem));
        assert_ne!(mark_id(&stem), stem);
        assert!(uuid::Uuid::parse_str(&mark_id(&stem)).is_ok());
    }

    #[tokio::test]
    async fn a_change_that_says_nothing_creates_no_mark() {
        let (_dir, pool) = open().await;
        mark(
            &pool,
            MarkRequest {
                ids: vec![CLIP.into()],
                favorite: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(list(&pool).await.unwrap().marks.is_empty());
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
                id: mark_id("0192f1a0-7c3e-7d4b-9a10-2f9f5b8e4c11"),
                file_id: "0192f1a0-7c3e-7d4b-9a10-2f9f5b8e4c11".into(),
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
