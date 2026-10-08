//! What a run of daily health summaries says, as a pure function: the shape
//! the agent tools hand the model and the Health view reads its figures
//! from. No database and no clock here, so the arithmetic is tested alone.

use super::{HealthDay, Metric};
use chrono::{Duration, NaiveDate};
use serde::Serialize;

/// How many of the latest days a summary lists one by one.
const DAILY_LIMIT: usize = 14;
/// The two windows a trend compares: the last week against the one before.
const TREND_DAYS: i64 = 7;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyValue {
    pub day: String,
    pub value: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricSummary {
    pub metric: String,
    pub unit: &'static str,
    pub days_with_data: usize,
    /// The mean of the days that have a reading. A day with no reading is
    /// unknown, not zero: a phone left on a desk walks no steps.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average: Option<f64>,
    /// Steps, sleep and exercise add up over a period. Heart rate and weight
    /// do not, so they have none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lowest: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub highest: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<DailyValue>,
    /// The mean of the last seven days of the window and of the seven before,
    /// when both have a reading.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_week_average: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub week_before_average: Option<f64>,
    /// The latest days, newest first.
    pub daily: Vec<DailyValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthSummary {
    pub from: String,
    pub to: String,
    pub metrics: Vec<MetricSummary>,
}

fn round(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| round(values.iter().sum::<f64>() / values.len() as f64))
}

/// Summarises `days` days ending with `today`, for each of `metrics` in the
/// order given. Rows outside the window are ignored.
pub fn summarize(
    rows: &[HealthDay],
    metrics: &[Metric],
    today: NaiveDate,
    days: u32,
) -> HealthSummary {
    let days = i64::from(days.clamp(1, 366));
    let from = today - Duration::days(days - 1);
    let day_text = |day: NaiveDate| day.format("%Y-%m-%d").to_string();
    let (from_text, to_text) = (day_text(from), day_text(today));
    let week_start = day_text(today - Duration::days(TREND_DAYS - 1));
    let previous_start = day_text(today - Duration::days(2 * TREND_DAYS - 1));
    let summaries = metrics
        .iter()
        .map(|metric| {
            let mut own: Vec<&HealthDay> = rows
                .iter()
                .filter(|row| {
                    row.metric == metric.key() && row.day >= from_text && row.day <= to_text
                })
                .collect();
            own.sort_by(|a, b| b.day.cmp(&a.day));
            let values: Vec<f64> = own.iter().map(|row| row.value).collect();
            let window = |start: &str, end: &str| -> Vec<f64> {
                own.iter()
                    .filter(|row| row.day.as_str() >= start && row.day.as_str() <= end)
                    .map(|row| row.value)
                    .collect()
            };
            let last_week = window(&week_start, &to_text);
            let before_end = day_text(today - Duration::days(TREND_DAYS));
            let week_before = window(&previous_start, &before_end);
            let lows = own.iter().map(|row| row.low.unwrap_or(row.value));
            let highs = own.iter().map(|row| row.high.unwrap_or(row.value));
            MetricSummary {
                metric: metric.key().to_string(),
                unit: metric.unit(),
                days_with_data: own.len(),
                average: mean(&values),
                total: (metric.adds_up() && !values.is_empty()).then(|| round(values.iter().sum())),
                lowest: lows.reduce(f64::min).map(round),
                highest: highs.reduce(f64::max).map(round),
                latest: own.first().map(|row| DailyValue {
                    day: row.day.clone(),
                    value: round(row.value),
                }),
                last_week_average: if week_before.is_empty() {
                    None
                } else {
                    mean(&last_week)
                },
                week_before_average: if last_week.is_empty() {
                    None
                } else {
                    mean(&week_before)
                },
                daily: own
                    .iter()
                    .take(DAILY_LIMIT)
                    .map(|row| DailyValue {
                        day: row.day.clone(),
                        value: round(row.value),
                    })
                    .collect(),
            }
        })
        .collect();
    HealthSummary {
        from: from_text,
        to: to_text,
        metrics: summaries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(metric: Metric, day: &str, value: f64) -> HealthDay {
        HealthDay {
            metric: metric.key().to_string(),
            day: day.to_string(),
            value,
            low: None,
            high: None,
            samples: 0,
        }
    }

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, 14).unwrap()
    }

    #[test]
    fn steps_average_the_days_that_have_a_reading_and_add_up() {
        let rows = vec![
            day(Metric::Steps, "2026-10-14", 8000.0),
            day(Metric::Steps, "2026-10-13", 6000.0),
            // Outside a seven day window.
            day(Metric::Steps, "2026-10-01", 20000.0),
        ];
        let summary = summarize(&rows, &[Metric::Steps], today(), 7);
        let steps = &summary.metrics[0];
        assert_eq!(summary.from, "2026-10-08");
        assert_eq!(steps.days_with_data, 2);
        assert_eq!(steps.average, Some(7000.0));
        assert_eq!(steps.total, Some(14000.0));
        assert_eq!(steps.latest.as_ref().unwrap().day, "2026-10-14");
        assert_eq!(steps.unit, "steps");
    }

    #[test]
    fn heart_rate_has_a_range_and_no_total() {
        let mut first = day(Metric::HeartRate, "2026-10-14", 71.24);
        first.low = Some(52.0);
        first.high = Some(141.0);
        let mut second = day(Metric::HeartRate, "2026-10-13", 68.0);
        second.low = Some(49.0);
        second.high = Some(120.0);
        let summary = summarize(&[first, second], &[Metric::HeartRate], today(), 14);
        let heart = &summary.metrics[0];
        assert_eq!(heart.total, None);
        assert_eq!(heart.lowest, Some(49.0));
        assert_eq!(heart.highest, Some(141.0));
        assert_eq!(heart.average, Some(69.6));
    }

    #[test]
    fn a_trend_needs_both_weeks() {
        let only_recent = vec![day(Metric::Sleep, "2026-10-14", 420.0)];
        let summary = summarize(&only_recent, &[Metric::Sleep], today(), 30);
        assert_eq!(summary.metrics[0].last_week_average, None);
        assert_eq!(summary.metrics[0].week_before_average, None);

        let both = vec![
            day(Metric::Sleep, "2026-10-14", 420.0),
            day(Metric::Sleep, "2026-10-10", 400.0),
            day(Metric::Sleep, "2026-10-05", 360.0),
        ];
        let summary = summarize(&both, &[Metric::Sleep], today(), 30);
        assert_eq!(summary.metrics[0].last_week_average, Some(410.0));
        assert_eq!(summary.metrics[0].week_before_average, Some(360.0));
    }

    #[test]
    fn a_metric_without_readings_is_said_to_have_none() {
        let summary = summarize(&[], &[Metric::Weight], today(), 30);
        let weight = &summary.metrics[0];
        assert_eq!(weight.days_with_data, 0);
        assert_eq!(weight.average, None);
        assert!(weight.daily.is_empty());
    }

    #[test]
    fn the_daily_list_is_newest_first_and_capped() {
        let rows: Vec<HealthDay> = (0..30)
            .map(|offset| {
                let date = today() - Duration::days(offset);
                day(Metric::Steps, &date.format("%Y-%m-%d").to_string(), 1000.0)
            })
            .collect();
        let summary = summarize(&rows, &[Metric::Steps], today(), 30);
        assert_eq!(summary.metrics[0].daily.len(), DAILY_LIMIT);
        assert_eq!(summary.metrics[0].daily[0].day, "2026-10-14");
    }
}
