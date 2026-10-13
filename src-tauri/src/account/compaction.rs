//! A file in the account, made smaller (ADR-0110). Recordings are sent as a
//! 16 kHz mono WAV, the very audio transcription reads, while the original
//! stays on the device that recorded it; every compact chunk is sealed in the
//! binary envelope. Runs only once every app on the account reads both
//! (`storage::format_v2`).
//!
//! Durable like the upload lane (ADR-0018): a row is written before any
//! chunk, the chunk's ciphertext before it is sent, and progress after.
//!
//! Two devices may hold the same file. The copy that replaces a manifest has
//! an id derived from the one it replaces, and so have its chunks: the second
//! device to send chunk zero finds it taken (409) and leaves the file to the
//! first. A device that took a file and vanished is outlived by the sweep,
//! which releases its unnamed chunks after a week, and the file is free again.
use super::files::{blob_aad, digest, put_chunk, Chunk, CHUNK_BYTES};
use super::*;
use crate::app_paths::AppPaths;
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// Fixed namespace for the ids derived here. Changing it would let two
/// versions of the app compact the same file twice.
const NAMESPACE: uuid::Uuid = uuid::Uuid::from_u128(0x5b0e_3c4f_2a61_4d7e_9b3a_6f1d_0c2e_8a47);
/// How long a file another device is compacting is left alone.
const ELSEWHERE_SECONDS: i64 = 8 * 86_400;
/// How long a file whose manifest another device removed is left alone,
/// so its replacement arrives before this device sends a copy of its own.
const WAIT_FOR_REPLACEMENT_SECONDS: i64 = 30 * 86_400;
/// How long a copy that failed waits before it is tried again.
const FAILED_SECONDS: i64 = 86_400;
/// A pass's share for compaction, after the journal and the file lane.
const BUDGET: Duration = Duration::from_secs(10);
const MARGIN: Duration = Duration::from_secs(30);
/// Below this, a compact recording is not worth sending again.
const WORTH_PERCENT: u64 = 90;

/// The chunk at `index` of a compact copy.
pub(super) fn chunk_id(manifest_id: &str, index: usize) -> String {
    uuid::Uuid::new_v5(&NAMESPACE, format!("{manifest_id}:{index}").as_bytes()).to_string()
}
/// The manifest that replaces `old`: every device derives the same one.
pub(super) fn replacement_id(old: &str) -> String {
    uuid::Uuid::new_v5(&NAMESPACE, format!("compact:{old}").as_bytes()).to_string()
}
/// SQL for "this manifest is already compact": its first chunk id is a
/// derived (version 5) one. Only compact copies have such ids.
const IS_COMPACT: &str = "substr(json_extract(m.chunks_json,'$[0].id'),15,1)='5'";

/// Files still in the form they were first sent in.
pub(super) async fn pending(pool: &SqlitePool) -> Result<i64, AppError> {
    Ok(query(&format!("SELECT count(*) AS n FROM account_file_manifests m WHERE m.source_kind IN ('audio','studio') AND NOT {IS_COMPACT}"))
        .fetch_one(pool)
        .await?
        .get("n"))
}

/// Where the compact copies are written before they are sent.
fn workshop(paths: &AppPaths) -> PathBuf {
    paths.data_dir.join("account-sync-compact")
}

/// One bounded step: finish the copy under way, or start the next one.
pub(super) async fn step(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    paths: &AppPaths,
    gallery: &std::path::Path,
    deadline: Instant,
) -> Result<(), AppError> {
    // Never before every app on the account reads what this writes.
    if !storage::format_v2(pool).await? {
        return Ok(());
    }
    // An upload begun in the old form gives way: the recording leaves again
    // in its compact one, and the trigger releases what it had sent.
    query("DELETE FROM account_file_uploads WHERE completed=0 AND source_kind='audio'")
        .execute(pool)
        .await?;
    let started = Instant::now();
    while started.elapsed() < BUDGET && Instant::now() + MARGIN < deadline {
        let row = match current(pool).await? {
            Some(row) => row,
            None => match begin(pool, paths, gallery).await? {
                Some(row) => row,
                None => return Ok(()),
            },
        };
        let id: String = row.get("id");
        match advance(pool, s, key, paths, &row).await {
            Ok(true) => {}
            Ok(false) => return Ok(()),
            Err(e) if e.code == "account_storage_full" => {
                storage::hold_files(pool).await?;
                return Ok(());
            }
            Err(e) if e.code == "sync_chunk_taken" => {
                set_aside(pool, paths, &id, ELSEWHERE_SECONDS, false).await?;
            }
            // A file that changed or cannot be read: a new recording is set
            // aside like any upload that failed, so a person sees it; a copy
            // that would only have saved room waits a day and tries again.
            Err(e) if sync::isolatable_file_error(&e.code) => {
                if row.get::<Option<String>, _>("replaces").is_some() {
                    set_aside(pool, paths, &id, FAILED_SECONDS, true).await?;
                } else {
                    let artifact: String = row.get("artifact_id");
                    drop_copy(pool, paths, &id).await?;
                    sync::record_issue(pool, "upload", &artifact, &e.code).await?;
                }
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

async fn current(pool: &SqlitePool) -> Result<Option<sqlx_sqlite::SqliteRow>, AppError> {
    Ok(query(
        "SELECT * FROM account_file_compactions WHERE held_until<=? ORDER BY created_at LIMIT 1",
    )
    .bind(storage::now())
    .fetch_optional(pool)
    .await?)
}

/// Picks the next file: a recording with no manifest first, since another
/// device is waiting for it, then the largest file still in its first form.
async fn begin(
    pool: &SqlitePool,
    paths: &AppPaths,
    gallery: &std::path::Path,
) -> Result<Option<sqlx_sqlite::SqliteRow>, AppError> {
    let now = chrono::Utc::now().to_rfc3339();
    if storage::sending(pool, "audio").await? {
        if let Some(a) = query("SELECT a.id,a.path,a.format FROM audio_artifacts a WHERE a.path<>'' AND a.status='valid' AND a.purged_at IS NULL AND NOT EXISTS(SELECT 1 FROM account_file_manifests m WHERE m.artifact_id=a.id) AND NOT EXISTS(SELECT 1 FROM account_file_uploads u WHERE u.artifact_id=a.id) AND NOT EXISTS(SELECT 1 FROM account_file_compactions c WHERE c.artifact_id=a.id) AND NOT EXISTS(SELECT 1 FROM account_sync_issues i WHERE i.lane='upload' AND i.item_id=a.id) AND NOT EXISTS(SELECT 1 FROM account_manifest_waits w WHERE w.artifact_id=a.id AND w.at>?) LIMIT 1")
            .bind(storage::now() - WAIT_FOR_REPLACEMENT_SECONDS)
            .fetch_optional(pool)
            .await?
        {
            let source = paths
                .contained_recording_file(a.get::<String, _>("path"))
                .map_err(|_| error("sync_file_unavailable"))?;
            query("INSERT INTO account_file_compactions(id,artifact_id,source_kind,format,source_path,created_at) VALUES(?,?,'audio','wav',?,?)")
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(a.get::<String, _>("id"))
                .bind(source.to_string_lossy().as_ref())
                .bind(&now)
                .execute(pool)
                .await?;
            return current(pool).await;
        }
    }
    let candidates = query(&format!("SELECT m.id,m.artifact_id,m.source_kind,m.format,a.path AS audio_path,f.file_name FROM account_file_manifests m LEFT JOIN audio_artifacts a ON a.id=m.artifact_id LEFT JOIN account_studio_files f ON f.id=m.artifact_id WHERE m.source_kind IN ('audio','studio') AND NOT {IS_COMPACT} AND NOT EXISTS(SELECT 1 FROM account_file_compactions c WHERE c.replaces=m.id) AND NOT EXISTS(SELECT 1 FROM account_file_uploads u WHERE u.artifact_id=m.artifact_id AND u.completed=0) ORDER BY m.bytes DESC LIMIT 20"))
        .fetch_all(pool)
        .await?;
    for m in candidates {
        let kind: String = m.get("source_kind");
        let source = if kind == "audio" {
            let Some(path) = m
                .get::<Option<String>, _>("audio_path")
                .filter(|p| !p.is_empty())
            else {
                continue;
            };
            paths.contained_recording_file(path).ok()
        } else {
            m.get::<Option<String>, _>("file_name").and_then(|name| {
                let format: String = m.get("format");
                let file = std::path::Path::new(&name);
                (file.components().count() == 1)
                    .then(|| super::studio::folder(gallery, &format).join(file))
            })
        };
        let Some(source) = source.filter(|p| p.is_file()) else {
            continue;
        };
        let old: String = m.get("id");
        query("INSERT OR IGNORE INTO account_file_compactions(id,replaces,artifact_id,source_kind,format,source_path,created_at) VALUES(?,?,?,?,?,?,?)")
            .bind(replacement_id(&old))
            .bind(&old)
            .bind(m.get::<String, _>("artifact_id"))
            .bind(&kind)
            .bind(m.get::<String, _>("format"))
            .bind(source.to_string_lossy().as_ref())
            .bind(&now)
            .execute(pool)
            .await?;
        return current(pool).await;
    }
    Ok(None)
}

/// Prepares the copy if it is not yet, then sends one chunk, or publishes
/// the manifest when every chunk is there. `Ok(false)` when it waits.
async fn advance(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    paths: &AppPaths,
    row: &sqlx_sqlite::SqliteRow,
) -> Result<bool, AppError> {
    let id: String = row.get("id");
    // Another device published this very copy first: there is nothing left
    // to send, and the chunks are its.
    if query("SELECT 1 FROM account_file_manifests WHERE id=?")
        .bind(&id)
        .fetch_optional(pool)
        .await?
        .is_some()
    {
        let _ = tokio::fs::remove_file(workshop(paths).join(format!("{id}.wav"))).await;
        query("DELETE FROM account_file_compactions WHERE id=?")
            .bind(&id)
            .execute(pool)
            .await?;
        return Ok(true);
    }
    if row.get::<i64, _>("derived") == 0 {
        prepare(pool, paths, row).await?;
        return Ok(true);
    }
    let path = PathBuf::from(
        row.get::<Option<String>, _>("source_path")
            .ok_or_else(|| error("sync_file_unavailable"))?,
    );
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|_| error("sync_file_unavailable"))?;
    let total: i64 = row.get("bytes");
    let offset: i64 = row.get("next_offset");
    if meta.len() != total as u64
        || Some(files::modified(&meta)?) != row.get::<Option<String>, _>("modified")
    {
        return Err(error("sync_file_changed"));
    }
    let mut chunks: Vec<Chunk> = serde_json::from_str(&row.get::<String, _>("chunks_json"))
        .map_err(|_| error("sync_file_unavailable"))?;
    if offset == total {
        return publish(pool, s, paths, row, &chunks).await.map(|()| true);
    }
    let pending: Option<String> = row.get("pending_blob_id");
    let (blob_id, sealed, size, hash) = if let Some(blob_id) = pending {
        (
            blob_id,
            row.get::<Vec<u8>, _>("pending_ciphertext"),
            row.get::<i64, _>("pending_bytes"),
            row.get::<String, _>("pending_digest"),
        )
    } else {
        let mut file = tokio::fs::File::open(&path)
            .await
            .map_err(|_| error("sync_file_unavailable"))?;
        file.seek(std::io::SeekFrom::Start(offset as u64))
            .await
            .map_err(|_| error("sync_file_unavailable"))?;
        let mut clear = Zeroizing::new(vec![0; CHUNK_BYTES.min((total - offset) as usize)]);
        file.read_exact(&mut clear)
            .await
            .map_err(|_| error("sync_file_unavailable"))?;
        let blob_id = chunk_id(&id, chunks.len());
        let sealed = crypto::seal_binary(key, &blob_aad(s, &blob_id), &clear)?;
        let hash = digest(&clear);
        let size = clear.len() as i64;
        query("UPDATE account_file_compactions SET pending_blob_id=?,pending_ciphertext=?,pending_bytes=?,pending_digest=? WHERE id=?")
            .bind(&blob_id)
            .bind(&sealed)
            .bind(size)
            .bind(&hash)
            .bind(&id)
            .execute(pool)
            .await?;
        (blob_id, sealed, size, hash)
    };
    put_chunk(s, &blob_id, sealed).await?;
    chunks.push(Chunk {
        id: blob_id,
        bytes: size as u64,
        sha256: hash,
    });
    query("UPDATE account_file_compactions SET next_offset=?,chunks_json=?,pending_blob_id=NULL,pending_ciphertext=NULL,pending_bytes=NULL,pending_digest=NULL WHERE id=?")
        .bind(offset + size)
        .bind(serde_json::to_string(&chunks).map_err(|_| error("sync_file_unavailable"))?)
        .bind(&id)
        .execute(pool)
        .await?;
    Ok(true)
}

/// Writes the compact recording beside the original, or settles for the
/// original's bytes when making it smaller would not pay: a Studio file, or
/// a recording already at transcription's rate.
async fn prepare(
    pool: &SqlitePool,
    paths: &AppPaths,
    row: &sqlx_sqlite::SqliteRow,
) -> Result<(), AppError> {
    let id: String = row.get("id");
    let original = PathBuf::from(
        row.get::<Option<String>, _>("source_path")
            .ok_or_else(|| error("sync_file_unavailable"))?,
    );
    let mut source = original.clone();
    let mut derived = 1;
    if row.get::<String, _>("source_kind") == "audio" {
        let dir = workshop(paths);
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|_| error("sync_file_unavailable"))?;
        let target = dir.join(format!("{id}.wav"));
        let input = original.clone();
        let output = target.clone();
        let made = tokio::task::spawn_blocking(move || {
            crate::audio::decode::decode_to_compact_wav(&input, &output)
        })
        .await
        .map_err(|_| error("sync_file_unavailable"))?;
        let original_len = tokio::fs::metadata(&original)
            .await
            .map_err(|_| error("sync_file_unavailable"))?
            .len();
        match made {
            Ok(_) => {
                let len = tokio::fs::metadata(&target)
                    .await
                    .map_err(|_| error("sync_file_unavailable"))?
                    .len();
                if len * 100 < original_len * WORTH_PERCENT {
                    source = target;
                    derived = 2;
                } else {
                    let _ = tokio::fs::remove_file(&target).await;
                }
            }
            // A recording the decoder cannot read leaves as it is.
            Err(_) => {
                let _ = tokio::fs::remove_file(&target).await;
            }
        }
    }
    let meta = tokio::fs::metadata(&source)
        .await
        .map_err(|_| error("sync_file_unavailable"))?;
    if meta.len() == 0 || meta.len() > 2 * 1024 * 1024 * 1024 {
        return Err(error("sync_file_too_large"));
    }
    query(
        "UPDATE account_file_compactions SET source_path=?,derived=?,bytes=?,modified=? WHERE id=?",
    )
    .bind(source.to_string_lossy().as_ref())
    .bind(derived)
    .bind(meta.len() as i64)
    .bind(files::modified(&meta)?)
    .bind(&id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Every chunk is sent: checks the service holds them all, then writes the
/// new manifest and drops the one it replaces in one transaction. The old
/// chunks are released by the deletion lane a day later, like any deleted
/// file's.
async fn publish(
    pool: &SqlitePool,
    s: &Session,
    paths: &AppPaths,
    row: &sqlx_sqlite::SqliteRow,
    chunks: &[Chunk],
) -> Result<(), AppError> {
    let id: String = row.get("id");
    let ids: Vec<String> = chunks.iter().map(|c| c.id.clone()).collect();
    if let Some(first_missing) = missing(s, &ids).await? {
        // Released behind its back (a week offline): sent again from there.
        let kept = &chunks[..first_missing];
        let offset: u64 = kept.iter().map(|c| c.bytes).sum();
        query("UPDATE account_file_compactions SET next_offset=?,chunks_json=? WHERE id=?")
            .bind(offset as i64)
            .bind(serde_json::to_string(kept).map_err(|_| error("sync_file_unavailable"))?)
            .bind(&id)
            .execute(pool)
            .await?;
        return Ok(());
    }
    let replaces: Option<String> = row.get("replaces");
    let artifact: String = row.get("artifact_id");
    let kind: String = row.get("source_kind");
    let chunks_json = serde_json::to_string(chunks).map_err(|_| error("sync_file_unavailable"))?;
    let mut tx = pool.begin().await?;
    let created_at = match &replaces {
        Some(old) => {
            let Some(old_row) = query("SELECT created_at FROM account_file_manifests WHERE id=?")
                .bind(old)
                .fetch_optional(&mut *tx)
                .await?
            else {
                // The file was deleted meanwhile: the copy has no one to serve.
                drop(tx);
                return drop_copy(pool, paths, &id).await;
            };
            old_row.get::<String, _>("created_at")
        }
        None => chrono::Utc::now().to_rfc3339(),
    };
    // One manifest per file: the first form goes before its copy arrives,
    // and leaves first, so every device reads them in that order.
    if let Some(old) = &replaces {
        query("DELETE FROM account_file_manifests WHERE id=?")
            .bind(old)
            .execute(&mut *tx)
            .await?;
    }
    query("INSERT INTO account_file_manifests(id,artifact_id,bytes,format,chunks_json,created_at,source_kind) VALUES(?,?,?,?,?,?,?)")
        .bind(&id)
        .bind(&artifact)
        .bind(row.get::<i64, _>("bytes"))
        .bind(row.get::<String, _>("format"))
        .bind(&chunks_json)
        .bind(&created_at)
        .bind(&kind)
        .execute(&mut *tx)
        .await?;
    // This device holds the file already: it never fetches its own copy.
    query("INSERT OR REPLACE INTO account_file_downloads(manifest_id,next_chunk,completed) VALUES(?,?,1)")
        .bind(&id)
        .bind(chunks.len() as i64)
        .execute(&mut *tx)
        .await?;
    query("DELETE FROM account_file_compactions WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    if row.get::<i64, _>("derived") == 2 {
        let _ = tokio::fs::remove_file(workshop(paths).join(format!("{id}.wav"))).await;
    }
    super::poke();
    Ok(())
}

/// Sends again the chunks a held-back manifest names and the service lost,
/// from this device's copy of the file, each checked against the digest the
/// manifest carries. A manifest whose file this device cannot rebuild stays
/// held, with its issue in sight.
pub(super) async fn repair(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    paths: &AppPaths,
    gallery: &std::path::Path,
    deadline: Instant,
) -> Result<(), AppError> {
    let waiting = query("SELECT operation_id,manifest_id FROM account_chunk_repairs LIMIT 5")
        .fetch_all(pool)
        .await?;
    if waiting.is_empty() {
        return Ok(());
    }
    for row in waiting {
        if Instant::now() + MARGIN >= deadline {
            break;
        }
        let operation: String = row.get("operation_id");
        let manifest: String = row.get("manifest_id");
        match rebuild(pool, s, key, paths, gallery, &manifest).await {
            Ok(()) => {
                query("DELETE FROM account_chunk_repairs WHERE operation_id=?")
                    .bind(&operation)
                    .execute(pool)
                    .await?;
                query("DELETE FROM account_sync_issues WHERE lane='outbox' AND item_id=?")
                    .bind(&operation)
                    .execute(pool)
                    .await?;
                super::poke();
            }
            Err(e) if e.code == "account_storage_full" => {
                storage::hold_files(pool).await?;
                return Ok(());
            }
            Err(e) if sync::isolatable_file_error(&e.code) => {
                tracing::debug!(code=%e.code, "a manifest's chunks cannot be sent again from here");
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

async fn rebuild(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    paths: &AppPaths,
    gallery: &std::path::Path,
    manifest: &str,
) -> Result<(), AppError> {
    let Some(m) = query("SELECT m.*,a.path AS audio_path,f.file_name FROM account_file_manifests m LEFT JOIN audio_artifacts a ON a.id=m.artifact_id LEFT JOIN account_studio_files f ON f.id=m.artifact_id WHERE m.id=?")
        .bind(manifest)
        .fetch_optional(pool)
        .await?
    else {
        // Deleted since: the tombstone that replaces it names no chunk.
        return Ok(());
    };
    let chunks: Vec<Chunk> = serde_json::from_str(&m.get::<String, _>("chunks_json"))
        .map_err(|_| error("sync_blob_invalid"))?;
    let ids: Vec<String> = chunks.iter().map(|c| c.id.clone()).collect();
    let mut gone = Vec::new();
    for (start, group) in ids.chunks(100).enumerate() {
        let found = call(
            s,
            reqwest::Method::GET,
            &format!("/api/v1/blobs?ids={}", group.join(",")),
            None,
        )
        .await?;
        let found: std::collections::HashSet<&str> = found["blobs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|b| b["id"].as_str())
            .collect();
        gone.extend(
            group
                .iter()
                .enumerate()
                .filter(|(_, id)| !found.contains(id.as_str()))
                .map(|(i, _)| start * 100 + i),
        );
    }
    if gone.is_empty() {
        return Ok(());
    }
    let kind: String = m.get("source_kind");
    let compact = chunks
        .first()
        .is_some_and(|c| c.id.get(14..15) == Some("5"));
    let mut source = match kind.as_str() {
        "audio" => paths
            .contained_recording_file(
                m.get::<Option<String>, _>("audio_path")
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| error("sync_file_unavailable"))?,
            )
            .map_err(|_| error("sync_file_unavailable"))?,
        "studio" => {
            let name = m
                .get::<Option<String>, _>("file_name")
                .ok_or_else(|| error("sync_file_unavailable"))?;
            if std::path::Path::new(&name).components().count() != 1 {
                return Err(error("sync_file_unavailable"));
            }
            super::studio::folder(gallery, &m.get::<String, _>("format")).join(name)
        }
        _ => return Err(error("sync_file_unavailable")),
    };
    // A compact recording is rebuilt the way it was made: decoding is
    // deterministic, and every chunk is checked against its digest anyway.
    let rebuilt = workshop(paths).join(format!("{manifest}.repair.wav"));
    if kind == "audio" && compact {
        tokio::fs::create_dir_all(workshop(paths))
            .await
            .map_err(|_| error("sync_file_unavailable"))?;
        let (input, output) = (source.clone(), rebuilt.clone());
        let made = tokio::task::spawn_blocking(move || {
            crate::audio::decode::decode_to_compact_wav(&input, &output)
        })
        .await
        .map_err(|_| error("sync_file_unavailable"))?;
        if made.is_ok()
            && tokio::fs::metadata(&rebuilt)
                .await
                .is_ok_and(|meta| meta.len() == m.get::<i64, _>("bytes") as u64)
        {
            source = rebuilt.clone();
        }
    }
    let result = async {
        let mut file = tokio::fs::File::open(&source)
            .await
            .map_err(|_| error("sync_file_unavailable"))?;
        for index in gone {
            let chunk = &chunks[index];
            let offset: u64 = chunks[..index].iter().map(|c| c.bytes).sum();
            file.seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(|_| error("sync_file_unavailable"))?;
            let mut clear = Zeroizing::new(vec![0; chunk.bytes as usize]);
            file.read_exact(&mut clear)
                .await
                .map_err(|_| error("sync_file_changed"))?;
            if digest(&clear) != chunk.sha256 {
                return Err(error("sync_file_changed"));
            }
            let aad = blob_aad(s, &chunk.id);
            let sealed = if chunk.id.get(14..15) == Some("5") {
                crypto::seal_binary(key, &aad, &clear)?
            } else {
                crypto::seal(key, &aad, &clear)?.into_bytes()
            };
            match put_chunk(s, &chunk.id, sealed).await {
                // Sent again by another device meanwhile: it is there.
                Ok(()) => {}
                Err(e) if e.code == "sync_chunk_taken" => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }
    .await;
    let _ = tokio::fs::remove_file(&rebuilt).await;
    result
}

/// The position of the first of `ids` the service does not hold.
pub(super) async fn missing(s: &Session, ids: &[String]) -> Result<Option<usize>, AppError> {
    for (group_index, group) in ids.chunks(100).enumerate() {
        let found = call(
            s,
            reqwest::Method::GET,
            &format!("/api/v1/blobs?ids={}", group.join(",")),
            None,
        )
        .await?;
        let found: std::collections::HashSet<&str> = found["blobs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|b| b["id"].as_str())
            .collect();
        if let Some(position) = group.iter().position(|id| !found.contains(id.as_str())) {
            return Ok(Some(group_index * 100 + position));
        }
    }
    Ok(None)
}

/// Leaves a copy for a while, starting over when it comes back. Another
/// device that took the file first owns the chunks sent under its ids, so
/// they are not released (`release_own` false); a copy that failed here
/// releases what it sent.
async fn set_aside(
    pool: &SqlitePool,
    paths: &AppPaths,
    id: &str,
    seconds: i64,
    release_own: bool,
) -> Result<(), AppError> {
    let _ = tokio::fs::remove_file(workshop(paths).join(format!("{id}.wav"))).await;
    let mut tx = pool.begin().await?;
    if release_own {
        release_sent(&mut tx, id).await?;
    }
    query("UPDATE account_file_compactions SET held_until=?,derived=0,next_offset=0,chunks_json='[]',pending_blob_id=NULL,pending_ciphertext=NULL,pending_bytes=NULL,pending_digest=NULL WHERE id=?")
        .bind(storage::now() + seconds)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Puts the chunks a copy sent up for release.
async fn release_sent(tx: &mut sqlx_sqlite::SqliteConnection, id: &str) -> Result<(), AppError> {
    if let Some(row) =
        query("SELECT chunks_json,pending_blob_id FROM account_file_compactions WHERE id=?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
    {
        // Only chunks the service confirmed. A pending one with a derived id
        // may never have been sent, and may then be another device's.
        let ids = storage::chunk_ids(&row.get::<String, _>("chunks_json"));
        for blob_id in ids {
            query("INSERT OR IGNORE INTO account_blob_releases(blob_id,reason,not_before) VALUES(?,'dropped copy',?)")
                .bind(blob_id)
                .bind(storage::now() + 3600)
                .execute(&mut *tx)
                .await?;
        }
    }
    Ok(())
}

/// Drops every copy of a recording this device was making, releasing the
/// chunks it sent: the recording itself is going (ADR-0111).
pub(super) async fn forget_copies_of(
    tx: &mut sqlx_sqlite::SqliteConnection,
    artifact_id: &str,
) -> Result<(), AppError> {
    let ids: Vec<String> = query("SELECT id FROM account_file_compactions WHERE artifact_id=?")
        .bind(artifact_id)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(|r| r.get("id"))
        .collect();
    for id in ids {
        release_sent(&mut *tx, &id).await?;
        query("DELETE FROM account_file_compactions WHERE id=?")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    }
    Ok(())
}

/// Drops a copy this device was making. Its chunks are its own, unnamed by
/// any manifest: they go up for release.
async fn drop_copy(pool: &SqlitePool, paths: &AppPaths, id: &str) -> Result<(), AppError> {
    let _ = tokio::fs::remove_file(workshop(paths).join(format!("{id}.wav"))).await;
    let mut tx = pool.begin().await?;
    release_sent(&mut tx, id).await?;
    query("DELETE FROM account_file_compactions WHERE id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derived_ids_are_version_five_stable_and_distinct() {
        let a = replacement_id("8f9d543c-92e4-44e0-81ed-7ac8060b6596");
        assert_eq!(a, replacement_id("8f9d543c-92e4-44e0-81ed-7ac8060b6596"));
        assert_ne!(a, replacement_id("96304505-df91-4479-8669-57aed54eaf76"));
        let first = chunk_id(&a, 0);
        assert_ne!(first, chunk_id(&a, 1));
        // The SQL test for "already compact" reads the version digit at 15.
        assert_eq!(&first[14..15], "5");
        assert_eq!(&uuid::Uuid::new_v4().to_string()[14..15], "4");
    }
}
