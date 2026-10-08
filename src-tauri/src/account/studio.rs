//! Completed Studio files join the encrypted file queue. Job execution remains
//! owned by the device that queued it; this module never calls an AI endpoint.
use super::*;
use std::path::Path;

pub(super) fn extension(raw: &str) -> Result<String, AppError> {
    let value = raw.trim_start_matches('.').to_ascii_lowercase();
    if !matches!(
        value.as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "webp"
            | "gif"
            | "mp4"
            | "webm"
            | "mov"
            | "mp3"
            | "wav"
            | "ogg"
            | "flac"
            | "m4a"
            | "aac"
            | "docx"
            | "xlsx"
            | "pptx"
    ) {
        return Err(error("sync_file_type_unsupported"));
    }
    Ok(value)
}
/// An Office file the assistant made (ADR-0090). It rides this lane like a
/// picture, but lives in the gallery's documents folder, so the Studio's
/// views (which list the top level) never show it as a broken picture.
pub(crate) fn is_document(extension: &str) -> bool {
    matches!(
        extension
            .trim_start_matches('.')
            .to_ascii_lowercase()
            .as_str(),
        "docx" | "xlsx" | "pptx"
    )
}
/// The gallery folder a file of this extension lives in. A record names a
/// file by its name alone; where it goes follows from what it is.
pub(crate) fn folder(gallery: &Path, extension: &str) -> std::path::PathBuf {
    if is_document(extension) {
        gallery.join(crate::deliverables::DOCUMENTS_DIR)
    } else {
        gallery.to_path_buf()
    }
}
/// Called after a writer finishes its atomic result. Errors are best effort:
/// the gallery inventory below recovers a file written just before a crash.
pub(crate) async fn completed(app: &AppHandle, path: &Path) {
    let Ok(pool) = pool(app).await else {
        return;
    };
    let Ok(gallery) = crate::carpe_diem::media::artifacts_dir(app) else {
        return;
    };
    if let Err(failure) = register(&pool, &gallery, path).await {
        tracing::debug!(code=%failure.code,"Studio file synchronization deferred");
    }
}
pub(super) async fn inventory(
    _app: &AppHandle,
    pool: &SqlitePool,
    gallery: &Path,
) -> Result<(), AppError> {
    // Avoid taking a snapshot of a file still being downloaded by Studio.
    if crate::carpe_diem::jobs::has_active() {
        return Ok(());
    }
    let mut remaining = 20;
    let mut oversized = false;
    let documents = folder(gallery, "docx");
    for dir in [gallery, documents.as_path()] {
        let mut entries = match tokio::fs::read_dir(dir).await {
            Ok(entries) => entries,
            // No document was ever made on this device.
            Err(_) if dir != gallery => continue,
            Err(_) => return Err(error("sync_file_unavailable")),
        };
        scan(pool, gallery, &mut entries, &mut remaining, &mut oversized).await?;
    }
    if oversized {
        return Err(error("sync_file_too_large"));
    }
    Ok(())
}
async fn scan(
    pool: &SqlitePool,
    gallery: &Path,
    entries: &mut tokio::fs::ReadDir,
    remaining: &mut usize,
    oversized: &mut bool,
) -> Result<(), AppError> {
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|_| error("sync_file_unavailable"))?
    {
        if *remaining == 0 {
            break;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        if !meta.is_file()
            || meta
                .modified()
                .ok()
                .and_then(|t| t.elapsed().ok())
                .map_or(true, |elapsed| elapsed < Duration::from_secs(60))
        {
            continue;
        }
        match register(pool, gallery, &entry.path()).await {
            Ok(true) => *remaining -= 1,
            Err(failure) if failure.code == "sync_file_too_large" => *oversized = true,
            _ => {}
        }
    }
    Ok(())
}
pub(super) async fn register(
    pool: &SqlitePool,
    gallery: &Path,
    path: &Path,
) -> Result<bool, AppError> {
    let bound: Option<String> = query("SELECT account_id FROM account_sync_control WHERE id=1")
        .fetch_one(pool)
        .await?
        .get("account_id");
    if bound.is_none() {
        return Ok(false);
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| error("sync_file_unavailable"))?;
    let root = gallery
        .canonicalize()
        .map_err(|_| error("sync_file_unavailable"))?;
    // In the folder its kind lives in, and nowhere else: another device puts
    // it back by its name alone.
    let home = folder(
        &root,
        path.extension()
            .and_then(|v| v.to_str())
            .unwrap_or_default(),
    );
    if !canonical.starts_with(&root) || canonical.parent() != Some(home.as_path()) {
        return Err(error("sync_file_unavailable"));
    }
    let id = path
        .file_stem()
        .and_then(|v| v.to_str())
        .ok_or_else(|| error("sync_file_unavailable"))?;
    uuid::Uuid::parse_str(id).map_err(|_| error("sync_file_unavailable"))?;
    let ext = extension(
        path.extension()
            .and_then(|v| v.to_str())
            .ok_or_else(|| error("sync_file_unavailable"))?,
    )?;
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| error("sync_file_unavailable"))?;
    let meta = tokio::fs::metadata(&canonical)
        .await
        .map_err(|_| error("sync_file_unavailable"))?;
    if meta.len() == 0 || meta.len() > 2 * 1024 * 1024 * 1024 {
        return Err(error("sync_file_too_large"));
    }
    let modified = meta
        .modified()
        .map_err(|_| error("sync_file_unavailable"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| error("sync_file_unavailable"))?
        .as_nanos()
        .to_string();
    let mut tx = pool.begin().await?;
    if query("SELECT 1 FROM account_file_manifests WHERE artifact_id=? UNION SELECT 1 FROM account_file_uploads WHERE artifact_id=? LIMIT 1").bind(id).bind(id).fetch_optional(&mut *tx).await?.is_some(){return Ok(false);}
    let job=query("SELECT model,prompt,created_at FROM media_jobs WHERE artifact_file_name=? AND status='completed' LIMIT 1").bind(name).fetch_optional(&mut *tx).await?;
    let created = job
        .as_ref()
        .map(|r| r.get::<String, _>("created_at"))
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    query("INSERT OR IGNORE INTO account_studio_files(id,file_name,format,bytes,created_at,model,prompt) VALUES(?,?,?,?,?,?,?)").bind(id).bind(name).bind(&ext).bind(meta.len()as i64).bind(created).bind(job.as_ref().map(|r|r.get::<String,_>("model"))).bind(job.as_ref().map(|r|r.get::<String,_>("prompt"))).execute(&mut *tx).await?;
    // Gallery paths are relative file names. iOS moves its data container on
    // reinstall, so the current root is resolved afresh before every upload.
    query("INSERT OR IGNORE INTO account_file_uploads(artifact_id,manifest_id,bytes,modified,source_kind,source_path,source_format) VALUES(?,?,?,?,'studio',?,?)").bind(id).bind(uuid::Uuid::new_v4().to_string()).bind(meta.len()as i64).bind(modified).bind(name).bind(ext).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(true)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn office_files_live_in_the_documents_folder() {
        let gallery = Path::new("/gallery");
        assert_eq!(folder(gallery, "docx"), gallery.join("documents"));
        assert_eq!(folder(gallery, ".PPTX"), gallery.join("documents"));
        assert_eq!(folder(gallery, "png"), gallery.to_path_buf());
        assert_eq!(extension("xlsx").unwrap(), "xlsx");
    }
    async fn bound_pool() -> SqlitePool {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::run_migrations(&pool).await.unwrap();
        query("UPDATE account_sync_control SET account_id='acct' WHERE id=1")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }
    /// A document `make_document` saved is queued like a gallery picture: a
    /// synchronised record and an upload row naming the file alone, which
    /// the other device puts back in its documents folder by its extension.
    #[tokio::test]
    async fn a_document_in_the_documents_folder_is_queued_for_upload() {
        let pool = bound_pool().await;
        let gallery = tempfile::tempdir().unwrap();
        let documents = gallery.path().join("documents");
        std::fs::create_dir_all(&documents).unwrap();
        let name = "0b7c1d2e-1111-4222-8333-444455556666.xlsx";
        std::fs::write(documents.join(name), b"PK workbook").unwrap();
        assert!(register(&pool, gallery.path(), &documents.join(name))
            .await
            .unwrap());
        let record = query("SELECT file_name,format,bytes FROM account_studio_files WHERE id=?")
            .bind("0b7c1d2e-1111-4222-8333-444455556666")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(record.get::<String, _>("file_name"), name);
        assert_eq!(record.get::<String, _>("format"), "xlsx");
        let upload = query("SELECT source_kind,source_path,source_format,bytes FROM account_file_uploads WHERE artifact_id=?")
            .bind("0b7c1d2e-1111-4222-8333-444455556666")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(upload.get::<String, _>("source_kind"), "studio");
        assert_eq!(upload.get::<String, _>("source_path"), name);
        assert_eq!(upload.get::<String, _>("source_format"), "xlsx");
        assert_eq!(upload.get::<i64, _>("bytes"), 11);
        // The record leaves for the account's other devices.
        let outgoing = query("SELECT kind,body FROM account_sync_outbox WHERE object_id=?")
            .bind("0b7c1d2e-1111-4222-8333-444455556666")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].get::<String, _>("kind"), "artifact");
        let body: serde_json::Value =
            serde_json::from_str(&outgoing[0].get::<String, _>("body")).unwrap();
        assert_eq!(body["table"], "account_studio_files");
        assert_eq!(body["row"]["format"], "xlsx");
        // Registered once.
        assert!(!register(&pool, gallery.path(), &documents.join(name))
            .await
            .unwrap());
    }
    #[tokio::test]
    async fn a_file_outside_the_folder_of_its_kind_is_not_queued() {
        let pool = bound_pool().await;
        let gallery = tempfile::tempdir().unwrap();
        let documents = gallery.path().join("documents");
        std::fs::create_dir_all(&documents).unwrap();
        let stray_doc = gallery
            .path()
            .join("0b7c1d2e-1111-4222-8333-444455556666.docx");
        std::fs::write(&stray_doc, b"PK").unwrap();
        assert!(register(&pool, gallery.path(), &stray_doc).await.is_err());
        let stray_png = documents.join("0b7c1d2e-1111-4222-8333-444455556667.png");
        std::fs::write(&stray_png, b"png").unwrap();
        assert!(register(&pool, gallery.path(), &stray_png).await.is_err());
    }
    #[tokio::test]
    async fn the_inventory_finds_documents_made_before_sync_was_on() {
        let pool = bound_pool().await;
        let gallery = tempfile::tempdir().unwrap();
        let documents = gallery.path().join("documents");
        std::fs::create_dir_all(&documents).unwrap();
        let name = documents.join("0b7c1d2e-1111-4222-8333-444455556666.pptx");
        std::fs::write(&name, b"PK deck").unwrap();
        // Older than the minute the inventory leaves a file being written.
        let old = std::time::SystemTime::now() - Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(&name)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let mut remaining = 20;
        let mut oversized = false;
        let mut entries = tokio::fs::read_dir(&documents).await.unwrap();
        scan(
            &pool,
            gallery.path(),
            &mut entries,
            &mut remaining,
            &mut oversized,
        )
        .await
        .unwrap();
        assert_eq!(remaining, 19);
        let queued: i64 =
            query("SELECT count(*) AS n FROM account_file_uploads WHERE source_format='pptx'")
                .fetch_one(&pool)
                .await
                .unwrap()
                .get("n");
        assert_eq!(queued, 1);
    }
    #[test]
    fn gallery_extensions_cannot_execute_or_escape() {
        assert_eq!(extension(".MP4").unwrap(), "mp4");
        for bad in ["html", "svg", "sh", "../png", "png/../../x"] {
            assert!(extension(bad).is_err());
        }
    }
}
