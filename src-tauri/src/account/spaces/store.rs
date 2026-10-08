//! The local side of shared projects: settings, the spaces this device knows,
//! the heads it verified, the members, decrypted objects, the outbox, the
//! owner's invitation secrets and the assistant turns waiting to run.
use super::protocol::{EpochHead, IdentityBundle, ObjectBody};
use crate::domain::types::AppError;
use serde_json::Value;
use sqlx::{query::query, row::Row};
use sqlx_sqlite::SqlitePool;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub struct Settings {
    pub enabled: bool,
    pub display_name: String,
    pub identity_json: Option<String>,
}
pub async fn settings(pool: &SqlitePool) -> Result<Settings, AppError> {
    let row = query("SELECT enabled,display_name,identity_json FROM space_settings WHERE id=1")
        .fetch_optional(pool)
        .await?;
    Ok(match row {
        Some(row) => Settings {
            enabled: row.get::<i64, _>("enabled") != 0,
            display_name: row.get("display_name"),
            identity_json: row.get("identity_json"),
        },
        None => Settings {
            enabled: false,
            display_name: String::new(),
            identity_json: None,
        },
    })
}
pub async fn save_settings(
    pool: &SqlitePool,
    enabled: bool,
    display_name: &str,
) -> Result<(), AppError> {
    query("INSERT INTO space_settings(id,enabled,display_name) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,display_name=excluded.display_name")
        .bind(i64::from(enabled))
        .bind(display_name)
        .execute(pool)
        .await?;
    Ok(())
}
pub async fn cache_identity(pool: &SqlitePool, bundle: &IdentityBundle) -> Result<(), AppError> {
    let json = serde_json::to_string(bundle).unwrap_or_default();
    query("INSERT INTO space_settings(id,identity_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET identity_json=excluded.identity_json")
        .bind(json)
        .execute(pool)
        .await?;
    Ok(())
}

#[derive(Clone)]
pub struct SpaceRow {
    pub id: String,
    pub name: String,
    pub owner_account_id: String,
    pub role: String,
    pub state: String,
    pub source_folder_id: Option<String>,
    pub anchor_json: String,
    pub cursor: i64,
    pub unread: i64,
    pub last_error: Option<String>,
    pub updated_at: String,
}
fn space_row(row: &sqlx_sqlite::SqliteRow) -> SpaceRow {
    SpaceRow {
        id: row.get("id"),
        name: row.get("name"),
        owner_account_id: row.get("owner_account_id"),
        role: row.get("role"),
        state: row.get("state"),
        source_folder_id: row.get("source_folder_id"),
        anchor_json: row.get("anchor_json"),
        cursor: row.get("cursor"),
        unread: row.get("unread"),
        last_error: row.get("last_error"),
        updated_at: row.get("updated_at"),
    }
}
const SPACE_COLUMNS: &str = "id,name,owner_account_id,role,state,source_folder_id,anchor_json,cursor,unread,last_error,updated_at";

pub async fn spaces(pool: &SqlitePool) -> Result<Vec<SpaceRow>, AppError> {
    Ok(query(&format!(
        "SELECT {SPACE_COLUMNS} FROM spaces ORDER BY updated_at DESC"
    ))
    .fetch_all(pool)
    .await?
    .iter()
    .map(space_row)
    .collect())
}
pub async fn space(pool: &SqlitePool, id: &str) -> Result<SpaceRow, AppError> {
    query(&format!("SELECT {SPACE_COLUMNS} FROM spaces WHERE id=?"))
        .bind(id)
        .fetch_optional(pool)
        .await?
        .map(|row| space_row(&row))
        .ok_or_else(super::not_found)
}
pub struct NewSpace<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub owner: &'a str,
    pub role: &'a str,
    pub state: &'a str,
    pub source_folder_id: Option<&'a str>,
    pub anchor: &'a IdentityBundle,
}
pub async fn insert_space(pool: &SqlitePool, s: NewSpace<'_>) -> Result<(), AppError> {
    let at = now();
    query("INSERT INTO spaces(id,name,owner_account_id,role,state,source_folder_id,anchor_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,role=excluded.role,anchor_json=excluded.anchor_json,updated_at=excluded.updated_at")
        .bind(s.id)
        .bind(s.name)
        .bind(s.owner)
        .bind(s.role)
        .bind(s.state)
        .bind(s.source_folder_id)
        .bind(serde_json::to_string(s.anchor).unwrap_or_default())
        .bind(&at)
        .bind(&at)
        .execute(pool)
        .await?;
    Ok(())
}
pub async fn set_state(pool: &SqlitePool, id: &str, state: &str) -> Result<(), AppError> {
    query("UPDATE spaces SET state=?,updated_at=? WHERE id=?")
        .bind(state)
        .bind(now())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
pub async fn set_error(pool: &SqlitePool, id: &str, code: Option<&str>) -> Result<(), AppError> {
    query("UPDATE spaces SET last_error=? WHERE id=?")
        .bind(code)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
pub async fn finish_pull(
    pool: &SqlitePool,
    id: &str,
    cursor: i64,
    new_messages: i64,
) -> Result<(), AppError> {
    query("UPDATE spaces SET cursor=?,unread=unread+?,last_error=NULL,updated_at=CASE WHEN ?>0 THEN ? ELSE updated_at END WHERE id=?")
        .bind(cursor)
        .bind(new_messages)
        .bind(new_messages)
        .bind(now())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
pub async fn mark_read(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    query("UPDATE spaces SET unread=0 WHERE id=?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
pub async fn set_name(pool: &SqlitePool, id: &str, name: &str) -> Result<(), AppError> {
    query("UPDATE spaces SET name=? WHERE id=?")
        .bind(name)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
/// Forgets a space entirely: the owner deleted it.
pub async fn forget(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    for table in [
        "space_heads",
        "space_members",
        "space_objects",
        "space_outbox",
        "space_invitations",
        "space_turns",
    ] {
        query(&format!("DELETE FROM {table} WHERE space_id=?"))
            .bind(id)
            .execute(pool)
            .await?;
    }
    query("DELETE FROM spaces WHERE id=?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn latest_head(pool: &SqlitePool, id: &str) -> Result<Option<EpochHead>, AppError> {
    let row =
        query("SELECT head_json FROM space_heads WHERE space_id=? ORDER BY epoch DESC LIMIT 1")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    row.map(|row| {
        serde_json::from_str::<EpochHead>(&row.get::<String, _>("head_json"))
            .map_err(|_| super::protocol::invalid())
    })
    .transpose()
}
pub async fn save_heads(pool: &SqlitePool, id: &str, heads: &[&EpochHead]) -> Result<(), AppError> {
    for head in heads {
        query("INSERT OR IGNORE INTO space_heads(space_id,epoch,head_json) VALUES(?,?,?)")
            .bind(id)
            .bind(i64::try_from(head.epoch).unwrap_or(i64::MAX))
            .bind(serde_json::to_string(head).unwrap_or_default())
            .execute(pool)
            .await?;
    }
    Ok(())
}

pub struct MemberRow {
    pub account_id: String,
    pub role: String,
    pub bundle: IdentityBundle,
    pub verified: bool,
}
pub async fn replace_members(
    pool: &SqlitePool,
    id: &str,
    members: &[(String, String, IdentityBundle)],
) -> Result<(), AppError> {
    let verified: Vec<String> =
        query("SELECT account_id FROM space_members WHERE space_id=? AND verified=1")
            .bind(id)
            .fetch_all(pool)
            .await?
            .iter()
            .map(|row| row.get("account_id"))
            .collect();
    let mut tx = pool.begin().await?;
    query("DELETE FROM space_members WHERE space_id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    for (account, role, bundle) in members {
        query("INSERT INTO space_members(space_id,account_id,role,bundle_json,verified) VALUES(?,?,?,?,?)")
            .bind(id)
            .bind(account)
            .bind(role)
            .bind(serde_json::to_string(bundle).unwrap_or_default())
            .bind(i64::from(verified.contains(account)))
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}
pub async fn members(pool: &SqlitePool, id: &str) -> Result<Vec<MemberRow>, AppError> {
    let rows = query("SELECT account_id,role,bundle_json,verified FROM space_members WHERE space_id=? ORDER BY role DESC,account_id")
        .bind(id)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            Some(MemberRow {
                account_id: row.get("account_id"),
                role: row.get("role"),
                bundle: serde_json::from_str(&row.get::<String, _>("bundle_json")).ok()?,
                verified: row.get::<i64, _>("verified") != 0,
            })
        })
        .collect())
}
pub async fn set_verified(
    pool: &SqlitePool,
    id: &str,
    account: &str,
    verified: bool,
) -> Result<(), AppError> {
    query("UPDATE space_members SET verified=? WHERE space_id=? AND account_id=?")
        .bind(i64::from(verified))
        .bind(id)
        .bind(account)
        .execute(pool)
        .await?;
    Ok(())
}

pub struct ObjectRow {
    pub object_id: String,
    pub author: String,
    pub data: Value,
    pub deleted: bool,
    pub created_at: String,
    pub pending: bool,
}
/// Keeps a decrypted object when it is newer than what is kept: a later
/// sequence, and never an older epoch than the revision it replaces (a
/// removed member's old key cannot overwrite what was written after).
/// Returns whether it was new.
pub async fn accept_object(
    pool: &SqlitePool,
    id: &str,
    body: &ObjectBody,
    epoch: u64,
    sequence: i64,
) -> Result<bool, AppError> {
    let existing =
        query("SELECT sequence,epoch FROM space_objects WHERE space_id=? AND object_id=?")
            .bind(id)
            .bind(&body.object_id)
            .fetch_optional(pool)
            .await?;
    let epoch = i64::try_from(epoch).unwrap_or(i64::MAX);
    if let Some(row) = &existing {
        if row.get::<i64, _>("sequence") >= sequence || row.get::<i64, _>("epoch") > epoch {
            return Ok(false);
        }
    }
    query("INSERT INTO space_objects(space_id,object_id,kind,revision,epoch,author_account_id,data_json,deleted,sequence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(space_id,object_id) DO UPDATE SET kind=excluded.kind,revision=excluded.revision,epoch=excluded.epoch,author_account_id=excluded.author_account_id,data_json=excluded.data_json,deleted=excluded.deleted,sequence=excluded.sequence,created_at=excluded.created_at")
        .bind(id)
        .bind(&body.object_id)
        .bind(&body.kind)
        .bind(&body.revision)
        .bind(epoch)
        .bind(&body.author)
        .bind(body.data.to_string())
        .bind(i64::from(body.deleted))
        .bind(sequence)
        .bind(&body.created_at)
        .execute(pool)
        .await?;
    Ok(existing.is_none())
}
fn object_row(row: &sqlx_sqlite::SqliteRow, pending: bool) -> ObjectRow {
    ObjectRow {
        object_id: row.get("object_id"),
        author: row.get("author"),
        data: serde_json::from_str(&row.get::<String, _>("data_json")).unwrap_or(Value::Null),
        deleted: row.get::<i64, _>("deleted") != 0,
        created_at: row.get("created_at"),
        pending,
    }
}
/// What a space holds of one kind, the outbox's unsent writes laid over the
/// accepted ones, deletions left out.
pub async fn objects(pool: &SqlitePool, id: &str, kind: &str) -> Result<Vec<ObjectRow>, AppError> {
    let accepted = query("SELECT object_id,kind,revision,author_account_id AS author,data_json,deleted,sequence,created_at FROM space_objects WHERE space_id=? AND kind=? ORDER BY sequence")
        .bind(id)
        .bind(kind)
        .fetch_all(pool)
        .await?;
    let pending = query("SELECT object_id,kind,revision,'' AS author,data_json,deleted,0 AS sequence,created_at FROM space_outbox WHERE space_id=? AND kind=? ORDER BY created_at")
        .bind(id)
        .bind(kind)
        .fetch_all(pool)
        .await?;
    let mut out: Vec<ObjectRow> = accepted.iter().map(|row| object_row(row, false)).collect();
    for row in pending.iter().map(|row| object_row(row, true)) {
        out.retain(|kept| kept.object_id != row.object_id);
        out.push(row);
    }
    out.retain(|row| !row.deleted);
    Ok(out)
}
pub async fn object_revision(
    pool: &SqlitePool,
    id: &str,
    object_id: &str,
) -> Result<Option<String>, AppError> {
    Ok(
        query("SELECT revision FROM space_objects WHERE space_id=? AND object_id=?")
            .bind(id)
            .bind(object_id)
            .fetch_optional(pool)
            .await?
            .map(|row| row.get("revision")),
    )
}

pub struct OutboxRow {
    pub id: String,
    pub object_id: String,
    pub kind: String,
    pub revision: String,
    pub parent_revision: Option<String>,
    pub data: Value,
    pub deleted: bool,
    pub epoch: Option<i64>,
    pub ciphertext: Option<String>,
    pub signature: Option<String>,
    pub created_at: String,
}
pub struct Enqueue<'a> {
    pub space_id: &'a str,
    pub object_id: &'a str,
    pub kind: &'a str,
    pub data: &'a Value,
    pub deleted: bool,
}
/// A write to send. Its revision is chosen now, so it is the same through
/// every retry.
pub async fn enqueue(pool: &SqlitePool, e: Enqueue<'_>) -> Result<(), AppError> {
    let parent = object_revision(pool, e.space_id, e.object_id).await?;
    // A second edit before the first left replaces it rather than queueing
    // behind it: only the latest text of an object is worth sending.
    query("DELETE FROM space_outbox WHERE space_id=? AND object_id=? AND ciphertext IS NULL")
        .bind(e.space_id)
        .bind(e.object_id)
        .execute(pool)
        .await?;
    query("INSERT INTO space_outbox(id,space_id,object_id,kind,revision,parent_revision,data_json,deleted,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(e.space_id)
        .bind(e.object_id)
        .bind(e.kind)
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(parent)
        .bind(e.data.to_string())
        .bind(i64::from(e.deleted))
        .bind(now())
        .execute(pool)
        .await?;
    Ok(())
}
pub async fn outbox(pool: &SqlitePool, id: &str) -> Result<Vec<OutboxRow>, AppError> {
    let rows = query("SELECT id,object_id,kind,revision,parent_revision,data_json,deleted,epoch,ciphertext,signature,created_at FROM space_outbox WHERE space_id=? ORDER BY created_at LIMIT 50")
        .bind(id)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .iter()
        .map(|row| OutboxRow {
            id: row.get("id"),
            object_id: row.get("object_id"),
            kind: row.get("kind"),
            revision: row.get("revision"),
            parent_revision: row.get("parent_revision"),
            data: serde_json::from_str(&row.get::<String, _>("data_json")).unwrap_or(Value::Null),
            deleted: row.get::<i64, _>("deleted") != 0,
            epoch: row.get("epoch"),
            ciphertext: row.get("ciphertext"),
            signature: row.get("signature"),
            created_at: row.get("created_at"),
        })
        .collect())
}
/// Freezes the sealed form before it is sent. A new revision is taken when
/// the row was sealed under an epoch that has passed.
pub async fn freeze(
    pool: &SqlitePool,
    row_id: &str,
    revision: &str,
    epoch: i64,
    ciphertext: &str,
    signature: &str,
) -> Result<(), AppError> {
    query("UPDATE space_outbox SET revision=?,epoch=?,ciphertext=?,signature=?,attempts=attempts+1 WHERE id=?")
        .bind(revision)
        .bind(epoch)
        .bind(ciphertext)
        .bind(signature)
        .bind(row_id)
        .execute(pool)
        .await?;
    Ok(())
}
pub async fn sent(pool: &SqlitePool, row_id: &str) -> Result<(), AppError> {
    query("DELETE FROM space_outbox WHERE id=?")
        .bind(row_id)
        .execute(pool)
        .await?;
    Ok(())
}
pub async fn pending_writes(pool: &SqlitePool, id: &str) -> Result<i64, AppError> {
    Ok(
        query("SELECT count(*) AS n FROM space_outbox WHERE space_id=?")
            .bind(id)
            .fetch_one(pool)
            .await?
            .get("n"),
    )
}

pub async fn save_invitation(
    pool: &SqlitePool,
    id: &str,
    space_id: &str,
    secret: &str,
    expires_at: &str,
) -> Result<(), AppError> {
    query(
        "INSERT INTO space_invitations(id,space_id,secret,expires_at,created_at) VALUES(?,?,?,?,?)",
    )
    .bind(id)
    .bind(space_id)
    .bind(secret)
    .bind(expires_at)
    .bind(now())
    .execute(pool)
    .await?;
    Ok(())
}
pub async fn invitation_secret(pool: &SqlitePool, id: &str) -> Result<Option<String>, AppError> {
    Ok(query("SELECT secret FROM space_invitations WHERE id=?")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .map(|row| row.get("secret")))
}
pub async fn forget_invitation(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    query("DELETE FROM space_invitations WHERE id=?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub struct TurnRow {
    pub id: String,
    pub space_id: String,
    pub conversation_id: String,
    pub reply_to: String,
    pub attempts: i64,
    pub last_error: Option<String>,
}
pub async fn add_turn(
    pool: &SqlitePool,
    space_id: &str,
    conversation_id: &str,
    reply_to: &str,
) -> Result<String, AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    query("INSERT INTO space_turns(id,space_id,conversation_id,reply_to,created_at) VALUES(?,?,?,?,?)")
        .bind(&id)
        .bind(space_id)
        .bind(conversation_id)
        .bind(reply_to)
        .bind(now())
        .execute(pool)
        .await?;
    Ok(id)
}
fn turn_row(row: &sqlx_sqlite::SqliteRow) -> TurnRow {
    TurnRow {
        id: row.get("id"),
        space_id: row.get("space_id"),
        conversation_id: row.get("conversation_id"),
        reply_to: row.get("reply_to"),
        attempts: row.get("attempts"),
        last_error: row.get("last_error"),
    }
}
pub async fn turns(pool: &SqlitePool) -> Result<Vec<TurnRow>, AppError> {
    Ok(query("SELECT id,space_id,conversation_id,reply_to,attempts,last_error FROM space_turns ORDER BY created_at")
        .fetch_all(pool)
        .await?
        .iter()
        .map(turn_row)
        .collect())
}
pub async fn turn(pool: &SqlitePool, id: &str) -> Result<Option<TurnRow>, AppError> {
    Ok(query("SELECT id,space_id,conversation_id,reply_to,attempts,last_error FROM space_turns WHERE id=?")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .map(|row| turn_row(&row)))
}
pub async fn turn_failed(pool: &SqlitePool, id: &str, code: &str) -> Result<(), AppError> {
    query("UPDATE space_turns SET attempts=attempts+1,last_error=? WHERE id=?")
        .bind(code)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
pub async fn turn_retry(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    query("UPDATE space_turns SET attempts=0,last_error=NULL WHERE id=?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
pub async fn turn_done(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    query("DELETE FROM space_turns WHERE id=?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
