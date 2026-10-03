//! Items synchronisation set aside rather than retried forever: an object too
//! large to send, a file that changed or is gone, a chunk the service could
//! not serve. They are listed for the person, retried on request, and the
//! transient ones let back in the queue after a while. Split out of `sync`
//! as a self-contained part of it; `sync` re-exports everything here.
use super::*;

#[derive(Serialize)]
pub struct SyncIssue {
    pub lane: String,
    pub item_id: String,
    pub code: String,
    pub created_at: String,
    pub label: Option<String>,
}

pub(super) async fn issues(pool: &SqlitePool) -> Result<Vec<SyncIssue>, AppError> {
    reconcile_issues(pool).await?;
    let rows = query(
        "SELECT lane,item_id,code,created_at FROM account_sync_issues ORDER BY created_at LIMIT 50",
    )
    .fetch_all(pool)
    .await?;
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let lane: String = row.get("lane");
        let item_id: String = row.get("item_id");
        let label = match lane.as_str() {
            "outbox" => query("SELECT n.title AS label FROM account_sync_outbox o JOIN notes n ON n.id=o.object_id WHERE o.operation_id=?")
                .bind(&item_id).fetch_optional(pool).await?
                .map(|row| row.get::<String, _>("label")),
            "upload" => query("SELECT file_name AS label FROM account_studio_files WHERE id=?")
                .bind(&item_id).fetch_optional(pool).await?
                .map(|row| row.get::<String, _>("label")),
            "download" => query("SELECT COALESCE(s.file_name,n.title,r.file_name) AS label FROM account_file_manifests m LEFT JOIN account_studio_files s ON s.id=m.artifact_id LEFT JOIN audio_artifacts a ON a.id=m.artifact_id LEFT JOIN notes n ON n.id=a.note_id LEFT JOIN assistant_references r ON r.id=m.artifact_id WHERE m.id=?")
                .bind(&item_id).fetch_optional(pool).await?
                .and_then(|row| row.get::<Option<String>, _>("label")),
            _ => None,
        };
        items.push(SyncIssue {
            lane,
            item_id,
            code: row.get("code"),
            created_at: row.get("created_at"),
            label,
        });
    }
    Ok(items)
}

pub(super) async fn issue_count(pool: &SqlitePool) -> Result<i64, AppError> {
    reconcile_issues(pool).await?;
    Ok(query("SELECT count(*) AS n FROM account_sync_issues")
        .fetch_one(pool)
        .await?
        .get("n"))
}

/// Minutes a chunk the service could not serve waits before the lane tries it
/// again. Long enough that a storage allowance exhausted for the day is not
/// hammered every five seconds, short enough that a raised allowance or a
/// recovered network is noticed within a coffee break.
const TRANSIENT_FILE_RETRY_MINUTES: f64 = 10.0;

pub(super) async fn reconcile_issues(pool: &SqlitePool) -> Result<(), AppError> {
    query("DELETE FROM account_sync_issues WHERE (lane='outbox' AND NOT EXISTS(SELECT 1 FROM account_sync_outbox o WHERE o.operation_id=item_id)) OR (lane='upload' AND NOT EXISTS(SELECT 1 FROM account_file_uploads u WHERE u.artifact_id=item_id AND u.completed=0) AND NOT EXISTS(SELECT 1 FROM audio_artifacts a WHERE a.id=item_id AND a.path<>'' AND a.status='valid' AND NOT EXISTS(SELECT 1 FROM account_file_manifests m WHERE m.artifact_id=a.id))) OR (lane='download' AND NOT EXISTS(SELECT 1 FROM account_file_manifests m WHERE m.id=item_id))")
        .execute(pool)
        .await?;
    query("DELETE FROM account_sync_issues WHERE lane IN ('upload','download') AND code IN ('sync_storage_limited','sync_blob_missing','sync_blob_request_failed','account_network') AND julianday(created_at) < julianday('now') - ?/1440.0")
        .bind(TRANSIENT_FILE_RETRY_MINUTES)
        .execute(pool)
        .await?;
    Ok(())
}

pub(super) async fn record_issue(
    pool: &SqlitePool,
    lane: &str,
    item_id: &str,
    code: &str,
) -> Result<(), AppError> {
    query("INSERT INTO account_sync_issues(lane,item_id,code,created_at) VALUES(?,?,?,?) ON CONFLICT(lane,item_id) DO UPDATE SET code=excluded.code")
        .bind(lane)
        .bind(item_id)
        .bind(code)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(pool)
        .await?;
    Ok(())
}

pub(super) async fn retry_issues(pool: &SqlitePool) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;
    // These validations happen before HTTP. A newer snapshot of the same
    // local object supersedes one that never left this device.
    query("DELETE FROM account_sync_outbox WHERE operation_id IN (SELECT i.item_id FROM account_sync_issues i JOIN account_sync_outbox old ON old.operation_id=i.item_id WHERE i.lane='outbox' AND i.code IN ('sync_object_too_large','sync_local_object_invalid') AND EXISTS(SELECT 1 FROM account_sync_outbox newer WHERE newer.object_id=old.object_id AND newer.sequence>old.sequence))")
        .execute(&mut *tx)
        .await?;
    // A changed file needs a new manifest and fresh immutable chunk ids.
    query("DELETE FROM account_file_uploads WHERE artifact_id IN (SELECT item_id FROM account_sync_issues WHERE lane='upload' AND code='sync_file_changed')")
        .execute(&mut *tx)
        .await?;
    query("DELETE FROM account_sync_issues")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub(super) fn isolatable_outbox_error(code: &str) -> bool {
    matches!(code, "sync_object_too_large" | "sync_local_object_invalid")
}

pub(super) fn isolatable_file_error(code: &str) -> bool {
    matches!(
        code,
        "sync_file_unavailable"
            | "sync_file_changed"
            | "sync_file_too_large"
            | "sync_file_type_unsupported"
            | "sync_blob_invalid"
    ) || transient_file_error(code)
}

/// A chunk the service could not serve right now: storage over its daily
/// allowance, a blob that is not there yet, a network that dropped. The
/// manifest steps aside so the files behind it keep moving, and
/// `reconcile_issues` lets it back in the queue after a while.
pub(super) fn transient_file_error(code: &str) -> bool {
    matches!(
        code,
        "sync_storage_limited"
            | "sync_blob_missing"
            | "sync_blob_request_failed"
            | "account_network"
    )
}
