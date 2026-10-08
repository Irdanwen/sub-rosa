//! The two health tables: the daily summaries and this device's choices.

use super::{day_text, HealthDay, Metric};
use crate::domain::types::AppError;
use chrono::NaiveDate;
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::SqlitePool;

/// The id a day travels under: one object per measure and day, whichever
/// phone read it and however often.
pub(crate) fn day_id(metric: &str, day: &str) -> String {
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!("subrosa:health-day:{metric}:{day}").as_bytes(),
    )
    .hyphenated()
    .to_string()
}

/// `(metric, enabled, sync)` for every measure this device has a choice for.
pub(super) async fn metric_flags(pool: &SqlitePool) -> Result<Vec<(String, bool, bool)>, AppError> {
    let rows = query("SELECT metric, enabled, sync FROM health_metrics")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .iter()
        .map(|row| {
            (
                row.get::<String, _>("metric"),
                row.get::<i64, _>("enabled") != 0,
                row.get::<i64, _>("sync") != 0,
            )
        })
        .collect())
}

/// `(metric, days stored, latest day)`.
pub(super) async fn counts(
    pool: &SqlitePool,
) -> Result<Vec<(String, i64, Option<String>)>, AppError> {
    let rows =
        query("SELECT metric, count(*) AS n, max(day) AS last FROM health_days GROUP BY metric")
            .fetch_all(pool)
            .await?;
    Ok(rows
        .iter()
        .map(|row| (row.get("metric"), row.get("n"), row.get("last")))
        .collect())
}

/// The picked measures become exactly `chosen`. A measure set aside keeps
/// its stored days and its sync choice: putting it down is not forgetting.
pub(super) async fn set_enabled(pool: &SqlitePool, chosen: &[Metric]) -> Result<(), AppError> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    for metric in Metric::ALL {
        query(
            "INSERT INTO health_metrics (metric, enabled, sync, updated_at) VALUES (?1, ?2, 0, ?3)
             ON CONFLICT(metric) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at",
        )
        .bind(metric.key())
        .bind(i64::from(chosen.contains(&metric)))
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub(super) async fn set_sync(
    pool: &SqlitePool,
    metric: Metric,
    sync: bool,
) -> Result<(), AppError> {
    query(
        "INSERT INTO health_metrics (metric, enabled, sync, updated_at) VALUES (?1, 0, ?2, ?3)
         ON CONFLICT(metric) DO UPDATE SET sync = excluded.sync, updated_at = excluded.updated_at",
    )
    .bind(metric.key())
    .bind(i64::from(sync))
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}

/// Folds in one day. A day read again with the same figures is left alone,
/// so a refresh queues nothing for the account when nothing changed.
/// Answers 1 when the row was written.
pub(super) async fn upsert(
    pool: &SqlitePool,
    day: &HealthDay,
    source: &str,
) -> Result<usize, AppError> {
    let metric = Metric::parse(&day.metric).ok_or_else(super::invalid_metric)?;
    let date = super::parse_day(&day.day)?;
    let day_key = day_text(date);
    let result = query(
        "INSERT INTO health_days (id, metric, day, value, low, high, samples, source, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET value = excluded.value, low = excluded.low,
           high = excluded.high, samples = excluded.samples, source = excluded.source,
           updated_at = excluded.updated_at
         WHERE health_days.value IS NOT excluded.value OR health_days.low IS NOT excluded.low
           OR health_days.high IS NOT excluded.high OR health_days.samples IS NOT excluded.samples",
    )
    .bind(day_id(metric.key(), &day_key))
    .bind(metric.key())
    .bind(&day_key)
    .bind(day.value)
    .bind(day.low.filter(|value| value.is_finite()))
    .bind(day.high.filter(|value| value.is_finite()))
    .bind(day.samples.max(0))
    .bind(source)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await?;
    Ok(result.rows_affected() as usize)
}

pub(super) async fn forget(pool: &SqlitePool, metric: Option<Metric>) -> Result<(), AppError> {
    match metric {
        Some(metric) => {
            query("DELETE FROM health_days WHERE metric = ?1")
                .bind(metric.key())
                .execute(pool)
                .await?
        }
        None => query("DELETE FROM health_days").execute(pool).await?,
    };
    Ok(())
}

/// Every stored day in `[from, to]`, oldest first.
pub async fn days_between(
    pool: &SqlitePool,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<Vec<HealthDay>, AppError> {
    let rows = query(
        "SELECT metric, day, value, low, high, samples FROM health_days
         WHERE day >= ?1 AND day <= ?2 ORDER BY day, metric",
    )
    .bind(day_text(from))
    .bind(day_text(to))
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|row| HealthDay {
            metric: row.get("metric"),
            day: row.get("day"),
            value: row.get("value"),
            low: row.get("low"),
            high: row.get("high"),
            samples: row.get("samples"),
        })
        .collect())
}
