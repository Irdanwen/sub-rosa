//! The sending half of a pass (ADR-0109): rows sealed in one transaction,
//! sent as one batch, a refused batch isolated row by row. Split out of
//! `sync`, which re-exports what the rest of the module calls.
use super::sync::{aad, head_of, resolve_cards_of, PushResults, Summary};
use super::sync_issues::{isolatable_outbox_error, record_issue, record_issue_on};
use super::*;
use sqlx_sqlite::SqliteConnection;

/// Operations one push carries at most, and the ciphertext it may total.
/// The service allows 100 and four MiB; staying under both leaves room for
/// the envelope and keeps a refused batch cheap to isolate.
const BATCH_OPERATIONS: usize = 50;
const BATCH_BYTES: usize = 4 * 1024 * 1024 - 64 * 1024;
const OPERATION_BYTES: usize = 1024 * 1024;

/// A row sealed and ready to leave: its ciphertext is frozen under its
/// operation id, so a retry sends the same bytes.
struct Sealed {
    sequence: i64,
    operation_id: String,
    object_id: String,
    kind: String,
    deleted: bool,
    ciphertext: String,
    parent: Option<String>,
    resolved: Vec<String>,
}

pub(super) async fn next_outbox(
    pool: &SqlitePool,
    object_filter: Option<&str>,
) -> Result<Option<sqlx_sqlite::SqliteRow>, AppError> {
    Ok(next_outbox_batch(pool, object_filter, 1).await?.pop())
}

/// The earliest row of each object with nothing earlier of its own, oldest
/// first, rows set aside by an issue excluded.
async fn next_outbox_batch(
    pool: &SqlitePool,
    object_filter: Option<&str>,
    limit: usize,
) -> Result<Vec<sqlx_sqlite::SqliteRow>, AppError> {
    Ok(query("SELECT o.* FROM account_sync_outbox o WHERE (?1 IS NULL OR o.object_id=?1) AND NOT EXISTS(SELECT 1 FROM account_sync_outbox earlier WHERE earlier.object_id=o.object_id AND earlier.sequence<o.sequence) AND NOT EXISTS(SELECT 1 FROM account_sync_issues issue WHERE issue.lane='outbox' AND issue.item_id=o.operation_id) ORDER BY o.sequence LIMIT ?2")
        .bind(object_filter)
        .bind(limit as i64)
        .fetch_all(pool)
        .await?)
}

/// Seals one outbox row inside the caller's transaction. `None` means the
/// row was rewritten by a newer edit between the read and the seal (the
/// triggers keep one unsent snapshot per object): sealing the stale body
/// would send it and drop the edit, so nothing is sealed and the row is read
/// again next time.
async fn seal(
    tx: &mut SqliteConnection,
    s: &Session,
    key: &[u8; 32],
    row: &sqlx_sqlite::SqliteRow,
) -> Result<Option<Sealed>, AppError> {
    let sequence: i64 = row.get("sequence");
    let resolved_revisions: Vec<String> =
        serde_json::from_str(&row.get::<String, _>("resolved_revisions"))
            .map_err(|_| error("sync_local_object_invalid"))?;
    let operation_id: String = row.get("operation_id");
    let id: String = row.get("object_id");
    let kind: String = row.get("kind");
    let deleted: bool = row.get("deleted");
    let existing: Option<String> = row.get("ciphertext");
    let (ciphertext, parent, resolved) = if let Some(ciphertext) = existing {
        (
            ciphertext,
            row.get::<Option<String>, _>("parent_revision"),
            resolved_revisions,
        )
    } else {
        let parent = head_of(tx, &id).await?;
        // A tombstone retires every sibling this device knows of (ADR-0108):
        // the person deleted the object, which answers each card about it.
        let resolved = if deleted && resolved_revisions.is_empty() {
            let siblings: Vec<String> = query("SELECT id FROM account_sync_conflicts WHERE object_id=? AND resolved=0 AND id<>? ORDER BY created_at LIMIT 64")
                .bind(&id)
                .bind(parent.as_deref().unwrap_or_default())
                .fetch_all(&mut *tx)
                .await?
                .into_iter()
                .map(|r| r.get::<String, _>("id"))
                .collect();
            siblings
        } else {
            resolved_revisions
        };
        let mut body: Value = serde_json::from_str(&row.get::<String, _>("body"))
            .map_err(|_| error("sync_local_object_invalid"))?;
        body["v"] = json!(1);
        body["operation_id"] = json!(operation_id);
        body["parent_revision"] = json!(parent);
        body["deleted"] = json!(deleted);
        body["resolved_revisions"] = json!(resolved);
        let clear = Zeroizing::new(
            serde_json::to_vec(&body).map_err(|_| error("sync_local_object_invalid"))?,
        );
        let ciphertext = crypto::seal(key, &aad(s, &kind, &id), &clear)?;
        let sealed = query("UPDATE account_sync_outbox SET ciphertext=?,parent_revision=?,resolved_revisions=? WHERE sequence=? AND ciphertext IS NULL AND body=?")
            .bind(&ciphertext)
            .bind(&parent)
            .bind(json!(resolved).to_string())
            .bind(sequence)
            .bind(row.get::<String, _>("body"))
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if sealed == 0 {
            return Ok(None);
        }
        // Only once the tombstone is frozen with their names: resolved
        // earlier, a seal that was skipped would have left them resolved and
        // the next seal would find none.
        if deleted && !resolved.is_empty() {
            resolve_cards_of(tx, &id).await?;
        }
        (ciphertext, parent, resolved)
    };
    if ciphertext.len() > OPERATION_BYTES {
        return Err(error("sync_object_too_large"));
    }
    Ok(Some(Sealed {
        sequence,
        operation_id,
        object_id: id,
        kind,
        deleted,
        ciphertext,
        parent,
        resolved,
    }))
}

/// Sends sealed rows as one push and records what the service answered:
/// each revision becomes this device's head and an inbox row already
/// applied, so its echo is skipped on the next pull, and the outbox row
/// goes. Even a sibling becomes this device's own head: the other branch is
/// retained as a card on pull, never silently applied over the local edit.
async fn post_batch(pool: &SqlitePool, s: &Session, sealed: &[Sealed]) -> Result<usize, AppError> {
    let operations: Vec<Value> = sealed
        .iter()
        .map(|item| json!({"operation_id":item.operation_id,"object_id":item.object_id,"parent_revision":item.parent,"kind":item.kind,"ciphertext":item.ciphertext,"deleted":item.deleted,"resolved_revisions":item.resolved}))
        .collect();
    let data = call(
        s,
        reqwest::Method::POST,
        "/api/v1/sync",
        Some(json!({"operations":operations})),
    )
    .await?;
    let result: PushResults =
        serde_json::from_value(data).map_err(|_| error("sync_format_invalid"))?;
    if result.results.len() != sealed.len() {
        return Err(error("sync_format_invalid"));
    }
    let mut tx = pool.begin().await?;
    for (item, answer) in sealed.iter().zip(&result.results) {
        if answer.operation_id != item.operation_id {
            return Err(error("sync_format_invalid"));
        }
        query("INSERT INTO account_sync_heads(object_id,revision,kind) VALUES(?,?,?) ON CONFLICT(object_id) DO UPDATE SET revision=excluded.revision,kind=excluded.kind").bind(&item.object_id).bind(&answer.revision).bind(&item.kind).execute(&mut *tx).await?;
        query("INSERT OR IGNORE INTO account_sync_inbox(revision,object_id,kind,ciphertext,parent_revision,operation_id,deleted,sequence,applied,resolved_revisions) VALUES(?,?,?,?,?,?,?,?,1,?)")
            .bind(&answer.revision).bind(&item.object_id).bind(&item.kind).bind(&item.ciphertext)
            .bind(&item.parent).bind(&item.operation_id).bind(item.deleted).bind(answer.sequence).bind(json!(item.resolved).to_string())
            .execute(&mut *tx).await?;
        query("DELETE FROM account_sync_outbox WHERE sequence=?")
            .bind(item.sequence)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(sealed.len())
}

/// What the service's refusal of one row becomes: an issue that sets the row
/// aside so the rows behind it leave. A parent it does not know (409) and a
/// request it will not take (400) are both re-sealed on retry.
fn refused(code: &str) -> Option<&'static str> {
    match code {
        "account_conflict" => Some("sync_parent_unknown"),
        "account_invalid_request" => Some("sync_request_refused"),
        _ => None,
    }
}

/// Sends what waits, a batch at a time (ADR-0109). A batch the service
/// refuses as a whole is sent row by row, so the one row it objects to is
/// set aside and the others leave.
pub(super) async fn push(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    summary: &mut Summary,
) -> Result<(), AppError> {
    for _ in 0..20 {
        let rows = next_outbox_batch(pool, None, BATCH_OPERATIONS).await?;
        if rows.is_empty() {
            break;
        }
        let mut sealed = Vec::new();
        let mut bytes = 0usize;
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        for row in &rows {
            let operation: String = row.get("operation_id");
            match seal(&mut tx, s, key, row).await {
                Ok(Some(item)) => {
                    if bytes + item.ciphertext.len() > BATCH_BYTES && !sealed.is_empty() {
                        break;
                    }
                    bytes += item.ciphertext.len();
                    sealed.push(item);
                }
                Ok(None) => {}
                Err(failure) if isolatable_outbox_error(&failure.code) => {
                    record_issue_on(&mut tx, "outbox", &operation, &failure.code).await?;
                }
                Err(failure) => return Err(failure),
            }
        }
        tx.commit().await?;
        if sealed.is_empty() {
            continue;
        }
        let kinds: Vec<String> = sealed.iter().map(|item| item.kind.clone()).collect();
        match post_batch(pool, s, &sealed).await {
            Ok(sent) => {
                summary.pushed += sent;
                for kind in kinds {
                    summary.note(&kind);
                }
            }
            Err(failure)
                if sealed.len() > 1
                    && matches!(
                        failure.code.as_str(),
                        "account_conflict" | "account_invalid_request"
                    ) =>
            {
                for item in sealed {
                    let kind = item.kind.clone();
                    match post_batch(pool, s, std::slice::from_ref(&item)).await {
                        Ok(_) => {
                            summary.pushed += 1;
                            summary.note(&kind);
                        }
                        Err(failure) if refused(&failure.code).is_some() => {
                            record_issue(
                                pool,
                                "outbox",
                                &item.operation_id,
                                refused(&failure.code).unwrap_or_default(),
                            )
                            .await?;
                        }
                        Err(failure) => return Err(failure),
                    }
                }
            }
            Err(failure) if refused(&failure.code).is_some() => {
                record_issue(
                    pool,
                    "outbox",
                    &sealed[0].operation_id,
                    refused(&failure.code).unwrap_or_default(),
                )
                .await?;
            }
            Err(failure) => return Err(failure),
        }
    }
    Ok(())
}

/// One row, the way `share_credential` sends its one object. Returns whether
/// something was sent or re-read; `Ok(false)` when nothing waits.
pub(super) async fn push_one(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    object_filter: Option<&str>,
) -> Result<bool, AppError> {
    let Some(row) = next_outbox(pool, object_filter).await? else {
        return Ok(false);
    };
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let sealed = match seal(&mut tx, s, key, &row).await {
        Ok(sealed) => sealed,
        // Sealed and too large: the ciphertext stays, so a retry does not
        // encrypt it again, and the caller hears why nothing left.
        Err(failure) if isolatable_outbox_error(&failure.code) => {
            tx.commit().await?;
            return Err(failure);
        }
        Err(failure) => return Err(failure),
    };
    tx.commit().await?;
    let Some(item) = sealed else {
        return Ok(true);
    };
    post_batch(pool, s, std::slice::from_ref(&item)).await?;
    Ok(true)
}

/// Whether anything waits to leave this device, so a tick can wake the
/// driver without a network request: unsent rows the issues did not park.
pub(super) async fn has_local_work(pool: &SqlitePool) -> Result<bool, AppError> {
    let enabled = query(
        "SELECT 1 FROM account_sync_control WHERE id=1 AND enabled=1 AND account_id IS NOT NULL",
    )
    .fetch_optional(pool)
    .await?
    .is_some();
    if !enabled {
        return Ok(false);
    }
    Ok(!next_outbox_batch(pool, None, 1).await?.is_empty() || super::files::has_work(pool).await?)
}
