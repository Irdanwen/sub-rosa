//! Keeping the account inside its quota (ADR-0110). The service stops files
//! short of the quota so the journal always has room; this side gives room
//! back. A chunk is released only when nothing this device knows still names
//! it: a live manifest, an upload or a compaction under way, a card a person
//! has not answered. Every candidate is checked again just before it goes,
//! because a release cannot be taken back.
use super::*;
use std::collections::HashSet;

/// How long sending waits after the service said the account is full,
/// unless a release gives room back first.
const HOLD_SECONDS: i64 = 600;
/// A deleted file's chunks wait this long after the deletion: a crossing
/// edit or a card has time to arrive before the bytes go.
const DELETION_DELAY_SECONDS: i64 = 86_400;
/// A chunk no manifest names is left alone for this long: it may be another
/// device's upload whose manifest has not been sent yet.
const SWEEP_GRACE_DAYS: i64 = 7;
/// And once found unnamed, it waits another hour, then goes only from a pass
/// that has just read the whole journal: a manifest sent meanwhile names it.
const SWEEP_DELAY_SECONDS: i64 = 3600;
const SWEEP_EVERY_SECONDS: i64 = 86_400;
const GATE_EVERY_SECONDS: i64 = 600;
const USAGE_EVERY_SECONDS: i64 = 600;
/// The first version that reads binary chunks and compact copies.
const FORMAT_V2_SINCE: (u64, u64, u64) = (1, 91, 0);
/// Above this share of the quota the sweep stops waiting for its day.
const URGENT_PERCENT: i64 = 90;
const RELEASE_BATCH: i64 = 200;

pub(super) fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

#[derive(Deserialize)]
struct ChunkId {
    id: String,
}
/// The chunk ids a manifest names. An unreadable list names nothing, which
/// is safe here: it only ever adds to what is kept.
pub(super) fn chunk_ids(chunks_json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<ChunkId>>(chunks_json)
        .map(|chunks| chunks.into_iter().map(|c| c.id).collect())
        .unwrap_or_default()
}

/// Whether sending the journal waits for room.
pub(super) async fn push_held(pool: &SqlitePool) -> Result<bool, AppError> {
    held(pool, "push_held_until").await
}
/// Whether sending files waits for room.
pub(super) async fn files_held(pool: &SqlitePool) -> Result<bool, AppError> {
    held(pool, "files_held_until").await
}
async fn held(pool: &SqlitePool, column: &str) -> Result<bool, AppError> {
    Ok(query(&format!(
        "SELECT 1 FROM account_storage_state WHERE id=1 AND {column}>?"
    ))
    .bind(now())
    .fetch_optional(pool)
    .await?
    .is_some())
}
pub(super) async fn hold_push(pool: &SqlitePool) -> Result<(), AppError> {
    hold(pool, "push_held_until").await
}
pub(super) async fn hold_files(pool: &SqlitePool) -> Result<(), AppError> {
    hold(pool, "files_held_until").await
}
async fn hold(pool: &SqlitePool, column: &str) -> Result<(), AppError> {
    query(&format!(
        "UPDATE account_storage_state SET {column}=? WHERE id=1"
    ))
    .bind(now() + HOLD_SECONDS)
    .execute(pool)
    .await?;
    Ok(())
}
/// Room came back: whatever waited goes on the next pass.
async fn release_holds(pool: &SqlitePool) -> Result<(), AppError> {
    query("UPDATE account_storage_state SET push_held_until=0,files_held_until=0 WHERE id=1")
        .execute(pool)
        .await?;
    Ok(())
}

/// Whether every app on the account reads binary chunks and compact copies
/// (ADR-0110): until then this device writes only what an older app reads.
pub(super) async fn format_v2(pool: &SqlitePool) -> Result<bool, AppError> {
    Ok(
        query("SELECT format_v2 FROM account_storage_state WHERE id=1")
            .fetch_optional(pool)
            .await?
            .is_some_and(|r| r.get::<i64, _>("format_v2") == 1),
    )
}

fn parse_version(value: &str) -> Option<(u64, u64, u64)> {
    let mut parts = value.split('.').map(|p| p.parse::<u64>().ok());
    let version = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(version)
}

/// The devices that hold the newer format back: native apps, not revoked,
/// that announce no version or an older one, however long ago they were
/// seen. A laptop closed for two months may still hold a manifest it has not
/// sent, and only an app that checks its chunks first may meet the sweep. A
/// browser is left out: the site is published with every release.
pub(super) fn format_blockers(devices: &[Value]) -> Vec<String> {
    devices
        .iter()
        .filter(|d| d["kind"].as_str() != Some("browser") && d["revoked_at"].is_null())
        .filter(|d| {
            !d["app_version"]
                .as_str()
                .and_then(parse_version)
                .is_some_and(|v| v >= FORMAT_V2_SINCE)
        })
        .map(|d| d["name"].as_str().unwrap_or_default().to_string())
        .collect()
}

async fn refresh_gate(pool: &SqlitePool, s: &Session) -> Result<(), AppError> {
    let due = query("SELECT 1 FROM account_storage_state WHERE id=1 AND gate_checked_at<=?")
        .bind(now() - GATE_EVERY_SECONDS)
        .fetch_optional(pool)
        .await?
        .is_some();
    if !due {
        return Ok(());
    }
    let devices = call(s, reqwest::Method::GET, "/api/v1/devices", None).await?;
    let devices = devices.as_array().cloned().unwrap_or_default();
    let blockers = format_blockers(&devices);
    // The list always holds the device asking; empty, it says nothing.
    let open = !devices.is_empty() && blockers.is_empty();
    query(
        "UPDATE account_storage_state SET format_v2=?,blockers_json=?,gate_checked_at=? WHERE id=1",
    )
    .bind(open)
    .bind(json!(blockers).to_string())
    .bind(now())
    .execute(pool)
    .await?;
    Ok(())
}

/// Reads where the account stands from `/api/v1/me`. A service that predates
/// the field leaves the last reading as it was.
async fn refresh_usage(pool: &SqlitePool, s: &Session, force: bool) -> Result<(), AppError> {
    if !force
        && query("SELECT 1 FROM account_storage_state WHERE id=1 AND measured_at>?")
            .bind(now() - USAGE_EVERY_SECONDS)
            .fetch_optional(pool)
            .await?
            .is_some()
    {
        return Ok(());
    }
    let me = call(s, reqwest::Method::GET, "/api/v1/me", None).await?;
    let storage = &me["storage"];
    let Some(used) = storage["used_bytes"].as_i64() else {
        return Ok(());
    };
    query("UPDATE account_storage_state SET used_bytes=?,quota_bytes=?,file_bytes=?,reserve_bytes=?,measured_at=? WHERE id=1")
        .bind(used)
        .bind(storage["quota_bytes"].as_i64())
        .bind(storage["file_bytes"].as_i64())
        .bind(storage["journal_reserve_bytes"].as_i64())
        .bind(now())
        .execute(pool)
        .await?;
    Ok(())
}

/// Every chunk something on this device still names. Unanswered cards are
/// read because "keep this version" would bring their file back.
pub(super) async fn referenced(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
) -> Result<HashSet<String>, AppError> {
    let mut kept = HashSet::new();
    for row in query("SELECT chunks_json FROM account_file_manifests UNION ALL SELECT chunks_json FROM account_file_uploads WHERE completed=0 UNION ALL SELECT chunks_json FROM account_file_compactions")
        .fetch_all(pool)
        .await?
    {
        kept.extend(chunk_ids(&row.get::<String, _>("chunks_json")));
    }
    for row in query("SELECT pending_blob_id FROM account_file_uploads WHERE pending_blob_id IS NOT NULL UNION ALL SELECT pending_blob_id FROM account_file_compactions WHERE pending_blob_id IS NOT NULL")
        .fetch_all(pool)
        .await?
    {
        kept.insert(row.get::<String, _>("pending_blob_id"));
    }
    // Every manifest the journal holds as live, not only the rows here: two
    // copies of one file may both be live for a while (ADR-0110), and this
    // device keeps one row per file.
    for row in query("SELECT i.* FROM account_sync_heads h JOIN account_sync_inbox i ON i.revision=h.revision WHERE h.kind='artifact' AND i.deleted=0")
        .fetch_all(pool)
        .await?
    {
        let body = sync::verify(s, key, &inbox_change(&row))
            .map_err(|_| error("sync_card_unreadable"))?;
        if body["table"] == "account_file_manifests" {
            if let Some(chunks) = body["row"]["chunks_json"].as_str() {
                kept.extend(chunk_ids(chunks));
            }
        }
    }
    for row in query(
        "SELECT * FROM account_sync_conflicts WHERE resolved=0 AND kind='artifact' AND deleted=0",
    )
    .fetch_all(pool)
    .await?
    {
        let change = sync::conflict_change(&row)?;
        // A card this build cannot read cannot be told apart from one that
        // names a chunk, so nothing is released while it waits.
        let body = sync::verify(s, key, &change).map_err(|_| error("sync_card_unreadable"))?;
        if body["table"] == "account_file_manifests" {
            if let Some(chunks) = body["row"]["chunks_json"].as_str() {
                kept.extend(chunk_ids(chunks));
            }
        }
    }
    Ok(kept)
}

/// A journal row, as `verify` reads it.
fn inbox_change(r: &sqlx_sqlite::SqliteRow) -> sync::Change {
    sync::Change {
        sequence: r.get("sequence"),
        resolved_revisions: serde_json::from_str(&r.get::<String, _>("resolved_revisions"))
            .unwrap_or_default(),
        object_id: r.get("object_id"),
        revision: r.get("revision"),
        parent_revision: r.get("parent_revision"),
        kind: r.get("kind"),
        ciphertext: r.get("ciphertext"),
        deleted: r.get("deleted"),
        operation_id: r.get("operation_id"),
    }
}

/// Whether every file revision this device was handed is applied: nothing
/// waiting for a parent, nothing parked. Releases are planned only then.
async fn files_settled(pool: &SqlitePool) -> Result<bool, AppError> {
    Ok(
        query("SELECT 1 FROM account_sync_inbox WHERE applied=0 AND kind='artifact' LIMIT 1")
            .fetch_optional(pool)
            .await?
            .is_none(),
    )
}

/// Chunks of file manifests the journal holds as deleted, put up for
/// release a day after the deletion. Reads the journal, not this device's
/// own actions, so a deletion an older app made is released too.
async fn plan_deletions(pool: &SqlitePool, s: &Session, key: &[u8; 32]) -> Result<usize, AppError> {
    let rows = query("SELECT h.object_id,h.revision,i.sequence FROM account_sync_heads h JOIN account_sync_inbox i ON i.revision=h.revision WHERE h.kind='artifact' AND i.deleted=1 AND NOT EXISTS(SELECT 1 FROM account_storage_settled t WHERE t.object_id=h.object_id AND t.revision=h.revision) LIMIT 200")
        .fetch_all(pool)
        .await?;
    if rows.is_empty() {
        return Ok(0);
    }
    let kept = referenced(pool, s, key).await?;
    let mut planned = 0;
    for row in rows {
        let object_id: String = row.get("object_id");
        let tombstone: String = row.get("revision");
        let deleted_at = uuid::Uuid::parse_str(&tombstone)
            .ok()
            .and_then(|id| id.get_timestamp())
            .map_or(now(), |at| i64::try_from(at.to_unix().0).unwrap_or(0));
        let not_before = (deleted_at + DELETION_DELAY_SECONDS).max(now());
        let mut chunks = Vec::new();
        for live in
            query("SELECT * FROM account_sync_inbox WHERE object_id=? AND deleted=0 AND sequence<?")
                .bind(&object_id)
                .bind(row.get::<i64, _>("sequence"))
                .fetch_all(pool)
                .await?
        {
            let change = inbox_change(&live);
            let Ok(body) = sync::verify(s, key, &change) else {
                continue;
            };
            if body["table"] == "account_file_manifests" {
                if let Some(list) = body["row"]["chunks_json"].as_str() {
                    chunks.extend(chunk_ids(list));
                }
            }
        }
        let mut tx = pool.begin().await?;
        for id in chunks.iter().filter(|id| !kept.contains(*id)) {
            planned += query("INSERT OR IGNORE INTO account_blob_releases(blob_id,reason,not_before) VALUES(?,'deleted file',?)")
                .bind(id)
                .bind(not_before)
                .execute(&mut *tx)
                .await?
                .rows_affected() as usize;
        }
        query("INSERT INTO account_storage_settled(object_id,revision) VALUES(?,?) ON CONFLICT(object_id) DO UPDATE SET revision=excluded.revision")
            .bind(&object_id)
            .bind(&tombstone)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    Ok(planned)
}

/// Chunks the service holds that no manifest anywhere names: uploads that
/// never finished, files an older app dropped. Run only when every app on
/// the account checks its chunks before sending a manifest (the format
/// gate), so a manifest still waiting on another device repairs itself.
async fn plan_sweep(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    urgent: bool,
) -> Result<usize, AppError> {
    let due = query("SELECT 1 FROM account_storage_state WHERE id=1 AND last_sweep_at<=?")
        .bind(now() - SWEEP_EVERY_SECONDS)
        .fetch_optional(pool)
        .await?
        .is_some();
    if !due && !urgent {
        return Ok(0);
    }
    let kept = referenced(pool, s, key).await?;
    let horizon = chrono::Utc::now() - chrono::Duration::days(SWEEP_GRACE_DAYS);
    let mut after: Option<String> = None;
    let mut planned = 0;
    for _ in 0..200 {
        let path = match &after {
            Some(id) => format!("/api/v1/blobs?limit=1000&after={id}"),
            None => "/api/v1/blobs?limit=1000".to_string(),
        };
        let page = call(s, reqwest::Method::GET, &path, None).await?;
        let blobs = page["blobs"].as_array().cloned().unwrap_or_default();
        let mut tx = pool.begin().await?;
        for blob in &blobs {
            let Some(id) = blob["id"].as_str() else {
                continue;
            };
            let old = blob["created_at"]
                .as_str()
                .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
                .is_some_and(|at| at < horizon);
            if old && blob["shared"] != true && !kept.contains(id) {
                planned += query("INSERT OR IGNORE INTO account_blob_releases(blob_id,reason,not_before) VALUES(?,'unnamed chunk',?)")
                    .bind(id)
                    .bind(now() + SWEEP_DELAY_SECONDS)
                    .execute(&mut *tx)
                    .await?
                    .rows_affected() as usize;
            }
        }
        tx.commit().await?;
        after = blobs
            .last()
            .and_then(|b| b["id"].as_str())
            .map(str::to_string);
        if page["has_more"] != true || after.is_none() {
            break;
        }
    }
    query("UPDATE account_storage_state SET last_sweep_at=? WHERE id=1")
        .bind(now())
        .execute(pool)
        .await?;
    Ok(planned)
}

/// Gives back the chunks whose time has come, checking each one against
/// what this device names right now. Returns the bytes the service freed.
async fn drain(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    deadline: Instant,
) -> Result<i64, AppError> {
    let due: Vec<String> = query(
        "SELECT blob_id FROM account_blob_releases WHERE not_before<=? ORDER BY not_before LIMIT ?",
    )
    .bind(now())
    .bind(RELEASE_BATCH)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|r| r.get("blob_id"))
    .collect();
    if due.is_empty() {
        return Ok(0);
    }
    let kept = referenced(pool, s, key).await?;
    let mut freed = 0;
    for group in due.chunks(100) {
        if Instant::now() >= deadline {
            break;
        }
        // Asked first in one request, so a chunk another device already
        // released costs nothing more than its row here.
        let present = call(
            s,
            reqwest::Method::GET,
            &format!("/api/v1/blobs?ids={}", group.join(",")),
            None,
        )
        .await?;
        let present: HashSet<String> = present["blobs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|b| b["shared"] != true)
            .filter_map(|b| b["id"].as_str().map(str::to_string))
            .collect();
        for id in group {
            if present.contains(id) && !kept.contains(id) {
                if Instant::now() >= deadline {
                    return Ok(freed);
                }
                match call(
                    s,
                    reqwest::Method::DELETE,
                    &format!("/api/v1/blobs/{id}"),
                    None,
                )
                .await
                {
                    Ok(answer) => freed += answer["freed_bytes"].as_i64().unwrap_or(0),
                    // Gone already, or held by a share: either way not ours to free.
                    Err(e) if matches!(e.code.as_str(), "vault_not_found" | "account_conflict") => {
                    }
                    Err(e) => return Err(e),
                }
            }
            query("DELETE FROM account_blob_releases WHERE blob_id=?")
                .bind(id)
                .execute(pool)
                .await?;
        }
    }
    Ok(freed)
}

/// Whether the account stands above the urgent share of its quota.
async fn urgent(pool: &SqlitePool) -> Result<bool, AppError> {
    Ok(query("SELECT 1 FROM account_storage_state WHERE id=1 AND quota_bytes>0 AND used_bytes*100>=quota_bytes*?")
        .bind(URGENT_PERCENT)
        .fetch_optional(pool)
        .await?
        .is_some())
}

/// One pass of the room lane: read where the account stands, plan what
/// may go, give it back, and make one file smaller. `full` is set when the
/// service refused something for room during this pass. Room is best
/// effort: the caller logs a failure here and the pass goes on.
pub(super) async fn step(
    app: &AppHandle,
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    deadline: Instant,
    full: bool,
    caught_up: bool,
) -> Result<(), AppError> {
    let places = crate::app_paths::app_data_dir(app)
        .ok()
        .and_then(|root| crate::app_paths::AppPaths::from_data_dir(root).ok())
        .zip(crate::carpe_diem::media::artifacts_dir(app).ok());
    if let Some((paths, gallery)) = &places {
        super::compaction::repair(pool, s, key, paths, gallery, deadline).await?;
    }
    room(pool, s, key, deadline, full, caught_up).await?;
    if let Some((paths, gallery)) = &places {
        if format_v2(pool).await? && !files_held(pool).await? {
            super::compaction::step(pool, s, key, paths, gallery, deadline).await?;
        }
    }
    Ok(())
}

/// Reads where the account stands, plans what may go and gives it back.
/// Returns the bytes the service freed.
pub(super) async fn room(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    deadline: Instant,
    full: bool,
    caught_up: bool,
) -> Result<i64, AppError> {
    if let Err(e) = refresh_gate(pool, s).await {
        tracing::debug!(code=%e.code, "format gate not refreshed");
    }
    if let Err(e) = refresh_usage(pool, s, full).await {
        tracing::debug!(code=%e.code, "account storage not measured");
    }
    // Room another device gave back lifts a hold at once, not ten minutes on.
    lift_holds_with_room(pool).await?;
    // A file revision still waiting to apply may name a candidate: nothing
    // is planned or released until every one this device holds is applied.
    let settled = files_settled(pool).await?;
    if caught_up && settled {
        plan_deletions(pool, s, key).await?;
        if format_v2(pool).await? {
            let pressing = full || urgent(pool).await?;
            plan_sweep(pool, s, key, pressing).await?;
        }
    }
    let mut freed = if settled && caught_up {
        drain(pool, s, key, deadline).await?
    } else {
        0
    };
    // Not even a note can leave and nothing else is ready to go: this
    // device's own unfinished uploads are given back, and start over later.
    // Text comes before a file half sent.
    if freed == 0 && push_held(pool).await? && !releases_due(pool).await? {
        freed = give_back_unfinished(pool, s, deadline).await?;
    }
    if freed > 0 {
        release_holds(pool).await?;
        refresh_usage(pool, s, true).await.ok();
        super::poke();
    }
    Ok(freed)
}

/// Lifts a hold the last reading shows room for: a note needs little, a
/// file chunk a megabyte under the file limit.
async fn lift_holds_with_room(pool: &SqlitePool) -> Result<(), AppError> {
    query("UPDATE account_storage_state SET push_held_until=0 WHERE id=1 AND quota_bytes>0 AND used_bytes+1048576<=quota_bytes")
        .execute(pool)
        .await?;
    query("UPDATE account_storage_state SET files_held_until=0 WHERE id=1 AND quota_bytes>0 AND used_bytes+4194304<=quota_bytes-COALESCE(reserve_bytes,0)")
        .execute(pool)
        .await?;
    Ok(())
}

async fn releases_due(pool: &SqlitePool) -> Result<bool, AppError> {
    Ok(
        query("SELECT 1 FROM account_blob_releases WHERE not_before<=? LIMIT 1")
            .bind(now())
            .fetch_optional(pool)
            .await?
            .is_some(),
    )
}

/// Releases the chunks this device's unfinished uploads sent, and starts
/// them over under a new manifest id (so a derived chunk id is never asked
/// for again while its release drains). No manifest names them yet, and
/// no other device knows them.
async fn give_back_unfinished(
    pool: &SqlitePool,
    s: &Session,
    deadline: Instant,
) -> Result<i64, AppError> {
    let mut freed = 0;
    for row in query("SELECT artifact_id,chunks_json,pending_blob_id FROM account_file_uploads WHERE completed=0 AND (next_offset>0 OR pending_blob_id IS NOT NULL)")
        .fetch_all(pool)
        .await?
    {
        let mut ids = chunk_ids(&row.get::<String, _>("chunks_json"));
        ids.extend(row.get::<Option<String>, _>("pending_blob_id"));
        for id in &ids {
            if Instant::now() >= deadline {
                return Ok(freed);
            }
            match call(s, reqwest::Method::DELETE, &format!("/api/v1/blobs/{id}"), None).await {
                Ok(answer) => freed += answer["freed_bytes"].as_i64().unwrap_or(0),
                Err(e) if matches!(e.code.as_str(), "vault_not_found" | "account_conflict") => {}
                Err(e) => return Err(e),
            }
        }
        query("UPDATE account_file_uploads SET manifest_id=?,next_offset=0,chunks_json='[]',pending_blob_id=NULL,pending_ciphertext=NULL,pending_bytes=NULL,pending_digest=NULL,envelope=1 WHERE artifact_id=?")
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(row.get::<String, _>("artifact_id"))
            .execute(pool)
            .await?;
    }
    Ok(freed)
}

/// What a person reads about the account's room.
#[derive(Debug, Clone, Serialize, Default)]
pub struct StorageStatus {
    pub used_bytes: Option<i64>,
    pub quota_bytes: Option<i64>,
    pub file_bytes: Option<i64>,
    pub journal_reserve_bytes: Option<i64>,
    pub measured_at: Option<String>,
    /// Bytes of files in the account, by kind, as the manifests say.
    pub audio_bytes: i64,
    pub studio_bytes: i64,
    pub assistant_bytes: i64,
    pub largest: Vec<LargeFile>,
    /// Files that wait for room before they leave this device.
    pub waiting_files: i64,
    pub files_held: bool,
    pub journal_held: bool,
    pub releasing_chunks: i64,
    pub compact_ready: bool,
    /// Devices whose app is too old for compact copies.
    pub compact_blockers: Vec<String>,
    /// Files not yet in their compact form.
    pub compact_pending: i64,
    pub send_audio: bool,
    pub send_studio: bool,
}
#[derive(Debug, Clone, Serialize)]
pub struct LargeFile {
    pub artifact_id: String,
    pub kind: String,
    pub label: Option<String>,
    pub note_id: Option<String>,
    pub bytes: i64,
}

pub(super) async fn status(pool: &SqlitePool) -> Result<StorageStatus, AppError> {
    let state = query("SELECT * FROM account_storage_state WHERE id=1")
        .fetch_optional(pool)
        .await?;
    let mut status = StorageStatus {
        send_audio: true,
        send_studio: true,
        ..StorageStatus::default()
    };
    if let Some(r) = &state {
        status.used_bytes = r.get("used_bytes");
        status.quota_bytes = r.get("quota_bytes");
        status.file_bytes = r.get("file_bytes");
        status.journal_reserve_bytes = r.get("reserve_bytes");
        status.measured_at = r
            .get::<Option<i64>, _>("measured_at")
            .and_then(|t| chrono::DateTime::from_timestamp(t, 0))
            .map(|t| t.to_rfc3339());
        status.files_held = r.get::<i64, _>("files_held_until") > now();
        status.journal_held = r.get::<i64, _>("push_held_until") > now();
        status.compact_ready = r.get::<i64, _>("format_v2") == 1;
        status.compact_blockers =
            serde_json::from_str(&r.get::<String, _>("blockers_json")).unwrap_or_default();
        status.send_audio = r.get::<i64, _>("send_audio") == 1;
        status.send_studio = r.get::<i64, _>("send_studio") == 1;
    }
    for row in query("SELECT source_kind,COALESCE(SUM(bytes),0) AS n FROM account_file_manifests GROUP BY source_kind")
        .fetch_all(pool)
        .await?
    {
        let n: i64 = row.get("n");
        match row.get::<String, _>("source_kind").as_str() {
            "audio" => status.audio_bytes = n,
            "studio" => status.studio_bytes = n,
            "assistant" => status.assistant_bytes = n,
            _ => {}
        }
    }
    status.largest = query("SELECT m.artifact_id,m.source_kind,m.bytes,COALESCE(n.title,substr(f.prompt,1,80),r.file_name,f.file_name) AS label,a.note_id FROM account_file_manifests m LEFT JOIN account_studio_files f ON f.id=m.artifact_id LEFT JOIN audio_artifacts a ON a.id=m.artifact_id LEFT JOIN notes n ON n.id=a.note_id LEFT JOIN assistant_references r ON r.id=m.artifact_id ORDER BY m.bytes DESC LIMIT 10")
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|r| LargeFile {
            artifact_id: r.get("artifact_id"),
            kind: r.get("source_kind"),
            label: r.get("label"),
            note_id: r.get("note_id"),
            bytes: r.get("bytes"),
        })
        .collect();
    status.waiting_files =
        query("SELECT count(*) AS n FROM account_file_uploads WHERE completed=0")
            .fetch_one(pool)
            .await?
            .get("n");
    status.releasing_chunks = query("SELECT count(*) AS n FROM account_blob_releases")
        .fetch_one(pool)
        .await?
        .get("n");
    status.compact_pending = super::compaction::pending(pool).await?;
    Ok(status)
}

/// Whether this device sends new files of a kind to the account. Off, they
/// stay on this device; files already in the account keep syncing.
pub(super) async fn set_sending(pool: &SqlitePool, kind: &str, on: bool) -> Result<(), AppError> {
    let column = match kind {
        "audio" => "send_audio",
        "studio" => "send_studio",
        _ => return Err(error("account_invalid_request")),
    };
    query(&format!(
        "UPDATE account_storage_state SET {column}=? WHERE id=1"
    ))
    .bind(on)
    .execute(pool)
    .await?;
    Ok(())
}
pub(super) async fn sending(pool: &SqlitePool, kind: &str) -> Result<bool, AppError> {
    let column = if kind == "audio" {
        "send_audio"
    } else {
        "send_studio"
    };
    Ok(query(&format!(
        "SELECT {column} AS on_ FROM account_storage_state WHERE id=1"
    ))
    .fetch_optional(pool)
    .await?
    .map_or(true, |r| r.get::<i64, _>("on_") == 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_app_not_revoked_holds_the_new_format_back_until_it_is_current() {
        let seen = chrono::Utc::now().to_rfc3339();
        let long_ago = (chrono::Utc::now() - chrono::Duration::days(90)).to_rfc3339();
        let devices = vec![
            json!({"name":"Mac","kind":"native","revoked_at":null,"last_seen_at":seen,"app_version":"1.91.0"}),
            json!({"name":"Phone","kind":"native","revoked_at":null,"last_seen_at":seen,"app_version":"1.90.0"}),
            json!({"name":"Tablet","kind":"native","revoked_at":null,"last_seen_at":seen}),
            json!({"name":"Old laptop","kind":"native","revoked_at":null,"last_seen_at":long_ago}),
            json!({"name":"Gone","kind":"native","revoked_at":seen,"last_seen_at":seen}),
            json!({"name":"Browser","kind":"browser","revoked_at":null,"last_seen_at":seen}),
            json!({"name":"Future","kind":"native","revoked_at":null,"last_seen_at":seen,"app_version":"2.0.1"}),
        ];
        assert_eq!(
            format_blockers(&devices),
            vec!["Phone", "Tablet", "Old laptop"]
        );
        assert!(format_blockers(&devices[..1]).is_empty());
    }

    #[test]
    fn versions_compare_as_numbers_and_malformed_ones_never_pass() {
        assert_eq!(parse_version("1.91.0"), Some((1, 91, 0)));
        assert!(parse_version("1.100.0") > parse_version("1.91.9"));
        for bad in ["1.91", "1.91.0.1", "1.x.0", ""] {
            assert_eq!(parse_version(bad), None, "{bad}");
        }
    }

    #[test]
    fn chunk_ids_read_a_manifest_and_an_unreadable_one_names_nothing() {
        assert_eq!(
            chunk_ids(r#"[{"id":"a","bytes":1,"sha256":"x"},{"id":"b","bytes":2,"sha256":"y"}]"#),
            vec!["a", "b"]
        );
        assert!(chunk_ids("not json").is_empty());
    }
}
