//! The research engine's world in the app: the sidecar for completions and
//! for the web, the person's notes and project files, and the notes list for
//! the report. The same seams agent-lite's tools use (`/v1/web/search`,
//! `/v1/web/fetch`, `ask::agent_note_search`, `projects::files::search`), so
//! a source reads the same in a chat and in a report.

use tauri::AppHandle;

use super::engine::Backend;
use super::store::{Found, RunRow};
use crate::domain::types::AppError;
use crate::june_api;

/// Every request a run makes is tagged so in the egress ledger (ADR-0044).
const PURPOSE: &str = "research";

pub struct LiveBackend {
    app: AppHandle,
    model: String,
}

impl LiveBackend {
    pub fn new(app: AppHandle, model: String) -> Self {
        Self { app, model }
    }
}

/// A web result's address as the key a run files it under: without its
/// fragment and trailing slash, so the same page found twice is one source.
pub fn source_key(url: &str) -> String {
    let url = url.trim();
    let url = url.split('#').next().unwrap_or(url);
    url.trim_end_matches('/').to_string()
}

/// The web handler's results as finds. Only http(s) addresses are kept: a
/// source the app cannot open is not one it can cite.
pub fn web_results(body: &[u8]) -> Vec<Found> {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let Some(results) = value
        .pointer("/data/results")
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };
    results
        .iter()
        .filter_map(|result| {
            let url = result.get("url")?.as_str()?.trim();
            let lower = url.to_ascii_lowercase();
            if !(lower.starts_with("https://") || lower.starts_with("http://")) {
                return None;
            }
            let title = result
                .get("title")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .unwrap_or(url);
            Some(Found {
                kind: "web",
                key: source_key(url),
                title: title.chars().take(200).collect(),
                url: Some(url.to_string()),
                note_id: None,
                excerpt: result
                    .get("snippet")
                    .and_then(serde_json::Value::as_str)
                    .map(|snippet| snippet.chars().take(500).collect()),
            })
        })
        .collect()
}

/// What connected apps (mail, drive, calendar) know about a query: the
/// connectors the person picked for this run (ADR-0092). Their finds are filed
/// with kind `connector` and read like the person's notes are, from the
/// passages they return.
async fn connector_sources(app: &AppHandle, run: &RunRow, query: &str) -> Vec<Found> {
    crate::connectors::research::sources(app, &run.id, query).await
}

impl Backend for LiveBackend {
    async fn complete(
        &self,
        system: &str,
        user: &str,
        max_tokens: u32,
    ) -> Result<String, AppError> {
        crate::egress_ledger::scoped(PURPOSE, None, async {
            let response = june_api::proxy_agent_chat_completions(serde_json::json!({
                "model": self.model,
                "messages": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": user }
                ],
                "temperature": 0.3,
                "max_tokens": max_tokens
            }))
            .await?;
            if !(200..300).contains(&response.status) {
                return Err(AppError::new(
                    "research_model_failed",
                    format!("The model returned status {}.", response.status),
                ));
            }
            let body = response.collect_body().await?;
            let value: serde_json::Value = serde_json::from_slice(&body)
                .map_err(|error| AppError::new("research_model_failed", error.to_string()))?;
            june_api::extract_chat_completion_text(&value)
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty())
                .ok_or_else(|| {
                    AppError::new("research_model_failed", "The model returned no text.")
                })
        })
        .await
    }

    async fn web_search(&self, query: &str, limit: usize) -> Result<Vec<Found>, AppError> {
        let body = serde_json::json!({
            "query": query,
            "limit": limit,
            // The handler scopes metering by it, and rejects a request
            // without one.
            "requestId": uuid::Uuid::new_v4().to_string(),
        });
        let response = crate::egress_ledger::scoped(
            PURPOSE,
            None,
            june_api::forward_web_request("/v1/web/search", &body),
        )
        .await?;
        if !(200..300).contains(&response.status) {
            tracing::warn!(status = response.status, "research search refused");
            return Ok(Vec::new());
        }
        Ok(web_results(&response.body))
    }

    async fn fetch_page(&self, url: &str) -> Result<Option<String>, AppError> {
        let body = serde_json::json!({
            "url": url,
            "requestId": uuid::Uuid::new_v4().to_string(),
        });
        let response = crate::egress_ledger::scoped(
            PURPOSE,
            None,
            june_api::forward_web_request("/v1/web/fetch", &body),
        )
        .await?;
        if !(200..300).contains(&response.status) {
            return Ok(None);
        }
        Ok(serde_json::from_slice::<serde_json::Value>(&response.body)
            .ok()
            .and_then(|value| {
                value
                    .pointer("/data/content")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
            .filter(|text| !text.trim().is_empty()))
    }

    async fn own_sources(&self, run: &RunRow, query: &str) -> Vec<Found> {
        let Ok(repos) = crate::commands::repositories(&self.app).await else {
            return Vec::new();
        };
        let mut found = Vec::new();
        match crate::ask::agent_note_search(&repos, query, 4).await {
            Ok(snippets) => found.extend(snippets.into_iter().map(|snippet| Found {
                kind: "note",
                key: format!("note:{}", snippet.note_id),
                title: if snippet.title.trim().is_empty() {
                    "Untitled note".to_string()
                } else {
                    snippet.title
                },
                url: None,
                note_id: Some(snippet.note_id),
                excerpt: Some(snippet.snippet),
            })),
            Err(error) => tracing::warn!(code = %error.code, "research note search failed"),
        }
        if let Some(folder) = run.project_id.as_deref() {
            if let Some(project) = crate::projects::context::for_folder(&repos.pool, folder).await {
                if !project.file_names.is_empty() {
                    let passages = crate::projects::files::search(&repos.pool, folder, query).await;
                    // The search answers in words when it has nothing; only
                    // passages are a source.
                    let empty = passages.starts_with("No passage")
                        || passages.starts_with("This project has no")
                        || passages.starts_with("Project file search failed");
                    if !empty {
                        found.push(Found {
                            kind: "project_file",
                            key: format!("project:{folder}:{}", query.trim().to_lowercase()),
                            title: project.name,
                            url: None,
                            note_id: None,
                            excerpt: Some(passages.chars().take(6_000).collect()),
                        });
                    }
                }
            }
        }
        found.extend(connector_sources(&self.app, run, query).await);
        found
    }

    async fn save_report(&self, title: &str, body: &str) -> Result<String, AppError> {
        Ok(crate::agent_notes::create(&self.app, Some(title), body)
            .await?
            .id)
    }
}
