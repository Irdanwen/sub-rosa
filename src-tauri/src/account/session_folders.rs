//! A chat's folders, synchronised (ADR-0080). The phone archives a chat by
//! filing it in the shared "Archive" folder, and the desktop now does the
//! same, so the membership has to travel for an archive on one device to show
//! on the other.
//!
//! `session_folders` keys a chat by whatever id the device knows it by: a
//! desktop chat by its Hermes session id, a phone chat by its task id. Only
//! the task id is shared (the portable conversation mirrors a Hermes session
//! into `agent_tasks` with `hermes_session_id` set), so the synchronised mirror,
//! `account_session_folders`, carries the task id whenever this device has one
//! and the session id otherwise. Reading back, the repository answers a
//! membership under both ids (`db::repositories::session_folders`), so each
//! shell finds its chats by the id it uses.

use super::*;
use serde_json::Map;
use sqlx_sqlite::SqliteConnection;

/// The id a session folder row travels under: the conversation's task id when
/// this device mirrored the Hermes session into one, the row's own id
/// otherwise. `column` is the SQL expression naming the local session id.
fn wire_id(column: &str) -> String {
    format!(
        "COALESCE((SELECT t.id FROM agent_tasks t WHERE t.hermes_session_id={column} LIMIT 1),{column})"
    )
}

/// The two triggers that mirror a local filing into the synchronised table.
/// They join the managed set, so an edit here reinstalls them on every
/// database. Gated like every other journal trigger: nothing is mirrored
/// before an account is bound or while a received change is being applied.
pub(super) fn triggers(uuid_sql: &str) -> Vec<(String, String)> {
    let gate =
        "(SELECT account_id IS NOT NULL AND applying=0 FROM account_sync_control WHERE id=1)";
    let new_id = wire_id("NEW.session_id");
    let old_id = wire_id("OLD.session_id");
    vec![
        (
            "account_session_membership_insert".to_string(),
            format!(
                "CREATE TRIGGER account_session_membership_insert AFTER INSERT ON session_folders WHEN {gate} BEGIN \
                 INSERT INTO account_session_folders(id,session_id,folder_id,assigned_at) SELECT {uuid_sql},{new_id},NEW.folder_id,NEW.assigned_at WHERE NOT EXISTS(SELECT 1 FROM account_session_folders WHERE session_id={new_id} AND folder_id=NEW.folder_id); \
                 UPDATE account_session_folders SET deleted=0,assigned_at=NEW.assigned_at WHERE session_id={new_id} AND folder_id=NEW.folder_id; END"
            ),
        ),
        (
            "account_session_membership_delete".to_string(),
            format!(
                "CREATE TRIGGER account_session_membership_delete AFTER DELETE ON session_folders WHEN {gate} BEGIN \
                 UPDATE account_session_folders SET deleted=1 WHERE folder_id=OLD.folder_id AND session_id IN (OLD.session_id,{old_id}); END"
            ),
        ),
    ]
}

/// What was filed before the account was bound, captured when sync turns on.
pub(super) async fn backfill(conn: &mut SqliteConnection, uuid_sql: &str) -> Result<(), AppError> {
    let wire = wire_id("sf.session_id");
    query(&format!(
        "INSERT INTO account_session_folders(id,session_id,folder_id,assigned_at) \
         SELECT {uuid_sql},w.sid,w.folder_id,w.assigned_at FROM \
         (SELECT {wire} AS sid,sf.folder_id AS folder_id,MIN(sf.assigned_at) AS assigned_at FROM session_folders sf GROUP BY sid,sf.folder_id) w \
         WHERE NOT EXISTS(SELECT 1 FROM account_session_folders s WHERE s.session_id=w.sid AND s.folder_id=w.folder_id)"
    ))
    .execute(conn)
    .await?;
    Ok(())
}

/// Applies a received membership to the local join table. The caller holds
/// `applying=1`, so nothing here is journalled back out. A removal clears the
/// row under the task id and under the Hermes session id this device files
/// the same chat by.
pub(super) async fn apply(
    conn: &mut SqliteConnection,
    row: &Map<String, Value>,
) -> Result<(), AppError> {
    let session_id = row.get("session_id").and_then(Value::as_str);
    let folder_id = row.get("folder_id").and_then(Value::as_str);
    let (Some(session_id), Some(folder_id)) = (session_id, folder_id) else {
        return Err(error("sync_format_invalid"));
    };
    if row.get("deleted").and_then(Value::as_i64).unwrap_or(0) != 0 {
        remove(conn, session_id, folder_id).await
    } else {
        query(
            "INSERT OR IGNORE INTO session_folders(session_id,folder_id,assigned_at) VALUES(?,?,?)",
        )
        .bind(session_id)
        .bind(folder_id)
        .bind(
            row.get("assigned_at")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .execute(conn)
        .await?;
        Ok(())
    }
}

/// Another device deleted the membership object itself.
pub(super) async fn delete_locally(conn: &mut SqliteConnection, id: &str) -> Result<(), AppError> {
    let pair = query("SELECT session_id,folder_id FROM account_session_folders WHERE id=?")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
    if let Some(pair) = pair {
        let session_id: String = pair.get("session_id");
        let folder_id: String = pair.get("folder_id");
        remove(conn, &session_id, &folder_id).await?;
    }
    query("DELETE FROM account_session_folders WHERE id=?")
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}

async fn remove(
    conn: &mut SqliteConnection,
    session_id: &str,
    folder_id: &str,
) -> Result<(), AppError> {
    query(
        "DELETE FROM session_folders WHERE folder_id=?2 AND (session_id=?1 OR session_id IN \
         (SELECT hermes_session_id FROM agent_tasks WHERE id=?1 AND hermes_session_id IS NOT NULL))",
    )
    .bind(session_id)
    .bind(folder_id)
    .execute(conn)
    .await?;
    Ok(())
}
