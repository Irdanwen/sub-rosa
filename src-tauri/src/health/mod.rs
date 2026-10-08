//! Health (ADR-0099): daily summaries read from the phone's own health store,
//! kept on the device, and offered to the person and to the assistant.
//!
//! HealthKit on the iPhone and Health Connect on Android are read, never
//! written, and only for the measures the person picked. What is read is
//! folded into one row per measure and per day (`health_days`): the app
//! keeps a day's step count, not every sample the watch took. A summary
//! leaves the device only when the person switched on that measure's own
//! sync, and then only through the account outbox like any other row
//! (`stays_local` in `account::sync` reads `health_metrics.sync`).
//!
//! The desktop has no health store. It holds what a phone sent with consent,
//! and its view and its agent tool read only that.
//!
//! Reading is quick and idempotent, so it is never a durable job (ADR-0018):
//! the view refreshes on open, the agent's tool refreshes before it answers,
//! and a refresh lost to a locked phone is simply the next one's work.

mod native;
mod store;
pub mod summary;
pub mod tool;

use crate::domain::types::AppError;
use chrono::{Duration, NaiveDate};
use serde::{Deserialize, Serialize};
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;

pub use store::days_between;

/// How far back a first read reaches, and how far an ordinary refresh does.
const FIRST_READ_DAYS: u32 = 90;
const REFRESH_DAYS: u32 = 14;
/// How many days a view or a tool may ask for at once.
pub const MAX_WINDOW_DAYS: u32 = 366;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Metric {
    Steps,
    Sleep,
    HeartRate,
    RestingHeartRate,
    Workouts,
    Weight,
}

impl Metric {
    pub const ALL: [Metric; 6] = [
        Metric::Steps,
        Metric::Sleep,
        Metric::HeartRate,
        Metric::RestingHeartRate,
        Metric::Workouts,
        Metric::Weight,
    ];

    pub fn key(self) -> &'static str {
        match self {
            Metric::Steps => "steps",
            Metric::Sleep => "sleep",
            Metric::HeartRate => "heart_rate",
            Metric::RestingHeartRate => "resting_heart_rate",
            Metric::Workouts => "workouts",
            Metric::Weight => "weight",
        }
    }

    pub fn parse(key: &str) -> Option<Metric> {
        Metric::ALL.into_iter().find(|metric| metric.key() == key)
    }

    /// The unit `health_days.value` is in.
    pub fn unit(self) -> &'static str {
        match self {
            Metric::Steps => "steps",
            Metric::Sleep | Metric::Workouts => "minutes",
            Metric::HeartRate | Metric::RestingHeartRate => "bpm",
            Metric::Weight => "kg",
        }
    }

    /// Whether a period's total means something.
    pub fn adds_up(self) -> bool {
        matches!(self, Metric::Steps | Metric::Sleep | Metric::Workouts)
    }
}

/// One measure on one day, as stored and as the native halves answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthDay {
    pub metric: String,
    pub day: String,
    pub value: f64,
    #[serde(default)]
    pub low: Option<f64>,
    #[serde(default)]
    pub high: Option<f64>,
    #[serde(default)]
    pub samples: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthMetricState {
    pub metric: String,
    pub enabled: bool,
    pub sync: bool,
    pub days: i64,
    pub last_day: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthStatus {
    /// `healthkit`, `health_connect`, or `none` on a computer.
    pub source: &'static str,
    /// `available`, `unavailable` (no store on this device, or this build
    /// cannot reach it), `update_required` (Health Connect needs an update)
    /// or `elsewhere` (a computer: the data comes from a phone).
    pub availability: String,
    pub metrics: Vec<HealthMetricState>,
}

pub(crate) fn invalid_metric() -> AppError {
    AppError::new(
        "health_metric_invalid",
        "This health measure is not supported.",
    )
}

pub(crate) fn day_text(day: NaiveDate) -> String {
    day.format("%Y-%m-%d").to_string()
}

pub(crate) fn today() -> NaiveDate {
    chrono::Local::now().date_naive()
}

pub(crate) fn parse_day(text: &str) -> Result<NaiveDate, AppError> {
    NaiveDate::parse_from_str(text.trim(), "%Y-%m-%d")
        .map_err(|_| AppError::new("health_day_invalid", "This date is not valid."))
}

/// The measures the person picked on this device.
pub(crate) async fn enabled_metrics(pool: &SqlitePool) -> Result<Vec<Metric>, AppError> {
    Ok(store::metric_flags(pool)
        .await?
        .into_iter()
        .filter(|(_, enabled, _)| *enabled)
        .filter_map(|(key, _, _)| Metric::parse(&key))
        .collect())
}

pub async fn status(pool: &SqlitePool) -> Result<HealthStatus, AppError> {
    let flags = store::metric_flags(pool).await?;
    let counts = store::counts(pool).await?;
    let metrics = Metric::ALL
        .iter()
        .map(|metric| {
            let flag = flags.iter().find(|(key, _, _)| key == metric.key());
            let count = counts.iter().find(|(key, _, _)| key == metric.key());
            HealthMetricState {
                metric: metric.key().to_string(),
                enabled: flag.is_some_and(|(_, enabled, _)| *enabled),
                sync: flag.is_some_and(|(_, _, sync)| *sync),
                days: count.map_or(0, |(_, days, _)| *days),
                last_day: count.and_then(|(_, _, last)| last.clone()),
            }
        })
        .collect();
    Ok(HealthStatus {
        source: native::source(),
        availability: native::availability().await,
        metrics,
    })
}

/// Reads the last `days` days of every picked measure from the phone's store
/// and folds them in. Answers how many rows changed. A computer reads
/// nothing: its rows come from a phone.
pub async fn refresh(pool: &SqlitePool, days: u32) -> Result<usize, AppError> {
    let metrics = enabled_metrics(pool).await?;
    if metrics.is_empty() || native::source() == "none" {
        return Ok(0);
    }
    let to = today();
    let from = to - Duration::days(i64::from(days.clamp(1, MAX_WINDOW_DAYS)) - 1);
    let read = native::read(&metrics, from, to).await?;
    let wanted: Vec<&str> = metrics.iter().map(|metric| metric.key()).collect();
    let mut changed = 0;
    for day in read
        .iter()
        .filter(|day| wanted.contains(&day.metric.as_str()) && day.value.is_finite())
    {
        changed += store::upsert(pool, day, native::source()).await?;
    }
    Ok(changed)
}

/// Best effort, for the agent's tool: a refresh that fails (a locked phone,
/// a revoked permission) leaves what is stored, never an error.
pub(crate) async fn refresh_quietly(pool: &SqlitePool) {
    if let Err(error) = refresh(pool, REFRESH_DAYS).await {
        tracing::debug!(code = %error.code, "health refresh skipped");
    }
}

// --- Commands ----------------------------------------------------------------

#[tauri::command]
pub async fn health_status(app: AppHandle) -> Result<HealthStatus, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    status(&repos.pool).await
}

/// The person picked which measures to read. The phone asks its store for
/// exactly those (the system sheet), then reads their recent history.
#[tauri::command]
pub async fn health_choose(app: AppHandle, metrics: Vec<String>) -> Result<HealthStatus, AppError> {
    let chosen = metrics
        .iter()
        .map(|key| Metric::parse(key).ok_or_else(invalid_metric))
        .collect::<Result<Vec<_>, _>>()?;
    let repos = crate::commands::repositories(&app).await?;
    if !chosen.is_empty() {
        native::request(&chosen).await?;
    }
    store::set_enabled(&repos.pool, &chosen).await?;
    refresh(&repos.pool, FIRST_READ_DAYS).await?;
    status(&repos.pool).await
}

#[tauri::command]
pub async fn health_refresh(app: AppHandle) -> Result<HealthStatus, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    refresh(&repos.pool, REFRESH_DAYS).await?;
    status(&repos.pool).await
}

/// One measure's sync, switched on or off by the person. Switching it on
/// sends what is already stored as well.
#[tauri::command]
pub async fn health_set_sync(
    app: AppHandle,
    metric: String,
    sync: bool,
) -> Result<HealthStatus, AppError> {
    let metric = Metric::parse(&metric).ok_or_else(invalid_metric)?;
    let repos = crate::commands::repositories(&app).await?;
    store::set_sync(&repos.pool, metric, sync).await?;
    if sync {
        crate::account::sync::enqueue_existing(
            &repos.pool,
            "health_days",
            &format!("metric='{}'", metric.key()),
        )
        .await?;
    }
    status(&repos.pool).await
}

/// Deletes what this device stored for one measure, or for all of them. The
/// phone's own store is untouched.
#[tauri::command]
pub async fn health_forget(
    app: AppHandle,
    metric: Option<String>,
) -> Result<HealthStatus, AppError> {
    let metric = metric
        .map(|key| Metric::parse(&key).ok_or_else(invalid_metric))
        .transpose()?;
    let repos = crate::commands::repositories(&app).await?;
    store::forget(&repos.pool, metric).await?;
    status(&repos.pool).await
}

#[tauri::command]
pub async fn health_days(
    app: AppHandle,
    from: String,
    to: String,
) -> Result<Vec<HealthDay>, AppError> {
    let (from, to) = (parse_day(&from)?, parse_day(&to)?);
    let repos = crate::commands::repositories(&app).await?;
    days_between(&repos.pool, from, to).await
}

#[cfg(test)]
mod tests;
