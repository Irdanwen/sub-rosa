//! The daily brief as a travelling object (ADR-0107).
//!
//! The card is composed where the calendar is: EventKit on the phone and the
//! Mac (ADR-0025), which a browser will never read. So the device that wrote
//! a card also files it on the account, agenda line included, and the web
//! client shows it. The local `daily_briefs` row stays what it was, the
//! ledger of what this device announced; this row is history wherever it
//! lands, and nothing runs because one arrived.
//!
//! One object per device and day, its id derived from both, so a second
//! write of the same morning is the same object. Each device prunes its own
//! cards after [`KEEP_DAYS`]: a brief is about its morning, not an archive.

use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::SqlitePool;

use super::daily::DailyCard;

/// How long a device keeps its own travelling cards.
pub const KEEP_DAYS: i64 = 14;

/// A card's object id: a name-based UUID of its device and its day.
pub fn card_id(device_id: &str, day: &str) -> String {
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_OID,
        format!("subrosa:daily-brief:{device_id}:{day}").as_bytes(),
    )
    .to_string()
}

/// What "written on" says: the kind of device, which every surface
/// translates.
pub fn device_kind() -> &'static str {
    if cfg!(mobile) {
        "phone"
    } else {
        "computer"
    }
}

async fn this_device(pool: &SqlitePool) -> Option<String> {
    query("SELECT device_id FROM account_sync_control WHERE id=1")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .and_then(|row| row.get::<Option<String>, _>("device_id"))
        .filter(|id| !id.is_empty())
}

/// Files the card this device just wrote. Best effort: a brief that could
/// not travel is still the brief on this device.
pub async fn record(pool: &SqlitePool, card: &DailyCard, status: &str) {
    let Some(device) = this_device(pool).await else {
        return;
    };
    let body = serde_json::to_string(card).unwrap_or_else(|_| "{}".into());
    let now = chrono::Utc::now().to_rfc3339();
    if let Err(error) = query("INSERT INTO daily_brief_cards(id,day,device_id,device_name,card,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
        .bind(card_id(&device, &card.day))
        .bind(&card.day)
        .bind(&device)
        .bind(device_kind())
        .bind(body)
        .bind(status)
        .bind(&card.created_at)
        .bind(&now)
        .execute(pool)
        .await
    {
        tracing::warn!(%error, "daily brief card not filed");
        return;
    }
    let cutoff = (chrono::Local::now() - chrono::Duration::days(KEEP_DAYS))
        .format("%Y-%m-%d")
        .to_string();
    let _ = query("DELETE FROM daily_brief_cards WHERE device_id=? AND day<?")
        .bind(&device)
        .bind(cutoff)
        .execute(pool)
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn store(device: Option<&str>) -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::db::migrations::run_migrations(&pool).await.unwrap();
        if let Some(device) = device {
            query("UPDATE account_sync_control SET device_id=? WHERE id=1")
                .bind(device)
                .execute(&pool)
                .await
                .unwrap();
        }
        pool
    }

    fn card(day: &str) -> DailyCard {
        DailyCard {
            day: day.into(),
            created_at: format!("{day}T07:30:00Z"),
            agenda: Some(super::super::daily::Agenda {
                count: 2,
                first_title: "Stand-up".into(),
                first_at: "09:00".into(),
            }),
            ..DailyCard::default()
        }
    }

    /// The agenda line a browser cannot compose travels with the card, under
    /// one object per device and day, and old cards of this device go.
    #[tokio::test]
    async fn a_card_travels_once_per_device_and_day_with_its_agenda() {
        let pool = store(Some("mac")).await;
        record(&pool, &card("2026-10-08"), "delivered").await;
        record(&pool, &card("2026-10-08"), "quiet").await;
        let rows = query("SELECT id, device_name, card, status FROM daily_brief_cards")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(
            rows.len(),
            1,
            "a second write of the morning is the same object"
        );
        assert_eq!(rows[0].get::<String, _>("id"), card_id("mac", "2026-10-08"));
        assert_eq!(rows[0].get::<String, _>("status"), "delivered");
        let stored: DailyCard = serde_json::from_str(&rows[0].get::<String, _>("card")).unwrap();
        assert_eq!(stored.agenda.unwrap().first_title, "Stand-up");
        record(&pool, &card("2000-01-01"), "quiet").await;
        let old: i64 = sqlx::query_scalar::query_scalar(
            "SELECT count(*) FROM daily_brief_cards WHERE day='2000-01-01'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(old, 0, "a card older than the window is pruned");
    }

    #[tokio::test]
    async fn without_an_account_nothing_travels() {
        let pool = store(None).await;
        record(&pool, &card("2026-10-08"), "delivered").await;
        let count: i64 = sqlx::query_scalar::query_scalar("SELECT count(*) FROM daily_brief_cards")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn the_id_is_the_device_and_the_day() {
        assert_eq!(card_id("a", "2026-10-08"), card_id("a", "2026-10-08"));
        assert_ne!(card_id("a", "2026-10-08"), card_id("b", "2026-10-08"));
        assert_ne!(card_id("a", "2026-10-08"), card_id("a", "2026-10-09"));
    }
}
