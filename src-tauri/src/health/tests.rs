//! Health days folded in, chosen, forgotten, and sent only per measure.

use super::*;
use sqlx::query::query;
use sqlx::row::Row as _;

async fn pool() -> SqlitePool {
    let pool = sqlx_sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    crate::db::migrations::run_migrations(&pool).await.unwrap();
    pool
}

fn reading(metric: &str, day: &str, value: f64) -> HealthDay {
    HealthDay {
        metric: metric.into(),
        day: day.into(),
        value,
        low: None,
        high: None,
        samples: 0,
    }
}

#[tokio::test]
async fn a_day_read_again_unchanged_is_left_alone() {
    let pool = pool().await;
    let steps = reading("steps", "2026-10-01", 8_412.0);
    assert_eq!(store::upsert(&pool, &steps, "healthkit").await.unwrap(), 1);
    assert_eq!(store::upsert(&pool, &steps, "healthkit").await.unwrap(), 0);
    let mut more = steps.clone();
    more.value = 9_001.0;
    assert_eq!(store::upsert(&pool, &more, "healthkit").await.unwrap(), 1);
    let days = days_between(
        &pool,
        parse_day("2026-09-01").unwrap(),
        parse_day("2026-10-31").unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(days, vec![more]);
    assert!(
        store::upsert(&pool, &reading("blood_sugar", "2026-10-01", 1.0), "x")
            .await
            .is_err()
    );
    assert!(
        store::upsert(&pool, &reading("steps", "yesterday", 1.0), "x")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn choosing_keeps_what_was_set_aside_and_forgetting_deletes() {
    let pool = pool().await;
    store::set_enabled(&pool, &[Metric::Steps, Metric::Sleep])
        .await
        .unwrap();
    store::upsert(&pool, &reading("steps", "2026-10-01", 5_000.0), "x")
        .await
        .unwrap();
    store::upsert(&pool, &reading("sleep", "2026-10-01", 410.0), "x")
        .await
        .unwrap();
    store::set_enabled(&pool, &[Metric::Sleep]).await.unwrap();
    let state = status(&pool).await.unwrap();
    let steps = state.metrics.iter().find(|m| m.metric == "steps").unwrap();
    assert!(!steps.enabled);
    assert_eq!(steps.days, 1);
    assert_eq!(enabled_metrics(&pool).await.unwrap(), vec![Metric::Sleep]);
    // A computer reads nothing and says where the data comes from.
    assert_eq!(state.source, "none");
    assert_eq!(state.availability, "elsewhere");
    assert_eq!(refresh(&pool, 14).await.unwrap(), 0);

    store::forget(&pool, Some(Metric::Steps)).await.unwrap();
    let state = status(&pool).await.unwrap();
    assert_eq!(
        state
            .metrics
            .iter()
            .find(|m| m.metric == "steps")
            .unwrap()
            .days,
        0
    );
    assert_eq!(
        state
            .metrics
            .iter()
            .find(|m| m.metric == "sleep")
            .unwrap()
            .days,
        1
    );
    store::forget(&pool, None).await.unwrap();
    assert!(status(&pool)
        .await
        .unwrap()
        .metrics
        .iter()
        .all(|m| m.days == 0));
}

#[tokio::test]
async fn a_measure_leaves_only_with_its_own_sync() {
    let pool = pool().await;
    query("UPDATE account_sync_control SET account_id='account-one' WHERE id=1")
        .execute(&pool)
        .await
        .unwrap();
    let queued = |pool: SqlitePool| async move {
        query("SELECT json_extract(body,'$.row.metric') AS metric FROM account_sync_outbox WHERE json_extract(body,'$.table')='health_days'")
            .fetch_all(&pool)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get::<String, _>("metric"))
            .collect::<Vec<_>>()
    };
    store::set_enabled(&pool, &[Metric::Steps, Metric::Weight])
        .await
        .unwrap();
    store::upsert(&pool, &reading("steps", "2026-10-01", 5_000.0), "x")
        .await
        .unwrap();
    store::upsert(&pool, &reading("weight", "2026-10-01", 72.4), "x")
        .await
        .unwrap();
    assert!(queued(pool.clone()).await.is_empty());

    store::set_sync(&pool, Metric::Steps, true).await.unwrap();
    crate::account::sync::enqueue_existing(&pool, "health_days", "metric='steps'")
        .await
        .unwrap();
    assert_eq!(queued(pool.clone()).await, vec!["steps"]);
    store::upsert(&pool, &reading("steps", "2026-10-02", 6_000.0), "x")
        .await
        .unwrap();
    store::upsert(&pool, &reading("weight", "2026-10-02", 72.1), "x")
        .await
        .unwrap();
    assert_eq!(queued(pool.clone()).await, vec!["steps", "steps"]);
    let state = status(&pool).await.unwrap();
    assert!(
        state
            .metrics
            .iter()
            .find(|m| m.metric == "steps")
            .unwrap()
            .sync
    );
    assert!(
        !state
            .metrics
            .iter()
            .find(|m| m.metric == "weight")
            .unwrap()
            .sync
    );
}

#[tokio::test]
async fn the_tool_summarises_what_is_stored() {
    let pool = pool().await;
    let today = today();
    for offset in 0..3 {
        let day = day_text(today - Duration::days(offset));
        store::upsert(
            &pool,
            &reading("steps", &day, 6_000.0 + offset as f64 * 1_000.0),
            "x",
        )
        .await
        .unwrap();
    }
    let answer = tool::answer(&pool, &serde_json::json!({ "days": 7 }))
        .await
        .unwrap();
    assert_eq!(answer["metrics"].as_array().unwrap().len(), 1);
    assert_eq!(answer["metrics"][0]["metric"], "steps");
    assert_eq!(answer["metrics"][0]["average"], 7000.0);
    assert_eq!(answer["metrics"][0]["total"], 21000.0);
    let none = tool::answer(&pool, &serde_json::json!({ "metrics": ["weight"] }))
        .await
        .unwrap();
    assert_eq!(none["metrics"][0]["daysWithData"], 0);
    let empty = tool::answer(&pool, &serde_json::json!({ "days": 1, "metrics": [] }))
        .await
        .unwrap();
    assert!(empty["metrics"].as_array().unwrap().len() <= 1);
    let text = tool::run(&pool, &serde_json::json!({})).await;
    assert!(text.contains("\"steps\""));
}
