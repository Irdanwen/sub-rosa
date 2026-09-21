//! Bounded encrypted audio transfers. Chunk ciphertext and its immutable UUID
//! are durable before upload, so retries after lost responses send identical
//! bytes. Downloads commit chunk offsets and rename only after all hashes pass.
use super::*;
use crate::app_paths::{app_data_dir, AppPaths};
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
const CHUNK_BYTES: usize = 1024 * 1024;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Chunk {
    id: String,
    bytes: u64,
    sha256: String,
}
fn file_error() -> AppError {
    error("sync_file_unavailable")
}
fn blob_aad(s: &Session, id: &str) -> String {
    format!("subrosa:blob:v1:{}:{id}", s.account.id)
}
fn digest(bytes: &[u8]) -> String {
    crypto::encode(&Sha256::digest(bytes))
}
fn modified(meta: &std::fs::Metadata) -> Result<String, AppError> {
    Ok(meta
        .modified()
        .map_err(|_| file_error())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| file_error())?
        .as_nanos()
        .to_string())
}
async fn blob(s: &Session, id: &str, bytes: Option<Vec<u8>>) -> Result<Vec<u8>, AppError> {
    uuid::Uuid::parse_str(id).map_err(|_| file_error())?;
    let client = crate::http_client::credentialed(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| error("account_network"))?;
    let started = Instant::now();
    let method_name = if bytes.is_some() { "PUT" } else { "GET" };
    let request_bytes = bytes.as_ref().map_or(0, |v| v.len() as u64);
    let req = client
        .request(
            if bytes.is_some() {
                reqwest::Method::PUT
            } else {
                reqwest::Method::GET
            },
            format!("{}/api/v1/blobs/{id}", s.base),
        )
        .bearer_auth(s.token.expose_str());
    let req = if let Some(bytes) = bytes {
        req.header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(bytes)
    } else {
        req
    };
    let mut response = req.send().await.map_err(|_| error("account_network"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(error("sync_blob_request_failed"));
    }
    let mut output = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| error("account_network"))?
    {
        if output.len() + chunk.len() > 2 * CHUNK_BYTES {
            return Err(error("sync_blob_invalid"));
        }
        output.extend_from_slice(&chunk);
    }
    crate::egress_ledger::record(crate::egress_ledger::EgressEntry {
        at: chrono::Utc::now().to_rfc3339(),
        host: reqwest::Url::parse(&s.base)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default(),
        purpose: "account synchronization".into(),
        method: method_name.into(),
        request_bytes,
        response_bytes: output.len() as u64,
        status: Some(status.as_u16()),
        duration_ms: started.elapsed().as_millis() as u64,
        model: None,
        note_id: None,
    });
    Ok(output)
}
pub(super) async fn step(
    app: &AppHandle,
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
) -> Result<(), AppError> {
    let root = app_data_dir(app).map_err(|_| file_error())?;
    let paths = AppPaths::from_data_dir(root.clone()).map_err(|_| file_error())?;
    query("DELETE FROM account_file_uploads WHERE source_kind='audio' AND NOT EXISTS(SELECT 1 FROM audio_artifacts a WHERE a.id=artifact_id)").execute(pool).await?;
    // Existing remote metadata has an empty path. A local valid artifact is an
    // immutable finalized recording, never the file currently being recorded.
    let rows=query("SELECT a.id,a.path FROM audio_artifacts a WHERE a.path<>'' AND a.status='valid' AND NOT EXISTS(SELECT 1 FROM account_file_uploads u WHERE u.artifact_id=a.id) AND NOT EXISTS(SELECT 1 FROM account_file_manifests m WHERE m.artifact_id=a.id) LIMIT 20").fetch_all(pool).await?;
    let mut oversized = false;
    for row in rows {
        let path: String = row.get("path");
        let Ok(path) = paths.contained_recording_file(&path) else {
            continue;
        };
        let meta = tokio::fs::metadata(&path).await.map_err(|_| file_error())?;
        if meta.len() > MAX_FILE_BYTES {
            oversized = true;
            continue;
        }
        if meta.len() == 0 {
            continue;
        }
        query("INSERT OR IGNORE INTO account_file_uploads(artifact_id,manifest_id,bytes,modified) VALUES(?,?,?,?)").bind(row.get::<String,_>("id")).bind(uuid::Uuid::new_v4().to_string()).bind(meta.len() as i64).bind(modified(&meta)?).execute(pool).await?;
    }
    // One bounded chunk in each direction per sweep. Durable rows retain the
    // remainder across an iOS suspension without trusting a JavaScript future.
    let gallery = crate::carpe_diem::media::artifacts_dir(app)?;
    let references = crate::assistants::references_dir(app)?;
    let candidates=query("WITH refs AS (SELECT id,file_name,format FROM assistant_references UNION SELECT json_extract(j.value,'$.id'),json_extract(j.value,'$.file_name'),json_extract(j.value,'$.format') FROM assistant_conversations c,json_each(c.snapshot_json,'$.references') j) SELECT id,file_name,format FROM refs r WHERE file_name IS NOT NULL AND NOT EXISTS(SELECT 1 FROM account_file_uploads u WHERE u.artifact_id=r.id) AND NOT EXISTS(SELECT 1 FROM account_file_manifests m WHERE m.artifact_id=r.id) LIMIT 20").fetch_all(pool).await?;
    for row in candidates {
        let name: String = row.get("file_name");
        let path = crate::assistants::reference_file(&references, &name)?;
        let Ok(meta) = tokio::fs::metadata(&path).await else {
            continue;
        };
        if meta.len() == 0 || meta.len() > 20 * 1024 * 1024 {
            continue;
        }
        query("INSERT OR IGNORE INTO account_file_uploads(artifact_id,manifest_id,bytes,modified,source_kind,source_path,source_format) VALUES(?,?,?,?,'assistant',?,?)")
            .bind(row.get::<String,_>("id")).bind(uuid::Uuid::new_v4().to_string()).bind(meta.len() as i64).bind(modified(&meta)?).bind(name).bind(row.get::<String,_>("format")).execute(pool).await?;
    }
    let inventory = super::studio::inventory(app, pool, &gallery).await;
    upload_one(pool, s, key, &paths, &gallery).await?;
    download_one(pool, s, key, &root, &gallery).await?;
    inventory?;
    if oversized {
        return Err(error("sync_file_too_large"));
    }
    Ok(())
}
pub(super) async fn upload_one(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    paths: &AppPaths,
    gallery: &std::path::Path,
) -> Result<(), AppError> {
    let Some(row)=query("SELECT u.*,COALESCE(a.path,u.source_path) AS path,COALESCE(a.format,u.source_format) AS format FROM account_file_uploads u LEFT JOIN audio_artifacts a ON a.id=u.artifact_id WHERE u.completed=0 AND (a.id IS NOT NULL OR u.source_kind IN ('studio','assistant')) ORDER BY u.rowid LIMIT 1").fetch_optional(pool).await? else{return Ok(());};
    let artifact: String = row.get("artifact_id");
    let source_kind: String = row.get("source_kind");
    let raw: String = row.get("path");
    let path = if source_kind == "assistant" {
        crate::assistants::reference_file(&paths.data_dir.join("assistant-references"), &raw)?
    } else if source_kind == "studio" {
        let file = std::path::Path::new(&raw);
        if file.components().count() != 1 {
            return Err(file_error());
        }
        let path = gallery
            .join(file)
            .canonicalize()
            .map_err(|_| file_error())?;
        if !path.starts_with(gallery.canonicalize().map_err(|_| file_error())?) {
            return Err(file_error());
        }
        path
    } else {
        paths
            .contained_recording_file(raw)
            .map_err(|_| file_error())?
    };
    let meta = tokio::fs::metadata(&path).await.map_err(|_| file_error())?;
    let total: i64 = row.get("bytes");
    let offset: i64 = row.get("next_offset");
    if total < 0
        || offset < 0
        || offset > total
        || meta.len() != total as u64
        || modified(&meta)? != row.get::<String, _>("modified")
    {
        return Err(error("sync_file_changed"));
    }
    let pending: Option<String> = row.get("pending_blob_id");
    let (id, ciphertext, size, hash) = if let Some(id) = pending {
        (
            id,
            row.get::<String, _>("pending_ciphertext"),
            row.get::<i64, _>("pending_bytes"),
            row.get::<String, _>("pending_digest"),
        )
    } else {
        let mut file = tokio::fs::File::open(&path)
            .await
            .map_err(|_| file_error())?;
        file.seek(std::io::SeekFrom::Start(offset as u64))
            .await
            .map_err(|_| file_error())?;
        let mut clear = Zeroizing::new(vec![0; CHUNK_BYTES.min((total - offset) as usize)]);
        file.read_exact(&mut clear)
            .await
            .map_err(|_| file_error())?;
        let id = uuid::Uuid::new_v4().to_string();
        let ciphertext = crypto::seal(key, &blob_aad(s, &id), &clear)?;
        let hash = digest(&clear);
        let size = clear.len() as i64;
        query("UPDATE account_file_uploads SET pending_blob_id=?,pending_ciphertext=?,pending_bytes=?,pending_digest=? WHERE artifact_id=?").bind(&id).bind(&ciphertext).bind(size).bind(&hash).bind(&artifact).execute(pool).await?;
        (id, ciphertext, size, hash)
    };
    blob(s, &id, Some(ciphertext.into_bytes())).await?;
    let mut chunks: Vec<Chunk> =
        serde_json::from_str(&row.get::<String, _>("chunks_json")).map_err(|_| file_error())?;
    chunks.push(Chunk {
        id,
        bytes: size as u64,
        sha256: hash,
    });
    let chunks_json = serde_json::to_string(&chunks).map_err(|_| file_error())?;
    let mut tx = pool.begin().await?;
    query("UPDATE account_file_uploads SET next_offset=?,chunks_json=?,pending_blob_id=NULL,pending_ciphertext=NULL,pending_bytes=NULL,pending_digest=NULL,completed=? WHERE artifact_id=?").bind(offset+size).bind(&chunks_json).bind(offset+size==total).bind(&artifact).execute(&mut *tx).await?;
    if offset + size == total {
        query("INSERT INTO account_file_manifests(id,artifact_id,bytes,format,chunks_json,created_at,source_kind) VALUES(?,?,?,?,?,?,?)").bind(row.get::<String,_>("manifest_id")).bind(&artifact).bind(total).bind(row.get::<String,_>("format")).bind(&chunks_json).bind(chrono::Utc::now().to_rfc3339()).bind(&source_kind).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
fn manifest_chunks(raw: &str, total: i64) -> Result<Vec<Chunk>, AppError> {
    if total <= 0 || total as u64 > MAX_FILE_BYTES {
        return Err(error("sync_blob_invalid"));
    }
    let chunks: Vec<Chunk> = serde_json::from_str(raw).map_err(|_| error("sync_blob_invalid"))?;
    if chunks.is_empty() || chunks.len() > 2048 {
        return Err(error("sync_blob_invalid"));
    }
    let mut ids = std::collections::HashSet::new();
    let mut bytes = 0_u64;
    for c in &chunks {
        if uuid::Uuid::parse_str(&c.id).is_err()
            || !ids.insert(&c.id)
            || c.bytes == 0
            || c.bytes > CHUNK_BYTES as u64
            || c.sha256.len() != 43
        {
            return Err(error("sync_blob_invalid"));
        }
        bytes = bytes
            .checked_add(c.bytes)
            .ok_or_else(|| error("sync_blob_invalid"))?;
    }
    if bytes != total as u64 {
        return Err(error("sync_blob_invalid"));
    }
    Ok(chunks)
}
pub(super) async fn download_one(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    root: &std::path::Path,
    gallery: &std::path::Path,
) -> Result<(), AppError> {
    let Some(row)=query("SELECT m.*,COALESCE(d.next_chunk,0) AS next_chunk FROM account_file_manifests m LEFT JOIN audio_artifacts a ON a.id=m.artifact_id LEFT JOIN account_file_downloads d ON d.manifest_id=m.id WHERE ((m.source_kind='audio' AND a.path='') OR (m.source_kind IN ('studio','assistant') AND NOT EXISTS(SELECT 1 FROM account_file_uploads u WHERE u.artifact_id=m.artifact_id))) AND COALESCE(d.completed,0)=0 ORDER BY m.rowid LIMIT 1").fetch_optional(pool).await? else{return Ok(());};
    let id: String = row.get("id");
    uuid::Uuid::parse_str(&id).map_err(|_| file_error())?;
    let chunks = manifest_chunks(&row.get::<String, _>("chunks_json"), row.get("bytes"))?;
    let current: i64 = row.get("next_chunk");
    if current < 0 || current as usize >= chunks.len() {
        return Err(error("sync_blob_invalid"));
    }
    let chunk = &chunks[current as usize];
    let encrypted = blob(s, &chunk.id, None).await?;
    let envelope = std::str::from_utf8(&encrypted).map_err(|_| error("sync_blob_invalid"))?;
    let clear = crypto::open(key, &blob_aad(s, &chunk.id), envelope)?;
    if clear.len() as u64 != chunk.bytes || digest(&clear) != chunk.sha256 {
        return Err(error("sync_blob_invalid"));
    }
    let studio = row.get::<String, _>("source_kind") == "studio";
    let assistant = row.get::<String, _>("source_kind") == "assistant";
    if assistant && row.get::<i64, _>("bytes") > 20 * 1024 * 1024 {
        return Err(file_error());
    }
    let dir = if assistant {
        root.join("assistant-references")
    } else if studio {
        gallery.to_path_buf()
    } else {
        root.join("recordings").join("synced")
    };
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| file_error())?;
    // No remote path or extension is ever accepted. The container remains
    // sniffable by the existing audio decoder regardless of the .audio suffix.
    let artifact: String = row.get("artifact_id");
    uuid::Uuid::parse_str(&artifact).map_err(|_| file_error())?;
    let extension = if assistant {
        crate::assistants::reference_extension(&row.get::<String, _>("format"))?.to_owned()
    } else if studio {
        super::studio::extension(&row.get::<String, _>("format"))?
    } else {
        "audio".into()
    };
    let target = if assistant {
        let reference = query("SELECT file_name FROM assistant_references WHERE id=? UNION SELECT json_extract(j.value,'$.file_name') FROM assistant_conversations c,json_each(c.snapshot_json,'$.references') j WHERE json_extract(j.value,'$.id')=? LIMIT 1")
            .bind(&artifact)
            .bind(&artifact)
            .fetch_optional(pool)
            .await?
            .ok_or_else(file_error)?;
        let file_name = reference
            .get::<Option<String>, _>("file_name")
            .ok_or_else(file_error)?;
        crate::assistants::reference_file(&dir, &file_name)?
    } else {
        dir.join(format!(
            "{}.{extension}",
            if studio { &artifact } else { &id }
        ))
    };
    let staging = root.join("account-sync-staging");
    tokio::fs::create_dir_all(&staging)
        .await
        .map_err(|_| file_error())?;
    let partial = staging.join(format!("{id}.part"));
    ensure_contained(&staging, &partial)?;
    ensure_contained(&dir, &target)?;
    let offset: u64 = chunks[..current as usize].iter().map(|c| c.bytes).sum();
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&partial)
        .await
        .map_err(|_| file_error())?;
    let len = file.metadata().await.map_err(|_| file_error())?.len();
    if len < offset {
        query("UPDATE account_file_downloads SET next_chunk=0 WHERE manifest_id=?")
            .bind(&id)
            .execute(pool)
            .await?;
        return Ok(());
    }
    file.set_len(offset).await.map_err(|_| file_error())?;
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|_| file_error())?;
    file.write_all(&clear).await.map_err(|_| file_error())?;
    file.sync_all().await.map_err(|_| file_error())?;
    drop(file);
    let done = current as usize + 1 == chunks.len();
    if done {
        tokio::fs::rename(&partial, &target)
            .await
            .map_err(|_| file_error())?;
    }
    let mut tx = pool.begin().await?;
    query("INSERT INTO account_file_downloads(manifest_id,next_chunk,completed) VALUES(?,?,?) ON CONFLICT(manifest_id) DO UPDATE SET next_chunk=excluded.next_chunk,completed=excluded.completed").bind(&id).bind(current+1).bind(done).execute(&mut *tx).await?;
    if done {
        query("UPDATE account_sync_control SET applying=1 WHERE id=1")
            .execute(&mut *tx)
            .await?;
        query("UPDATE audio_artifacts SET path=? WHERE id=? AND path=''")
            .bind(target.to_string_lossy().as_ref())
            .bind(row.get::<String, _>("artifact_id"))
            .execute(&mut *tx)
            .await?;
        query("UPDATE account_sync_control SET applying=0 WHERE id=1")
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}
fn ensure_contained(dir: &std::path::Path, path: &PathBuf) -> Result<(), AppError> {
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(file_error());
    }
    if path.parent() != Some(dir) {
        return Err(file_error());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manifest_rejects_amplification_duplicate_ids_and_false_lengths() {
        let id = uuid::Uuid::new_v4().to_string();
        let c = json!({"id":id,"bytes":10,"sha256":crypto::encode(&[0;32])});
        assert!(manifest_chunks(&json!([c]).to_string(), 10).is_ok());
        assert!(manifest_chunks(&json!([c, c]).to_string(), 20).is_err());
        assert!(manifest_chunks(&json!([c]).to_string(), 11).is_err());
        assert!(manifest_chunks("[]", 10).is_err());
    }
}
