//! Health and finances as the assistant sees them (ADR-0099): three read-only
//! tools, `health_summary`, `spending_summary` and `transactions_search`.
//!
//! Agent-lite offers them in a general conversation when there is something
//! to read, never to a custom assistant, and to a scheduled run only when
//! its definition ticks the "personal" group. The desktop's `june_personal`
//! MCP server (the context script, scoped to these three) reaches the same
//! answers through the app's local proxy ([`proxy_route`]), so the phone and
//! the computer describe the same figures with one implementation.

use crate::domain::types::AppError;
use serde_json::{json, Value};
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;

/// Adds the tools that have data behind them, and that a scheduled run's
/// scope allows (ADR-0091).
pub async fn offer(pool: &SqlitePool, tools: &mut Vec<Value>) {
    let mut found = Vec::new();
    if crate::health::tool::available(pool).await {
        found.push(crate::health::tool::definition());
    }
    if crate::finance::tool::available(pool).await {
        found.extend(crate::finance::tool::definitions());
    }
    tools.extend(found.into_iter().filter(|tool| {
        let name = tool
            .pointer("/function/name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        crate::assignments::lite::scoped_allows(name) != Some(false)
    }));
}

/// Runs the tool when it is one of these three. `None` hands it back.
pub async fn dispatch(pool: &SqlitePool, name: &str, args: &Value) -> Option<String> {
    match name {
        crate::health::tool::TOOL => Some(crate::health::tool::run(pool, args).await),
        crate::finance::tool::SPENDING_TOOL | crate::finance::tool::SEARCH_TOOL => {
            Some(crate::finance::tool::run(pool, name, args).await)
        }
        _ => None,
    }
}

async fn answer(pool: &SqlitePool, path: &str, args: &Value) -> Option<Result<Value, AppError>> {
    Some(match path {
        "/v1/health/summary" => crate::health::tool::answer(pool, args).await,
        "/v1/finance/spending" => crate::finance::tool::spending(pool, args).await,
        "/v1/finance/transactions" => crate::finance::tool::search(pool, args).await,
        _ => return None,
    })
}

/// The proxy's answer to a context MCP read, and its last route: anything
/// else is not found. A computer has no health store, so its health summary
/// is what a phone sent with the person's consent, and nothing else.
pub async fn proxy_route(app: &AppHandle, path: &str, body: &[u8]) -> (u16, Value) {
    let not_found = (404, json!({ "error": { "message": "Not found" } }));
    if !path.starts_with("/v1/health/") && !path.starts_with("/v1/finance/") {
        return not_found;
    }
    let args: Value = serde_json::from_slice(body).unwrap_or_else(|_| json!({}));
    let repos = match crate::commands::repositories(app).await {
        Ok(repos) => repos,
        Err(error) => return (500, json!({ "success": false, "message": error.message })),
    };
    match answer(&repos.pool, path, &args).await {
        Some(Ok(data)) => (200, json!({ "success": true, "data": data })),
        Some(Err(error)) => (400, json!({ "success": false, "message": error.message })),
        None => not_found,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::run_migrations(&pool).await.unwrap();
        pool
    }

    fn names(tools: &[Value]) -> Vec<String> {
        tools
            .iter()
            .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_string))
            .collect()
    }

    #[tokio::test]
    async fn nothing_is_offered_without_data_and_each_tool_with_its_own() {
        let pool = pool().await;
        let mut tools = Vec::new();
        offer(&pool, &mut tools).await;
        assert!(tools.is_empty());

        sqlx::query::query(
            "INSERT INTO health_days (id, metric, day, value, updated_at) VALUES ('a', 'steps', '2026-10-01', 5000, '')",
        )
        .execute(&pool)
        .await
        .unwrap();
        offer(&pool, &mut tools).await;
        assert_eq!(names(&tools), vec!["health_summary"]);

        sqlx::query::query(
            "INSERT INTO transactions (id, dedup_key, booked_on, amount_minor, description, created_at, updated_at)
             VALUES ('t', 'k', '2026-10-01', -500, 'Coop', '', '')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let mut tools = Vec::new();
        offer(&pool, &mut tools).await;
        assert_eq!(
            names(&tools),
            vec!["health_summary", "spending_summary", "transactions_search"]
        );
    }

    #[tokio::test]
    async fn the_proxy_answers_its_three_reads_and_nothing_else() {
        let pool = pool().await;
        for path in [
            "/v1/health/summary",
            "/v1/finance/spending",
            "/v1/finance/transactions",
        ] {
            assert!(
                matches!(answer(&pool, path, &json!({})).await, Some(Ok(_))),
                "{path}"
            );
        }
        assert!(answer(&pool, "/v1/finance/delete", &json!({}))
            .await
            .is_none());
        assert!(matches!(
            answer(&pool, "/v1/finance/spending", &json!({ "to": "soon" })).await,
            Some(Err(_))
        ));
    }

    #[tokio::test]
    async fn dispatch_answers_only_its_own_tools() {
        let pool = pool().await;
        assert!(dispatch(&pool, "search_notes", &json!({})).await.is_none());
        let answer = dispatch(&pool, "transactions_search", &json!({ "query": "coop" }))
            .await
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&answer).unwrap()["count"], 0);
        let answer = dispatch(&pool, "spending_summary", &json!({ "from": "not a day" }))
            .await
            .unwrap();
        assert!(serde_json::from_str::<Value>(&answer).unwrap()["error"].is_string());
    }
}
