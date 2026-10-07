//! The provider proxy's read routes for the `june_context` MCP: data the app
//! reads on this device and answers over loopback, because the MCP only holds
//! the notes database read-only and cannot reach EventKit, the embeddings or
//! the relevance screen (ADR-0064).

use std::io;

use tauri::AppHandle;

use super::write_json_response;

/// The day, for the agent: a window of the user's own calendar, read on this
/// device and answered here. Deliberately a retrieval route — the model asks
/// about a day and gets that day, and the planning is never injected into a
/// prompt (see `crate::calendar`).
pub(super) async fn forward_calendar_search(
    stream: &mut tokio::net::TcpStream,
    request_body: &[u8],
) -> io::Result<()> {
    let body = serde_json::from_slice::<serde_json::Value>(request_body)
        .unwrap_or_else(|_| serde_json::json!({}));
    let days = body
        .get("days")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(1)
        .clamp(-7, 7);
    let query = body
        .get("query")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    let now = chrono::Utc::now().timestamp();
    let (start, end) = if days >= 0 {
        (now - 12 * 3600, now + days.max(1) * 86_400)
    } else {
        (now + days * 86_400, now + 12 * 3600)
    };
    let events = crate::calendar::calendar_events_between(crate::calendar::CalendarWindowRequest {
        start,
        end,
    })
    .unwrap_or_default();
    let matching: Vec<serde_json::Value> = events
        .iter()
        .filter(|event| {
            query.is_empty()
                || event.title.to_lowercase().contains(&query)
                || event
                    .attendees
                    .iter()
                    .any(|name| name.to_lowercase().contains(&query))
        })
        .take(20)
        .map(|event| {
            serde_json::json!({
                "title": event.title,
                "start": crate::domain::types::rfc3339_from_epoch_secs(event.start),
                "end": crate::domain::types::rfc3339_from_epoch_secs(event.end),
                "allDay": event.all_day,
                "attendees": event.attendees,
            })
        })
        .collect();
    write_json_response(
        stream,
        200,
        serde_json::json!({ "success": true, "data": { "events": matching } }),
    )
    .await
}

/// What the MCP posts to search: a query and an optional bound.
#[derive(Debug, Default, serde::Deserialize)]
struct SearchBody {
    #[serde(default)]
    query: String,
    #[serde(default)]
    limit: Option<usize>,
}

/// The `projectId` a memory search names, when it comes from a project chat.
fn project_of(request_body: &[u8]) -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(request_body)
        .ok()?
        .get("projectId")?
        .as_str()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn search_body(request_body: &[u8]) -> (String, usize) {
    let body = serde_json::from_slice::<SearchBody>(request_body).unwrap_or_default();
    (
        body.query.trim().to_string(),
        body.limit.unwrap_or(8).clamp(1, 20),
    )
}

/// `search_meeting_notes`, answered by the same retrieval agent-lite uses
/// (`crate::ask::agent_note_search`): the old list, any-of-the-words passages
/// and meaning, fused and screened for relevance. The MCP keeps its own
/// SQLite search for when this route fails.
pub(super) async fn forward_notes_search(
    app: &AppHandle,
    stream: &mut tokio::net::TcpStream,
    request_body: &[u8],
) -> io::Result<()> {
    let (query, limit) = search_body(request_body);
    let found = async {
        let repos = crate::commands::repositories(app).await?;
        crate::ask::agent_note_search(&repos, &query, limit).await
    }
    .await;
    let body = match found {
        Ok(snippets) => {
            let items: Vec<serde_json::Value> = snippets
                .into_iter()
                .map(|snippet| {
                    serde_json::json!({
                        "id": snippet.note_id,
                        "title": if snippet.title.trim().is_empty() {
                            "Untitled note".to_string()
                        } else {
                            snippet.title
                        },
                        "kind": snippet.kind,
                        "snippet": snippet.snippet,
                        "updatedAt": snippet.updated_at,
                    })
                })
                .collect();
            serde_json::json!({
                "success": true,
                "data": { "query": query, "count": items.len(), "items": items },
            })
        }
        Err(error) => serde_json::json!({ "success": false, "message": error.message }),
    };
    write_json_response(stream, 200, body).await
}

/// `search_user_memories`, answered by `crate::memory::recall`: any word and
/// meaning, fused and screened. Memory switched off answers nothing, the same
/// as the MCP that is started without the tool.
pub(super) async fn forward_memories_search(
    app: &AppHandle,
    stream: &mut tokio::net::TcpStream,
    request_body: &[u8],
) -> io::Result<()> {
    let (query, limit) = search_body(request_body);
    let project = project_of(request_body);
    let found = async {
        let repos = crate::commands::repositories(app).await?;
        // A project that keeps its memory to itself is searched alone; any
        // other search reads the person's own memory (ADR-0085).
        let scope = match project {
            Some(folder) => {
                crate::projects::context::memory_scope_for_folder(&repos.pool, &folder).await
            }
            None => None,
        };
        crate::memory::recall::recall(&repos.with_memory_scope(scope), &query, limit).await
    }
    .await;
    let body = match found {
        Ok(memories) => {
            let items: Vec<serde_json::Value> = memories
                .into_iter()
                .map(|memory| {
                    serde_json::json!({
                        "id": memory.id,
                        "text": memory.text,
                        "importance": memory.importance,
                        "createdAt": memory.created_at,
                    })
                })
                .collect();
            serde_json::json!({
                "success": true,
                "data": { "query": query, "count": items.len(), "items": items },
            })
        }
        Err(error) => serde_json::json!({ "success": false, "message": error.message }),
    };
    write_json_response(stream, 200, body).await
}

#[cfg(test)]
mod tests {
    use super::search_body;

    #[test]
    fn a_search_body_is_trimmed_and_bounded() {
        assert_eq!(
            search_body(br#"{"query": "  budget  "}"#),
            ("budget".into(), 8)
        );
        assert_eq!(search_body(br#"{"query": "x", "limit": 99}"#).1, 20);
        assert_eq!(search_body(br#"{"query": "x", "limit": 0}"#).1, 1);
        assert_eq!(search_body(b"not json"), (String::new(), 8));
    }

    #[test]
    fn a_memory_search_names_its_project_or_none() {
        assert_eq!(
            super::project_of(br#"{"query":"x","projectId":" f-1 "}"#),
            Some("f-1".into())
        );
        assert_eq!(super::project_of(br#"{"query":"x","projectId":""}"#), None);
        assert_eq!(super::project_of(br#"{"query":"x"}"#), None);
    }
}
