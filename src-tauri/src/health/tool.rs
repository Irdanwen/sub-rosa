//! `health_summary`, the assistant's read of the person's health days, for
//! agent-lite on the phones and, through the app's local proxy, for the
//! desktop's context MCP. Read only: nothing here writes a row or reaches a
//! health store beyond the refresh a phone does before it answers.

use super::{summary, Metric};
use crate::domain::types::AppError;
use chrono::Duration;
use serde_json::{json, Value};
use sqlx::query::query;
use sqlx_sqlite::SqlitePool;

pub const TOOL: &str = "health_summary";
const DEFAULT_DAYS: u32 = 14;
const MAX_DAYS: u32 = 90;

pub fn definition() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": TOOL,
            "description": "Read the user's daily health summaries kept on their device (steps, sleep, heart rate, resting heart rate, workouts, weight): averages, totals, range, the last week against the week before, and the latest days. Only the measures the user chose to share with Sub Rosa are there. Use it when the user asks about their activity, sleep, heart rate, exercise or weight. Describe what the figures say; do not diagnose.",
            "parameters": {
                "type": "object",
                "properties": {
                    "days": {
                        "type": "integer",
                        "description": "How many days back from today, 1 to 90. Defaults to 14."
                    },
                    "metrics": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": ["steps", "sleep", "heart_rate", "resting_heart_rate", "workouts", "weight"]
                        },
                        "description": "The measures to read. Defaults to every measure that has data."
                    }
                }
            }
        }
    })
}

/// Whether there is anything for the tool to read: an empty tool is not
/// offered.
pub async fn available(pool: &SqlitePool) -> bool {
    query("SELECT 1 FROM health_days LIMIT 1")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .is_some()
}

/// The summary the tool answers, as JSON.
pub async fn answer(pool: &SqlitePool, args: &Value) -> Result<Value, AppError> {
    let days = args
        .get("days")
        .and_then(Value::as_u64)
        .map_or(DEFAULT_DAYS, |days| {
            days.clamp(1, u64::from(MAX_DAYS)) as u32
        });
    let requested: Vec<Metric> = args
        .get("metrics")
        .and_then(Value::as_array)
        .map(|keys| {
            keys.iter()
                .filter_map(Value::as_str)
                .filter_map(Metric::parse)
                .collect()
        })
        .unwrap_or_default();
    let today = super::today();
    let from = today - Duration::days(i64::from(days) - 1);
    let rows = super::days_between(pool, from, today).await?;
    let metrics: Vec<Metric> = if requested.is_empty() {
        Metric::ALL
            .into_iter()
            .filter(|metric| rows.iter().any(|row| row.metric == metric.key()))
            .collect()
    } else {
        requested
    };
    let summary = summary::summarize(&rows, &metrics, today, days);
    let mut value = serde_json::to_value(&summary).unwrap_or(Value::Null);
    if metrics.is_empty() {
        value["note"] = json!("No health data is stored for this period.");
    }
    Ok(value)
}

/// Agent-lite: a phone refreshes its recent days first, then answers.
pub async fn run(pool: &SqlitePool, args: &Value) -> String {
    super::refresh_quietly(pool).await;
    match answer(pool, args).await {
        Ok(value) => value.to_string(),
        Err(error) => json!({ "error": error.message }).to_string(),
    }
}
