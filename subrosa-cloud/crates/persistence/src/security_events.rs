//! The account's security history (`security_events`). Append-only: a row is
//! written in the transaction of the action it describes, so a crash loses
//! both or neither, and maintenance is the only thing that ever deletes one.
use super::{Repository, db};
use sqlx::{Postgres, Row, Transaction};
use subrosa_domain::{Error, Result, SecurityEvent, SecurityEventKind};
use uuid::Uuid;

/// How long the history goes back. Long enough to notice a device you do not
/// recognise after a holiday, short enough not to become a diary.
pub const RETENTION_DAYS: i32 = 90;
/// The most rows one read returns. A person reads the top of the list; a
/// renewal war (ADR 0056) must not turn the page into a scroll of thousands.
pub const PAGE: i64 = 200;

/// Records `kind` for `owner`. With a device, its current label is copied so
/// the line still reads the same after a rename. The device must belong to
/// the owner, or the line simply carries no name.
pub(crate) async fn record_event(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    kind: SecurityEventKind,
    device: Option<Uuid>,
) -> Result<()> {
    sqlx::query("INSERT INTO security_events(id,account_id,kind,device_name) VALUES($1,$2,$3,(SELECT name FROM devices WHERE id=$4 AND account_id=$2))")
        .bind(Uuid::now_v7())
        .bind(owner)
        .bind(kind.as_str())
        .bind(device)
        .execute(&mut **tx)
        .await
        .map_err(db)?;
    Ok(())
}

impl Repository {
    /// The owner's history, newest first, within the retention window.
    pub async fn security_events(&self, owner: Uuid) -> Result<Vec<SecurityEvent>> {
        sqlx::query("SELECT id,kind,occurred_at,device_name FROM security_events WHERE account_id=$1 AND occurred_at>now()-make_interval(days => $2) ORDER BY occurred_at DESC,id DESC LIMIT $3")
            .bind(owner)
            .bind(RETENTION_DAYS)
            .bind(PAGE)
            .fetch_all(&self.pool)
            .await
            .map_err(db)?
            .iter()
            .map(|row| {
                Ok(SecurityEvent {
                    id: row.get("id"),
                    kind: SecurityEventKind::parse(row.get("kind")).ok_or(Error::Unavailable)?,
                    occurred_at: row.get("occurred_at"),
                    device_name: row.get("device_name"),
                })
            })
            .collect()
    }
    /// For an action that has no transaction of its own here, such as signing
    /// a Carpe Diem assertion. The caller decides whether a failure matters.
    pub async fn record_security_event(
        &self,
        owner: Uuid,
        kind: SecurityEventKind,
        device: Option<Uuid>,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        record_event(&mut tx, owner, kind, device).await?;
        tx.commit().await.map_err(db)
    }
}
