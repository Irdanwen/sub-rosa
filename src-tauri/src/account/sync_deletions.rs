//! Deletions and what they take (ADR-0072, ADR-0108): whether one applies
//! here, how it is applied, the cards it settles, and the list of what can
//! be brought back. Split out of `sync`, which re-exports these.
use super::sync::{
    aad, apply, conflict_change, head_of, pending_unparked, resolve_in_store, table, verify, Change,
};
use super::*;
use sqlx_sqlite::SqliteConnection;

/// A live sibling older than this device's own deletion of the object: the
/// other device had not seen the deletion, this device has nothing of the
/// object left to keep, and the service will settle it with a tombstone that
/// names the sibling. It happens when a tombstone was sealed before a push
/// that failed, so it left with a parent older than what had arrived.
pub(super) async fn settle_edits_older_than_a_local_deletion(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
) {
    let rows = match query("SELECT c.id FROM account_sync_conflicts c JOIN account_sync_heads h ON h.object_id=c.object_id JOIN account_sync_inbox i ON i.revision=h.revision WHERE c.resolved=0 AND c.deleted=0 AND i.deleted=1 AND c.id<h.revision AND NOT EXISTS(SELECT 1 FROM account_sync_outbox o WHERE o.object_id=c.object_id) ORDER BY c.created_at LIMIT 50")
        .fetch_all(pool)
        .await
    {
        Ok(rows) => rows,
        Err(failure) => {
            tracing::warn!(%failure,"stale sibling scan deferred");
            return;
        }
    };
    for row in rows {
        let id: String = row.get("id");
        if let Err(failure) = resolve_in_store(pool, s, key, &id, "keep_local").await {
            if failure.code != "sync_pending_changes" {
                tracing::warn!(code=%failure.code,"stale sibling deferred");
            }
        }
    }
}

/// A sibling that says exactly what this device already holds is not a
/// disagreement, and asking a person to review it is noise. It happens
/// whenever two devices send the same content from the same parent: a memory
/// re-sent after a local-only write, a setting touched twice. Keeping the
/// local copy acknowledges the sibling, so the other devices converge too.
/// Deletions and real differences stay for review.
/// The tables a deletion of `table` takes with it, by the column that names
/// the parent.
fn children_of(table: &str) -> &'static [(&'static str, &'static str)] {
    match table {
        "notes" => &[
            ("recording_sessions", "note_id"),
            ("audio_artifacts", "note_id"),
            ("transcripts", "note_id"),
        ],
        "agent_tasks" => &[("agent_messages", "task_id")],
        _ => &[],
    }
}
/// Whether a remote deletion applies here (ADR-0108). It does when nothing
/// of the object waits to leave (the caller checked), the deletion is at
/// least as recent as what this device holds, and no child carries work the
/// deleting device never saw.
///
/// "At least as recent": its parent is the local head, or it acknowledged
/// the head, or it was minted after the head. Revisions are time-ordered
/// identifiers the service mints, so the last test is one comparison and
/// needs no clock of this device's own. A deletion older than the head means
/// someone edited after it was decided; that stays a question for a person.
///
/// Children are looked up by their foreign key: a child with an unsent
/// local change, or a head revision later than the tombstone, is a
/// disagreement. Objects without children are always clean on that count.
pub(super) async fn deletion_applies(
    conn: &mut SqliteConnection,
    table: &str,
    c: &Change,
    head: Option<&str>,
) -> Result<bool, AppError> {
    let settled = match head {
        None => true,
        Some(h) => {
            h == c.revision
                || c.parent_revision.as_deref() == Some(h)
                || c.resolved_revisions.iter().any(|r| r == h)
                || h < c.revision.as_str()
        }
    };
    if !settled {
        return Ok(false);
    }
    for (child, column) in children_of(table) {
        let newer = query(&format!("SELECT 1 FROM {child} ch WHERE ch.{column}=? AND (EXISTS(SELECT 1 FROM account_sync_outbox o WHERE o.object_id=ch.id AND NOT EXISTS(SELECT 1 FROM account_sync_issues i WHERE i.lane='outbox' AND i.item_id=o.operation_id)) OR EXISTS(SELECT 1 FROM account_sync_heads h WHERE h.object_id=ch.id AND h.revision>?)) LIMIT 1"))
            .bind(&c.object_id)
            .bind(&c.revision)
            .fetch_optional(&mut *conn)
            .await?;
        if newer.is_some() {
            return Ok(false);
        }
    }
    Ok(true)
}
/// Applies a deletion that `deletion_applies` admitted: the rows go the way
/// this device's own delete takes them, the rows of the object parked by an
/// issue go too (retried later, they would come back as children of the
/// tombstone and bring the object back everywhere), and the inbox rows of
/// its children that were waiting for it are history now.
pub(super) async fn apply_deletion(
    conn: &mut SqliteConnection,
    table: &str,
    object_id: &str,
) -> Result<(), AppError> {
    let mut children = Vec::new();
    for (child, column) in children_of(table) {
        let rows = query(&format!("SELECT id FROM {child} WHERE {column}=?"))
            .bind(object_id)
            .fetch_all(&mut *conn)
            .await?;
        children.extend(rows.into_iter().map(|r| r.get::<String, _>("id")));
    }
    delete_locally(conn, table, object_id).await?;
    query("DELETE FROM account_sync_outbox WHERE object_id=? AND operation_id IN (SELECT item_id FROM account_sync_issues WHERE lane='outbox')")
        .bind(object_id)
        .execute(&mut *conn)
        .await?;
    query("DELETE FROM account_sync_issues WHERE lane='outbox' AND NOT EXISTS(SELECT 1 FROM account_sync_outbox o WHERE o.operation_id=item_id)")
        .execute(&mut *conn)
        .await?;
    for child in children {
        query("UPDATE account_sync_inbox SET applied=1 WHERE object_id=? AND applied=0")
            .bind(child)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}
/// Removes an object another device deleted, the way this device's own delete
/// would. Callers hold `applying=1`, so no outbox row echoes the deletion. A
/// database connection knows nothing of the app's directories, so files the
/// rows pointed at are queued for the file lane rather than removed here.
pub(super) async fn delete_locally(
    conn: &mut SqliteConnection,
    table: &str,
    id: &str,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().to_rfc3339();
    match table {
        "notes" => {
            let paths = query("SELECT path FROM audio_artifacts WHERE note_id=? AND path<>''")
                .bind(id)
                .fetch_all(&mut *conn)
                .await?;
            for row in paths {
                queue_removed_file(conn, "recording", row.get("path"), &now).await?;
            }
            crate::db::repositories::delete_note_records(conn, id).await?;
            crate::spotlight::forget(std::slice::from_ref(&id.to_string()));
        }
        "agent_tasks" => {
            // The desktop keeps the chat in its own runtime too: the file
            // lane, which has the app, asks it to forget the session.
            let session: Option<String> =
                query("SELECT hermes_session_id FROM agent_tasks WHERE id=?")
                    .bind(id)
                    .fetch_optional(&mut *conn)
                    .await?
                    .and_then(|row| row.get("hermes_session_id"));
            if let Some(session) = session.filter(|s| !s.is_empty()) {
                queue_removed_file(conn, "hermes-session", session, &now).await?;
            }
            for sql in [
                "DELETE FROM agent_tool_events WHERE task_id=?",
                "DELETE FROM agent_messages WHERE task_id=?",
                "DELETE FROM session_folders WHERE session_id=?",
                "DELETE FROM assistant_conversations WHERE task_id=?",
                "DELETE FROM agent_tasks WHERE id=?",
            ] {
                query(sql).bind(id).execute(&mut *conn).await?;
            }
        }
        "audio_artifacts" => {
            let path: Option<String> = query("SELECT path FROM audio_artifacts WHERE id=?")
                .bind(id)
                .fetch_optional(&mut *conn)
                .await?
                .map(|row| row.get("path"));
            if let Some(path) = path.filter(|p| !p.is_empty()) {
                queue_removed_file(conn, "recording", path, &now).await?;
            }
            query("DELETE FROM audio_artifacts WHERE id=?")
                .bind(id)
                .execute(&mut *conn)
                .await?;
        }
        "account_studio_files" | "assistant_references" | "project_files" => {
            let lane = if table == "account_studio_files" {
                "studio"
            } else {
                "assistant"
            };
            let name: Option<String> = query(&format!("SELECT file_name FROM {table} WHERE id=?"))
                .bind(id)
                .fetch_optional(&mut *conn)
                .await?
                .map(|row| row.get("file_name"));
            if let Some(name) = name.filter(|n| !n.is_empty()) {
                if lane == "studio" {
                    // What this device filed about the file goes with it: its
                    // mark (or a later folder change would revive it as a
                    // child of the tombstone), its provenance, and a download
                    // of it still under way, which would otherwise finish and
                    // put the file back after the deletion.
                    query("DELETE FROM studio_marks WHERE file_id=?")
                        .bind(id)
                        .execute(&mut *conn)
                        .await?;
                    query("DELETE FROM studio_artifact_metadata WHERE id=?")
                        .bind(&name)
                        .execute(&mut *conn)
                        .await?;
                    let manifests: Vec<String> =
                        query("SELECT id FROM account_file_manifests WHERE artifact_id=?")
                            .bind(id)
                            .fetch_all(&mut *conn)
                            .await?
                            .into_iter()
                            .map(|row| row.get("id"))
                            .collect();
                    for manifest in manifests {
                        query("DELETE FROM account_file_downloads WHERE manifest_id=?")
                            .bind(&manifest)
                            .execute(&mut *conn)
                            .await?;
                        queue_removed_file(conn, "staging", format!("{manifest}.part"), &now)
                            .await?;
                    }
                }
                queue_removed_file(conn, lane, name, &now).await?;
            }
            query(&format!("DELETE FROM {table} WHERE id=?"))
                .bind(id)
                .execute(&mut *conn)
                .await?;
        }
        "account_session_folders" => super::session_folders::delete_locally(conn, id).await?,
        // A connector is deleted by its object, and what this device kept
        // about it goes with it, as its own removal would take it. Its
        // keychain entries are this device's, and a sign-in reuses them.
        "connectors" => {
            for sql in [
                "DELETE FROM connector_state WHERE connector_id IN (SELECT id FROM connectors WHERE object_id=?)",
                "DELETE FROM connector_triggers WHERE connector_id IN (SELECT id FROM connectors WHERE object_id=?)",
                "DELETE FROM connectors WHERE object_id=?",
            ] {
                query(sql).bind(id).execute(&mut *conn).await?;
            }
        }
        "account_note_folders" => {
            query("DELETE FROM note_folders WHERE (note_id,folder_id) IN (SELECT note_id,folder_id FROM account_note_folders WHERE id=?)")
                .bind(id)
                .execute(&mut *conn)
                .await?;
            query("DELETE FROM account_note_folders WHERE id=?")
                .bind(id)
                .execute(&mut *conn)
                .await?;
        }
        _ => {
            let t = self::table(table)?;
            query(&format!("DELETE FROM {} WHERE id=?", t.name))
                .bind(id)
                .execute(&mut *conn)
                .await?;
        }
    }
    Ok(())
}
async fn queue_removed_file(
    conn: &mut SqliteConnection,
    lane: &str,
    path: String,
    now: &str,
) -> Result<(), AppError> {
    query("INSERT INTO account_sync_removed_files(lane,path,created_at) VALUES(?,?,?)")
        .bind(lane)
        .bind(path)
        .bind(now)
        .execute(conn)
        .await?;
    Ok(())
}
/// Cards written for deletions that apply themselves today (ADR-0108): the
/// tombstone is at least as recent as the local head, nothing of the object
/// waits to leave, no child was revised since. Each is applied the way the
/// deletion would have been on arrival, the head moves to the tombstone,
/// and nothing is sent: the service holds that deletion already. A divergent
/// card (unsent work here, or an edit newer than the deletion) is left for
/// the person. Returns how many were settled.
pub(super) async fn settle_clean_deletions(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
) -> Result<usize, AppError> {
    let rows = query("SELECT c.* FROM account_sync_conflicts c WHERE c.resolved=0 AND c.deleted=1 AND NOT EXISTS(SELECT 1 FROM account_sync_outbox o WHERE o.object_id=c.object_id AND NOT EXISTS(SELECT 1 FROM account_sync_issues i WHERE i.lane='outbox' AND i.item_id=o.operation_id)) ORDER BY c.created_at LIMIT 200")
        .fetch_all(pool)
        .await?;
    let mut settled = 0;
    for row in rows {
        let c = conflict_change(&row)?;
        let Ok(body) = verify(s, key, &c) else {
            continue;
        };
        let Some(name) = body["table"].as_str() else {
            continue;
        };
        if name == "carpe_diem_settings" {
            continue;
        }
        let table = table(name)?.name;
        let mut tx = pool.begin().await?;
        let head = head_of(&mut tx, &c.object_id).await?;
        if !deletion_applies(&mut tx, table, &c, head.as_deref()).await? {
            continue;
        }
        query("UPDATE account_sync_control SET applying=1 WHERE id=1")
            .execute(&mut *tx)
            .await?;
        apply_deletion(&mut tx, table, &c.object_id).await?;
        query("UPDATE account_sync_control SET applying=0 WHERE id=1")
            .execute(&mut *tx)
            .await?;
        query("INSERT INTO account_sync_heads(object_id,revision,kind) VALUES(?,?,?) ON CONFLICT(object_id) DO UPDATE SET revision=excluded.revision,kind=excluded.kind").bind(&c.object_id).bind(&c.revision).bind(&c.kind).execute(&mut *tx).await?;
        query("UPDATE account_sync_conflicts SET resolved=1 WHERE id=?")
            .bind(&c.revision)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        settled += 1;
    }
    Ok(settled)
}
/// Days a deletion stays listed, and restorable, after it was decided.
const RECENTLY_DELETED_DAYS: i64 = 30;

/// Something a deletion took, as the account panel lists it (ADR-0108).
#[derive(Serialize, Clone, Debug)]
pub struct DeletedItem {
    pub object_id: String,
    pub kind: String,
    pub title: String,
    pub deleted_at: String,
}

/// When a time-ordered revision was minted, as the service mints them.
fn revision_time(revision: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let (seconds, nanos) = uuid::Uuid::parse_str(revision)
        .ok()?
        .get_timestamp()?
        .to_unix();
    chrono::DateTime::from_timestamp(i64::try_from(seconds).ok()?, nanos)
}

fn item_title(row: &Value) -> String {
    ["title", "name", "text", "content", "edited_content"]
        .iter()
        .filter_map(|field| row[*field].as_str())
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(|s| {
            s.lines()
                .next()
                .unwrap_or_default()
                .chars()
                .take(120)
                .collect()
        })
        .unwrap_or_default()
}

/// The last live revision of an object this device holds as deleted, if the
/// journal still has one it can read.
async fn last_live_revision(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    object_id: &str,
    before: i64,
) -> Result<Option<(Change, Value)>, AppError> {
    let rows = query("SELECT * FROM account_sync_inbox WHERE object_id=? AND deleted=0 AND sequence<? ORDER BY sequence DESC LIMIT 5")
        .bind(object_id)
        .bind(before)
        .fetch_all(pool)
        .await?;
    for r in rows {
        let c = Change {
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
        };
        if let Ok(body) = verify(s, key, &c) {
            if matches!(body["table"].as_str(), Some("notes" | "memories")) {
                return Ok(Some((c, body)));
            }
        }
    }
    Ok(None)
}

/// Notes and memories a deletion took in the last thirty days, read from
/// the journal this device keeps: the tombstone that is the head, and the
/// last live revision before it. Nothing is listed that is back already.
pub(super) async fn recently_deleted(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
) -> Result<Vec<DeletedItem>, AppError> {
    let rows = query("SELECT h.object_id,h.kind,i.revision,i.sequence FROM account_sync_heads h JOIN account_sync_inbox i ON i.revision=h.revision WHERE i.deleted=1 AND h.kind IN ('note','memory') ORDER BY i.sequence DESC LIMIT 500")
        .fetch_all(pool)
        .await?;
    let horizon = chrono::Utc::now() - chrono::Duration::days(RECENTLY_DELETED_DAYS);
    let mut items = Vec::new();
    for row in rows {
        let object_id: String = row.get("object_id");
        let kind: String = row.get("kind");
        let revision: String = row.get("revision");
        let Some(at) = revision_time(&revision) else {
            continue;
        };
        if at < horizon {
            continue;
        }
        let table = if kind == "note" { "notes" } else { "memories" };
        let present = query(&format!("SELECT 1 FROM {table} WHERE id=?"))
            .bind(&object_id)
            .fetch_optional(pool)
            .await?
            .is_some();
        if present {
            continue;
        }
        let Some((_, body)) =
            last_live_revision(pool, s, key, &object_id, row.get("sequence")).await?
        else {
            continue;
        };
        items.push(DeletedItem {
            object_id,
            kind,
            title: item_title(&body["row"]),
            deleted_at: at.to_rfc3339(),
        });
        if items.len() >= 200 {
            break;
        }
    }
    Ok(items)
}

/// Brings a deleted note or memory back, on every device: its last live
/// revision is written here again and leaves as a child of the tombstone,
/// which every other device holds as the head and so applies. Children of a
/// note (recordings, transcripts) are not brought back; the text is.
pub(super) async fn restore_deleted(
    pool: &SqlitePool,
    s: &Session,
    key: &[u8; 32],
    object_id: &str,
) -> Result<(), AppError> {
    let head = query("SELECT i.revision,i.sequence,i.kind FROM account_sync_heads h JOIN account_sync_inbox i ON i.revision=h.revision WHERE h.object_id=? AND i.deleted=1")
        .bind(object_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| error("sync_not_deleted"))?;
    let tombstone: String = head.get("revision");
    let kind: String = head.get("kind");
    let (live, body) = last_live_revision(pool, s, key, object_id, head.get("sequence"))
        .await?
        .ok_or_else(|| error("sync_restore_unavailable"))?;
    let mut tx = pool.begin().await?;
    if pending_unparked(&mut tx, object_id).await? {
        return Err(error("sync_pending_changes"));
    }
    let restored = Change {
        deleted: false,
        ..live
    };
    if !apply(&mut tx, &restored, &body).await? {
        return Err(error("sync_dependencies_pending"));
    }
    let op = uuid::Uuid::new_v4().to_string();
    let mut chosen = body;
    chosen["operation_id"] = json!(op);
    chosen["parent_revision"] = json!(tombstone);
    chosen["resolved_revisions"] = json!([]);
    chosen["deleted"] = json!(false);
    let encoded =
        Zeroizing::new(serde_json::to_vec(&chosen).map_err(|_| error("sync_format_invalid"))?);
    let ciphertext = crypto::seal(key, &aad(s, &kind, object_id), &encoded)?;
    query("INSERT INTO account_sync_outbox(operation_id,object_id,kind,body,deleted,ciphertext,parent_revision,resolved_revisions) VALUES(?,?,?,'{}',0,?,?,'[]')")
        .bind(op)
        .bind(object_id)
        .bind(&kind)
        .bind(ciphertext)
        .bind(&tombstone)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
