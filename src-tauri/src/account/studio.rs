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
    ) {
        return Err(error("sync_file_type_unsupported"));
    }
    Ok(value)
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
    let mut entries = tokio::fs::read_dir(gallery)
        .await
        .map_err(|_| error("sync_file_unavailable"))?;
    let mut remaining = 20;
    let mut oversized = false;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|_| error("sync_file_unavailable"))?
    {
        if remaining == 0 {
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
            Ok(true) => remaining -= 1,
            Err(failure) if failure.code == "sync_file_too_large" => oversized = true,
            _ => {}
        }
    }
    if oversized {
        return Err(error("sync_file_too_large"));
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
    if !canonical.starts_with(
        gallery
            .canonicalize()
            .map_err(|_| error("sync_file_unavailable"))?,
    ) {
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
    fn gallery_extensions_cannot_execute_or_escape() {
        assert_eq!(extension(".MP4").unwrap(), "mp4");
        for bad in ["html", "svg", "sh", "../png", "png/../../x"] {
            assert!(extension(bad).is_err());
        }
    }
}
