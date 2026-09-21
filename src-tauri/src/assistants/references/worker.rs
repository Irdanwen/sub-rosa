//! Bounded extraction sweeps advance past metadata whose files have not arrived.
use super::*;
use std::sync::OnceLock;

const MAX_SCAN: usize = 256;
const MAX_EXTRACT: usize = 8;
static EXTRACTION: OnceLock<tokio::sync::Mutex<String>> = OnceLock::new();

pub async fn resume_unfinished(app: &AppHandle) {
    let mut cursor = EXTRACTION
        .get_or_init(|| tokio::sync::Mutex::new(String::new()))
        .lock()
        .await;
    let _background = crate::ios_background::BackgroundTask::begin("assistant-references");
    let Ok(pool) = pool(app).await else {
        return;
    };
    let Ok(root) = references_dir(app) else {
        return;
    };
    let _ = resume_batch(&pool, &root, &mut cursor).await;
}

async fn resume_batch(pool: &SqlitePool, root: &Path, cursor: &mut String) -> Result<(), AppError> {
    let mut scanned = 0;
    let mut extracted = 0;
    while scanned < MAX_SCAN && extracted < MAX_EXTRACT {
        let rows = query("SELECT * FROM assistant_references WHERE status='queued' AND id>? ORDER BY id LIMIT 32")
            .bind(cursor.as_str()).fetch_all(pool).await?;
        if rows.is_empty() {
            // Revisit earlier missing files on the next sweep. Retaining a
            // cursor at the scan budget also lets later local rows make progress.
            cursor.clear();
            break;
        }
        for row in rows {
            if scanned >= MAX_SCAN || extracted >= MAX_EXTRACT {
                break;
            }
            let reference = decode(row);
            *cursor = reference.id.clone();
            scanned += 1;
            let Some(name) = reference.file_name else {
                continue;
            };
            let Ok(path) = reference_file(root, &name) else {
                continue;
            };
            // Do not unlink an input while its extractor owns an open handle
            // (particularly on Windows). Import drops this lock before resuming.
            let _ownership = reference_lifecycle_lock().await;
            // Remote metadata often precedes authenticated file chunks.
            if !path.is_file() {
                continue;
            }
            extracted += 1;
            let format = reference.format;
            let outcome = tokio::task::spawn_blocking(move || extract(&path, &format)).await;
            let (status, text, err) = match outcome {
                Ok(Ok(text)) => ("ready", text, None),
                Ok(Err(err)) => ("failed", String::new(), Some(err.message)),
                Err(_) => (
                    "failed",
                    String::new(),
                    Some(error("assistant_reference_invalid").message),
                ),
            };
            query("UPDATE assistant_references SET status=?,text=?,error=?,updated_at=? WHERE id=? AND status='queued'")
                .bind(status).bind(text).bind(err).bind(chrono::Utc::now().to_rfc3339()).bind(reference.id).execute(pool).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn missing_remote_files_never_starve_local_extraction() {
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
        let directory = tempfile::tempdir().unwrap();
        // More missing rows than one bounded sweep can visit.
        for index in 0..=MAX_SCAN {
            query("INSERT INTO assistant_references(id,assistant_id,name,format,file_name,created_at,updated_at) VALUES(?,?,'Pending','txt',?,'now','now')")
                .bind(format!("remote-{index:04}"))
                .bind(&assistant.id)
                .bind(format!("{}.txt",uuid::Uuid::new_v4()))
                .execute(&pool).await.unwrap();
        }
        let name = format!("{}.txt", uuid::Uuid::new_v4());
        std::fs::write(directory.path().join(&name), "Local document").unwrap();
        query("INSERT INTO assistant_references(id,assistant_id,name,format,file_name,created_at,updated_at) VALUES('z-local',?,'Local','txt',?,'now','now')")
            .bind(&assistant.id).bind(&name).execute(&pool).await.unwrap();
        let mut cursor = String::new();
        resume_batch(&pool, directory.path(), &mut cursor)
            .await
            .unwrap();
        assert_eq!(get(&pool, "z-local").await.unwrap().status, "queued");
        assert!(!cursor.is_empty());
        resume_batch(&pool, directory.path(), &mut cursor)
            .await
            .unwrap();
        assert_eq!(get(&pool, "z-local").await.unwrap().text, "Local document");
        // A formerly missing file is reconsidered after the cursor wraps.
        let remote = get(&pool, "remote-0000").await.unwrap();
        std::fs::write(
            directory.path().join(remote.file_name.unwrap()),
            "Arrived later",
        )
        .unwrap();
        resume_batch(&pool, directory.path(), &mut cursor)
            .await
            .unwrap();
        assert_eq!(
            get(&pool, "remote-0000").await.unwrap().text,
            "Arrived later"
        );
    }
}
