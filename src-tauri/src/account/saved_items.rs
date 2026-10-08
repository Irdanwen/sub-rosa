//! What a person saved from a chat, synchronised (ADR-0088, addendum).
//!
//! `saved_items` rides the generic row codec: the triggers, the inventory and
//! a remote deletion are the registry's. Three things are particular to it,
//! and they live here so the sync engine only names them.
//!
//! * A saved item's id is a name-based UUID of what was saved
//!   (`crate::saved_items::item_id`), so the same link saved on two devices
//!   is one object rather than two rows the `source_key` constraint would
//!   refuse to hold side by side.
//! * Two devices saving the same thing before either heard of the other
//!   leave sibling revisions that differ only in when each saved it. That is
//!   one item, not a disagreement, so it settles like identical content.
//! * An item saved in a temporary chat (ADR-0083) never leaves the device.
//!   Saving refuses it already; the trigger refuses it again.

use super::*;
use serde_json::Map;
use sqlx_sqlite::SqliteConnection;

/// The trigger condition that keeps a temporary chat's item on the device. A
/// conversation is a task id on the phone and a Hermes session id on the
/// desktop, so both are asked.
pub(super) fn outside_temporary_chat(prefix: &str) -> String {
    format!(" AND NOT EXISTS(SELECT 1 FROM agent_tasks WHERE agent_tasks.ephemeral=1 AND {prefix}conversation_id IN (agent_tasks.id,agent_tasks.hermes_session_id))")
}

/// Before a received item is written: a row this device holds for the same
/// thing under another id (saved by a build that drew ids at random) gives
/// way, so the unique `source_key` cannot refuse the arrival. The caller holds
/// `applying=1`.
pub(super) async fn make_room(
    conn: &mut SqliteConnection,
    row: &Map<String, Value>,
) -> Result<(), AppError> {
    let (Some(id), Some(source_key)) = (
        row.get("id").and_then(Value::as_str),
        row.get("source_key").and_then(Value::as_str),
    ) else {
        return Err(error("sync_format_invalid"));
    };
    query("DELETE FROM saved_items WHERE source_key=? AND id<>?")
        .bind(source_key)
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}

/// Whether a sibling names the item this device holds. A saved item is never
/// edited, only saved and removed, so the same `source_key` is the same item
/// whatever the title or the moment each device saved it.
pub(super) fn same_item(local: &Value, remote: &Value) -> bool {
    let key = |body: &Value| body["row"]["source_key"].as_str().map(str::to_owned);
    key(local).is_some() && key(local) == key(remote)
}
