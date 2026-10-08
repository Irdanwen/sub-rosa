//! Connector sources in deep research (ADR-0089's `connector_sources` hook).
//!
//! The person picks the connectors a run may search when they start it; the
//! choice is a row per connector, kept on this device with the run. Each step
//! then asks every chosen connector's search tool for the step's query, and
//! what comes back is a source like a note: filed with kind `connector`, read
//! from the passage it returned. Only a tool that runs without asking is
//! used: a report is no place for a confirmation card.

use std::time::Duration;

use serde_json::{json, Value};
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;

use super::mcp::ToolInfo;
use super::policy::{self, Rule};
use crate::domain::types::AppError;
use crate::research::store::Found;

const PER_SOURCE: Duration = Duration::from_secs(20);
pub(crate) const EXCERPT_CHARS: usize = 4_000;
pub(crate) const MAX_CONNECTORS: usize = 6;

pub async fn set_for_run(pool: &SqlitePool, run_id: &str, ids: &[String]) -> Result<(), AppError> {
    for id in ids.iter().take(MAX_CONNECTORS) {
        query("INSERT OR IGNORE INTO research_connector_sources(run_id,connector_id) VALUES(?,?)")
            .bind(run_id)
            .bind(id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

pub async fn for_run(pool: &SqlitePool, run_id: &str) -> Vec<String> {
    query("SELECT connector_id FROM research_connector_sources WHERE run_id=?")
        .bind(run_id)
        .fetch_all(pool)
        .await
        .map(|rows| rows.iter().map(|row| row.get("connector_id")).collect())
        .unwrap_or_default()
}

/// The text field a search tool takes its query in, if it has one.
fn query_field(tool: &ToolInfo) -> Option<&'static str> {
    let properties = tool.input_schema.get("properties")?.as_object()?;
    ["query", "q", "search", "searchQuery", "text", "keywords"]
        .into_iter()
        .find(|key| {
            properties
                .get(*key)
                .and_then(|schema| schema.get("type"))
                .and_then(Value::as_str)
                .map_or(true, |kind| kind == "string")
                && properties.contains_key(*key)
        })
}

/// The tool a connector searches with in a report: one that reads, runs
/// without asking, is named for searching, and takes a text query.
pub fn search_tool<'a>(
    tools: &'a [ToolInfo],
    rules: &std::collections::BTreeMap<String, String>,
) -> Option<(&'a ToolInfo, &'static str)> {
    tools
        .iter()
        .filter(|tool| policy::effective(rules, tool) == Rule::Allow)
        .filter(|tool| {
            let name = tool.name.to_ascii_lowercase();
            name.contains("search") || name.contains("find") || name.contains("query")
        })
        .find_map(|tool| query_field(tool).map(|field| (tool, field)))
}

/// What the chosen connectors know about one query.
pub async fn sources(app: &AppHandle, run_id: &str, search: &str) -> Vec<Found> {
    let Ok(pool) = super::pool(app).await else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for id in for_run(&pool, run_id).await {
        let Ok(connector) = super::get(&pool, &id).await else {
            continue;
        };
        if !connector.enabled || !super::has_credential(&connector) {
            continue;
        }
        let tools = if connector.builtin() {
            super::builtin::tools_for(&connector.auth)
        } else {
            super::state(&pool, &connector.id).await.tools
        };
        let Some((tool, field)) = search_tool(&tools, &connector.tool_policy) else {
            continue;
        };
        let arguments = json!({ field: search });
        let call = super::runtime::call_tool(&pool, &connector, &tool.name, &arguments);
        let result = crate::egress_ledger::scoped("research", None, async {
            tokio::time::timeout(PER_SOURCE, call).await
        })
        .await;
        let Ok(Ok(result)) = result else {
            tracing::warn!(connector = %connector.id, "research connector search failed");
            continue;
        };
        let text = super::mcp::result_text(&result, EXCERPT_CHARS);
        if text.starts_with("The tool returned nothing") || text.starts_with("No ") {
            continue;
        }
        found.push(Found {
            kind: "connector",
            key: format!(
                "connector:{}:{}",
                connector.id,
                search.trim().to_lowercase()
            ),
            title: format!("{} search: {}", connector.name, search.trim())
                .chars()
                .take(200)
                .collect(),
            url: super::mcp::result_links(&result)
                .into_iter()
                .map(|(_, url)| url)
                .next(),
            note_id: None,
            excerpt: Some(text),
        });
    }
    found
}
