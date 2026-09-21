//! A reference file belongs to live metadata or an immutable chat snapshot.
//! Serialize local snapshot capture/deletion and recheck owners under SQLite's
//! writer lock so sync cannot add an owner between the check and unlink.
use super::*;
use std::{collections::HashSet, sync::OnceLock};

static LIFECYCLE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
pub(crate) async fn reference_lifecycle_lock() -> tokio::sync::MutexGuard<'static, ()> {
    LIFECYCLE
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

async fn retained_on(
    connection: &mut sqlx_sqlite::SqliteConnection,
) -> Result<HashSet<String>, AppError> {
    let rows = query("SELECT file_name AS body,0 AS snapshot FROM assistant_references WHERE file_name IS NOT NULL UNION ALL SELECT snapshot_json AS body,1 AS snapshot FROM assistant_conversations")
        .fetch_all(connection).await?;
    let mut retained = HashSet::new();
    for row in rows {
        let body: String = row.get("body");
        if row.get::<bool, _>("snapshot") {
            let snapshot: crate::assistants::runtime::AssistantSnapshot =
                serde_json::from_str(&body).map_err(|_| error("assistant_snapshot_invalid"))?;
            retained.extend(
                snapshot
                    .references
                    .into_iter()
                    .filter_map(|reference| reference.file_name),
            );
        } else {
            retained.insert(body);
        }
    }
    Ok(retained)
}

/// Malformed snapshot metadata stops cleanup/export rather than guessing which
/// files a conversation still needs. The union is one consistent SQLite read.
pub async fn retained_reference_files(pool: &SqlitePool) -> Result<HashSet<String>, AppError> {
    retained_on(&mut *pool.acquire().await?).await
}

async fn remove_orphans(
    pool: &SqlitePool,
    root: &Path,
    names: Vec<String>,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    // A write statement reserves SQLite's writer even when it matches no row.
    // No trigger fires; external sync/import cannot race the ownership check.
    query("DELETE FROM assistant_references WHERE 0")
        .execute(&mut *tx)
        .await?;
    let retained = retained_on(&mut tx).await?;
    for name in names.into_iter().collect::<HashSet<_>>() {
        if retained.contains(&name) {
            continue;
        }
        let path = reference_file(root, &name)?;
        match tokio::fs::remove_file(path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(error("assistant_reference_unavailable")),
        }
    }
    tx.commit().await?;
    Ok(())
}

pub(super) async fn delete_reference(
    pool: &SqlitePool,
    root: &Path,
    id: &str,
) -> Result<(), AppError> {
    let _ownership = reference_lifecycle_lock().await;
    let mut tx = pool.begin().await?;
    query("UPDATE assistants SET avatar_ref=CASE WHEN avatar_ref=? THEN NULL ELSE avatar_ref END,cover_ref=CASE WHEN cover_ref=? THEN NULL ELSE cover_ref END,revision=revision+1,updated_at=? WHERE avatar_ref=? OR cover_ref=?")
        .bind(id).bind(id).bind(chrono::Utc::now().to_rfc3339()).bind(id).bind(id).execute(&mut *tx).await?;
    let rows = query("DELETE FROM assistant_references WHERE id=? RETURNING file_name")
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    remove_orphans(
        pool,
        root,
        rows.into_iter()
            .filter_map(|row| row.get("file_name"))
            .collect(),
    )
    .await
}

pub(crate) async fn delete_assistant(
    pool: &SqlitePool,
    root: &Path,
    id: &str,
    revision: i64,
) -> Result<(), AppError> {
    let _ownership = reference_lifecycle_lock().await;
    let mut tx = pool.begin().await?;
    // Reserve the writer before reading the cascading rows.
    query("DELETE FROM assistant_references WHERE 0")
        .execute(&mut *tx)
        .await?;
    let rows = query("SELECT file_name FROM assistant_references WHERE assistant_id=?")
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
    let result = query("DELETE FROM assistants WHERE id=? AND revision=?")
        .bind(id)
        .bind(revision)
        .execute(&mut *tx)
        .await?;
    if result.rows_affected() != 1 {
        return Err(error("assistant_conflict"));
    }
    tx.commit().await?;
    remove_orphans(
        pool,
        root,
        rows.into_iter()
            .filter_map(|row| row.get("file_name"))
            .collect(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn setup() -> (SqlitePool, tempfile::TempDir, AssistantDefinition) {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::run_migrations(&pool).await.unwrap();
        let assistant = save(
            &pool,
            AssistantDefinition {
                name: "Reader".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        (pool, tempfile::tempdir().unwrap(), assistant)
    }
    async fn reference(
        pool: &SqlitePool,
        root: &Path,
        assistant: &str,
        name: Option<&str>,
    ) -> AssistantReference {
        let id = uuid::Uuid::new_v4().to_string();
        let file = name
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{id}.txt"));
        std::fs::write(root.join(&file), "Private document").unwrap();
        query("INSERT INTO assistant_references(id,assistant_id,name,format,file_name,status,created_at,updated_at) VALUES(?,?,'Document','txt',?,'ready','now','now')")
            .bind(&id).bind(assistant).bind(file).execute(pool).await.unwrap();
        get(pool, &id).await.unwrap()
    }
    async fn conversation(
        pool: &SqlitePool,
        definition: &AssistantDefinition,
        references: Vec<AssistantReference>,
    ) {
        let task = uuid::Uuid::new_v4().to_string();
        query("INSERT INTO agent_tasks(id,title,prompt,status,safety_profile,created_at,updated_at) VALUES(?,'Chat','Hello','completed','custom_assistant','now','now')")
            .bind(&task).execute(pool).await.unwrap();
        let snapshot = crate::assistants::runtime::AssistantSnapshot {
            definition: definition.clone(),
            references,
        };
        query("INSERT INTO assistant_conversations(task_id,assistant_id,snapshot_json,created_at) VALUES(?,?,?,'now')")
            .bind(task).bind(&definition.id).bind(serde_json::to_string(&snapshot).unwrap()).execute(pool).await.unwrap();
    }
    #[tokio::test]
    async fn reference_and_profile_deletion_remove_only_unowned_files() {
        let (pool, root, assistant) = setup().await;
        let only = reference(&pool, root.path(), &assistant.id, None).await;
        let file = only.file_name.unwrap();
        delete_reference(&pool, root.path(), &only.id)
            .await
            .unwrap();
        assert!(!root.path().join(file).exists());

        let shared = reference(&pool, root.path(), &assistant.id, None).await;
        let other = save(
            &pool,
            AssistantDefinition {
                name: "Duplicate".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        reference(&pool, root.path(), &other.id, shared.file_name.as_deref()).await;
        delete_assistant(&pool, root.path(), &assistant.id, assistant.revision)
            .await
            .unwrap();
        let file = shared.file_name.unwrap();
        assert!(root.path().join(&file).exists());
        assert!(retained_reference_files(&pool)
            .await
            .unwrap()
            .contains(&file));
        assert!(
            delete_assistant(&pool, root.path(), &other.id, other.revision + 1)
                .await
                .is_err()
        );
        assert!(root.path().join(&file).exists());
        delete_assistant(&pool, root.path(), &other.id, other.revision)
            .await
            .unwrap();
        assert!(!root.path().join(file).exists());
    }
    #[tokio::test]
    async fn snapshot_capture_and_deletion_share_ownership_until_commit() {
        let (pool, root, assistant) = setup().await;
        let reference = reference(&pool, root.path(), &assistant.id, None).await;
        let file = reference.file_name.clone().unwrap();
        let capture = reference_lifecycle_lock().await;
        let deletion = {
            let pool = pool.clone();
            let root = root.path().to_owned();
            let id = reference.id.clone();
            tokio::spawn(async move { delete_reference(&pool, &root, &id).await })
        };
        tokio::task::yield_now().await;
        assert!(!deletion.is_finished());
        conversation(&pool, &assistant, vec![reference]).await;
        drop(capture);
        deletion.await.unwrap().unwrap();
        delete_assistant(&pool, root.path(), &assistant.id, assistant.revision)
            .await
            .unwrap();
        assert!(root.path().join(&file).exists());
        assert!(retained_reference_files(&pool)
            .await
            .unwrap()
            .contains(&file));
    }
    #[tokio::test]
    async fn malformed_snapshots_never_allow_cleanup_to_guess_ownership() {
        let (pool, root, assistant) = setup().await;
        let reference = reference(&pool, root.path(), &assistant.id, None).await;
        conversation(&pool, &assistant, vec![]).await;
        query("UPDATE assistant_conversations SET snapshot_json='{}'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(delete_reference(&pool, root.path(), &reference.id)
            .await
            .is_err());
        assert!(root.path().join(reference.file_name.unwrap()).exists());
        assert!(retained_reference_files(&pool).await.is_err());
    }
}
