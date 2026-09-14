//! Finished long-form summaries travel inside their note revision. The same
//! parent revision therefore protects both writing and summary conflicts.
use super::*;
use sqlx_sqlite::SqliteConnection;
const FIELDS: &[&str] = &[
    "short_summary",
    "detailed_summary",
    "transcript_chars",
    "chunk_count",
    "chunks_done",
    "parts_json",
    "model",
    "prompt_version",
    "created_at",
    "updated_at",
];
pub(super) fn snapshot(note_id: &str) -> String {
    format!("(SELECT json_object({}) FROM note_summaries ns WHERE ns.note_id={note_id} AND ns.status='ready')",FIELDS.iter().map(|c|format!("'{c}',ns.{c}")).collect::<Vec<_>>().join(","))
}
pub(super) async fn apply(
    conn: &mut SqliteConnection,
    note_id: &str,
    value: &Value,
) -> Result<(), AppError> {
    if value.is_null() {
        query("DELETE FROM note_summaries WHERE note_id=? AND status='ready'")
            .bind(note_id)
            .execute(conn)
            .await?;
        return Ok(());
    }
    let row = value
        .as_object()
        .ok_or_else(|| error("sync_format_invalid"))?;
    if row.keys().any(|k| !FIELDS.contains(&k.as_str())) {
        return Err(error("sync_format_invalid"));
    }
    // Receiving history must not cancel a currently running local paid summary.
    let active =
        query("SELECT 1 FROM note_summaries WHERE note_id=? AND status IN ('pending','running')")
            .bind(note_id)
            .fetch_optional(&mut *conn)
            .await?
            .is_some();
    if active {
        return Err(error("sync_local_work_active"));
    }
    let columns: Vec<_> = row.keys().cloned().collect();
    let sql=format!("INSERT INTO note_summaries(note_id,status,{}) VALUES(?,'ready',{}) ON CONFLICT(note_id) DO UPDATE SET status='ready',{}",columns.join(","),vec!["?";columns.len()].join(","),columns.iter().map(|c|format!("{c}=excluded.{c}")).collect::<Vec<_>>().join(","));
    let mut q = query(&sql).bind(note_id);
    for c in columns {
        q = match &row[&c] {
            Value::Null => q.bind(Option::<String>::None),
            Value::String(s) => q.bind(s.clone()),
            Value::Number(n) => q.bind(n.as_i64()),
            _ => return Err(error("sync_format_invalid")),
        };
    }
    q.execute(conn).await?;
    Ok(())
}
