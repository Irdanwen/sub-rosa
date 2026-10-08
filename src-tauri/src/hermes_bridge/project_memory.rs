//! "Project only" memory on the desktop, enforced where every Hermes request
//! passes: the provider proxy (ADR-0085 addendum).
//!
//! The SOUL is one file shared by every chat of the runtime, so it carries the
//! person's own memory into every chat, including one in a project that keeps
//! its memory apart. The proxy sees each request whole: the system message
//! (with the SOUL's marked memory section) and the chat's first message (with
//! the project context and its marker). When that project keeps its own
//! memory, the request leaves with the person's memory cut out and the
//! project's put in its place, with the memory tools held to the project, and
//! with any memory search that ran outside the project withheld from the
//! model. Hermes' own transcript is untouched; the cut is made again on every
//! request, so nothing depends on what the model was told earlier.

use crate::personalization::{MEMORY_END, MEMORY_START};
use crate::projects::context::project_in_message;
use serde_json::Value;
use std::collections::HashSet;

/// The `june_context` tools that read memory (Hermes names them
/// `mcp_june_context_<tool>`). Both take a `project_id`.
const MEMORY_TOOLS: &[&str] = &["search_user_memories", "search_past_chats"];

/// The project whose context the request carries: the latest user message
/// that has one, since a chat moved to another project is sent the new one.
pub(super) fn project_of_request(body: &Value) -> Option<String> {
    body.get("messages")?
        .as_array()?
        .iter()
        .rev()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .find_map(|message| project_in_message(&message_text(message.get("content")?)))
}

/// Holds a request to the project `folder_id` keeps its memory in.
/// `project_memory` replaces the person's memory section (`None` cuts it and
/// puts nothing back, as when memory is switched off). Returns whether a
/// memory section was found in the system message.
pub(super) fn confine_to_project(
    body: &mut Value,
    folder_id: &str,
    project_memory: Option<&str>,
) -> bool {
    let mut cut = false;
    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages.iter_mut() {
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            if role == "system" || role == "developer" {
                cut |= replace_memory_in_content(message.get_mut("content"), project_memory);
            }
        }
        withhold_unscoped_memory_results(messages, folder_id);
    }
    if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
        for tool in tools.iter_mut() {
            pin_project_id(tool, folder_id);
        }
    }
    cut
}

fn message_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn replace_memory_in_content(content: Option<&mut Value>, replacement: Option<&str>) -> bool {
    match content {
        Some(Value::String(text)) => replace_memory_section(text, replacement),
        Some(Value::Array(parts)) => {
            let mut cut = false;
            for part in parts.iter_mut() {
                if let Some(Value::String(text)) = part.get_mut("text") {
                    cut |= replace_memory_section(text, replacement);
                }
            }
            cut
        }
        _ => false,
    }
}

/// Every marked memory section in `text`, markers included, becomes
/// `replacement`. A start marker with no end after it is cut to the end of the
/// text: a truncated SOUL must not leak the rest of a section.
fn replace_memory_section(text: &mut String, replacement: Option<&str>) -> bool {
    let mut cut = false;
    let mut from = 0;
    while let Some(start) = text[from..].find(MEMORY_START).map(|at| from + at) {
        let end = text[start..]
            .find(MEMORY_END)
            .map_or(text.len(), |at| start + at + MEMORY_END.len());
        let insert = replacement.unwrap_or("").trim_end();
        text.replace_range(start..end, insert);
        from = start + insert.len();
        cut = true;
    }
    cut
}

fn is_memory_tool(name: &str) -> bool {
    MEMORY_TOOLS.iter().any(|tool| {
        name == *tool
            || name
                .strip_suffix(tool)
                .is_some_and(|prefix| prefix.ends_with('_'))
    })
}

/// A memory search the model ran without this project's id read the person's
/// memory (or another project's). Its result stays in Hermes' transcript but
/// never reaches the model: it is told to search again inside the project.
fn withhold_unscoped_memory_results(messages: &mut [Value], folder_id: &str) {
    let mut unscoped = HashSet::new();
    for message in messages.iter() {
        let Some(calls) = message.get("tool_calls").and_then(Value::as_array) else {
            continue;
        };
        for call in calls {
            let Some(function) = call.get("function") else {
                continue;
            };
            let name = function.get("name").and_then(Value::as_str).unwrap_or("");
            if !is_memory_tool(name) {
                continue;
            }
            let project = function
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|arguments| serde_json::from_str::<Value>(arguments).ok())
                .and_then(|arguments| {
                    arguments
                        .get("project_id")
                        .and_then(Value::as_str)
                        .map(|id| id.trim().to_string())
                });
            if project.as_deref() != Some(folder_id) {
                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    unscoped.insert(id.to_string());
                }
            }
        }
    }
    if unscoped.is_empty() {
        return;
    }
    let notice = serde_json::json!({
        "items": [],
        "message": format!(
            "This conversation is in a project that keeps its own memory. Search again with project_id \"{folder_id}\"."
        ),
    })
    .to_string();
    for message in messages.iter_mut() {
        if message.get("role").and_then(Value::as_str) != Some("tool") {
            continue;
        }
        let answers_unscoped = message
            .get("tool_call_id")
            .and_then(Value::as_str)
            .is_some_and(|id| unscoped.contains(id));
        if answers_unscoped {
            message["content"] = Value::String(notice.clone());
        }
    }
}

/// The memory tools offered to this request take only this project's id.
fn pin_project_id(tool: &mut Value, folder_id: &str) {
    let Some(function) = tool.get_mut("function") else {
        return;
    };
    let name = function.get("name").and_then(Value::as_str).unwrap_or("");
    if !is_memory_tool(name) {
        return;
    }
    let Some(parameters) = function
        .get_mut("parameters")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let properties = parameters
        .entry("properties")
        .or_insert_with(|| serde_json::json!({}));
    if let Some(properties) = properties.as_object_mut() {
        properties.insert(
            "project_id".to_string(),
            serde_json::json!({
                "type": "string",
                "enum": [folder_id],
                "description": "This conversation's project. Always pass it.",
            }),
        );
    }
    let required = parameters
        .entry("required")
        .or_insert_with(|| serde_json::json!([]));
    if let Some(required) = required.as_array_mut() {
        if !required.iter().any(|field| field == "project_id") {
            required.push(Value::String("project_id".to_string()));
        }
    }
}

/// Reads which project the request is in and, when that project keeps its
/// own memory, confines the request to it. A project in Default mode, a
/// deleted one, or a request with no project context goes out unchanged.
pub(super) async fn apply(app: &tauri::AppHandle, body: &mut Value) {
    let Some(folder_id) = project_of_request(body) else {
        return;
    };
    match crate::commands::repositories(app).await {
        Ok(repos) => apply_with(&repos, body).await,
        Err(error) => {
            // Which mode the project is in cannot be read: cut the person's
            // memory rather than risk sending it into a project-only chat.
            tracing::warn!(
                "Project memory scope unreadable, cutting user memory: {}",
                error.message
            );
            confine_to_project(body, &folder_id, None);
        }
    }
}

async fn apply_with(repos: &crate::db::repositories::Repositories, body: &mut Value) {
    let Some(folder_id) = project_of_request(body) else {
        return;
    };
    let Some(project) = crate::projects::context::for_folder(&repos.pool, &folder_id).await else {
        return;
    };
    let Some(scope) = project.memory_scope() else {
        return;
    };
    let memory = crate::projects::context::project_memory_block(repos, &scope).await;
    confine_to_project(body, &scope, memory.as_deref());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::context::project_marker;

    const PROJECT: &str = "7f0c2a64-5b1e-4c55-9f62-1a2b3c4d5e6f";

    fn soul(memory: &str) -> String {
        format!(
            "You are Sub Rosa.\n\n<!-- sub-rosa:personal-context -->\nPersonalization: be brief.\n\n{MEMORY_START}\n{memory}{MEMORY_END}\nEarlier conversations: search them.\n<!-- /sub-rosa:personal-context -->\n## Context\nTools.\n"
        )
    }

    fn first_message(project: Option<&str>) -> String {
        match project {
            Some(id) => format!(
                "What did we decide?\n\n--- Attached Context ---\n\n{}\nProject context: this conversation is part of the user's project \"Launch\" (project id {id}).",
                project_marker(id)
            ),
            None => "What did we decide?".to_string(),
        }
    }

    /// The shape Hermes sends: the SOUL in the system message, the chat's
    /// first message with the project context, a memory search and its
    /// result, and the memory tools on offer.
    fn request(project: Option<&str>, search_args: &str) -> Value {
        serde_json::json!({
            "model": "zai-org-glm-5-2",
            "stream": true,
            "messages": [
                { "role": "system", "content": soul("User memory: durable facts.\n- Lives in Lausanne\n- Daughter is called Léa\n") },
                { "role": "user", "content": first_message(project) },
                { "role": "assistant", "content": null, "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": { "name": "mcp_june_context_search_user_memories", "arguments": search_args }
                }]},
                { "role": "tool", "tool_call_id": "call_1", "content": "{\"items\":[{\"text\":\"Lives in Lausanne\"}]}" },
                { "role": "user", "content": "And the budget?" }
            ],
            "tools": [
                { "type": "function", "function": {
                    "name": "mcp_june_context_search_user_memories",
                    "parameters": { "type": "object", "properties": {
                        "query": { "type": "string" },
                        "project_id": { "type": "string" }
                    }}
                }},
                { "type": "function", "function": {
                    "name": "mcp_june_context_search_notes",
                    "parameters": { "type": "object", "properties": { "query": { "type": "string" } } }
                }}
            ]
        })
    }

    #[test]
    fn the_project_is_read_from_the_marker_after_the_context_marker() {
        assert_eq!(
            project_of_request(&request(Some(PROJECT), "{}")).as_deref(),
            Some(PROJECT)
        );
        assert_eq!(project_of_request(&request(None, "{}")), None);
        // A marker typed into a person's own words is not a project context.
        let typed = serde_json::json!({ "messages": [
            { "role": "user", "content": format!("look: {}", project_marker(PROJECT)) }
        ]});
        assert_eq!(project_of_request(&typed), None);
        // Nor is one inside a system or tool message.
        let elsewhere = serde_json::json!({ "messages": [
            { "role": "tool", "content": first_message(Some(PROJECT)) }
        ]});
        assert_eq!(project_of_request(&elsewhere), None);
        // A content array is read like a string; the latest context wins.
        let moved = serde_json::json!({ "messages": [
            { "role": "user", "content": first_message(Some("old-project")) },
            { "role": "user", "content": [{ "type": "text", "text": first_message(Some(PROJECT)) }] }
        ]});
        assert_eq!(project_of_request(&moved).as_deref(), Some(PROJECT));
    }

    #[test]
    fn a_project_only_request_loses_the_users_memory_and_gets_the_projects() {
        let mut body = request(Some(PROJECT), "{\"query\":\"home\"}");
        let project_memory =
            crate::projects::context::format_project_memory_block(
                &["Launch moved to March".into()],
            );

        assert!(confine_to_project(
            &mut body,
            PROJECT,
            Some(&project_memory)
        ));

        let system = body["messages"][0]["content"].as_str().unwrap();
        assert!(!system.contains("Lausanne"));
        assert!(!system.contains("Léa"));
        assert!(!system.contains(MEMORY_START));
        assert!(system.contains("- Launch moved to March"));
        // Everything around the memory is kept: identity, personalization,
        // the past-chats line, the rest of the SOUL.
        assert!(system.starts_with("You are Sub Rosa."));
        assert!(system.contains("Personalization: be brief."));
        assert!(system.contains("Earlier conversations: search them."));
        assert!(system.ends_with("## Context\nTools.\n"));

        // The search that ran without the project's id is withheld.
        let result = body["messages"][3]["content"].as_str().unwrap();
        assert!(!result.contains("Lausanne"));
        assert!(result.contains(PROJECT));
        // The memory tool takes only this project; other tools are as sent.
        let pinned = &body["tools"][0]["function"]["parameters"];
        assert_eq!(pinned["properties"]["project_id"]["enum"][0], PROJECT);
        assert_eq!(pinned["required"], serde_json::json!(["project_id"]));
        assert!(body["tools"][1]["function"]["parameters"]["properties"]
            .get("project_id")
            .is_none());
        // The rest of the request is untouched.
        assert_eq!(body["model"], "zai-org-glm-5-2");
        assert_eq!(body["messages"][4]["content"], "And the budget?");
    }

    #[test]
    fn a_search_inside_the_project_reaches_the_model() {
        let mut body = request(
            Some(PROJECT),
            &format!("{{\"query\":\"budget\",\"project_id\":\" {PROJECT} \"}}"),
        );
        confine_to_project(&mut body, PROJECT, None);
        assert!(body["messages"][3]["content"]
            .as_str()
            .unwrap()
            .contains("Lausanne"));
        // A cut with nothing to put back leaves no memory at all.
        let system = body["messages"][0]["content"].as_str().unwrap();
        assert!(!system.contains("Lausanne") && !system.contains("Project memory"));
    }

    #[test]
    fn a_search_in_another_project_or_with_unreadable_arguments_is_withheld() {
        for arguments in ["{\"project_id\":\"another\"}", "not json"] {
            let mut body = request(Some(PROJECT), arguments);
            confine_to_project(&mut body, PROJECT, None);
            assert!(!body["messages"][3]["content"]
                .as_str()
                .unwrap()
                .contains("Lausanne"));
        }
    }

    #[test]
    fn a_soul_without_markers_is_left_as_it_is() {
        let mut body = request(Some(PROJECT), "{}");
        body["messages"][0]["content"] =
            Value::String("You are Sub Rosa.\nUser memory:\n- Lives in Lausanne\n".into());
        let before = body["messages"][0].clone();
        assert!(!confine_to_project(
            &mut body,
            PROJECT,
            Some("Project memory:\n")
        ));
        assert_eq!(body["messages"][0], before);
    }

    #[test]
    fn a_system_message_in_parts_and_a_cut_off_section_are_both_cut() {
        let mut body = serde_json::json!({ "messages": [
            { "role": "system", "content": [
                { "type": "text", "text": soul("User memory:\n- Lives in Lausanne\n") },
                { "type": "text", "text": format!("Tail {MEMORY_START}\n- Daughter is called Léa") }
            ]}
        ]});
        assert!(confine_to_project(
            &mut body,
            PROJECT,
            Some("Project memory:\n- none\n")
        ));
        let parts = body["messages"][0]["content"].as_array().unwrap();
        let first = parts[0]["text"].as_str().unwrap();
        assert!(!first.contains("Lausanne") && first.contains("Project memory:\n- none"));
        assert_eq!(parts[1]["text"], "Tail Project memory:\n- none");
    }

    #[test]
    fn tool_names_match_with_or_without_the_server_prefix() {
        assert!(is_memory_tool("search_user_memories"));
        assert!(is_memory_tool("mcp_june_context_search_past_chats"));
        assert!(!is_memory_tool("mcp_june_context_search_notes"));
        assert!(!is_memory_tool("xsearch_user_memories"));
    }

    /// The whole path with a store: a Default project and a chat outside any
    /// project leave the request as Hermes sent it; a "Project only" project
    /// swaps the memory for its own.
    #[tokio::test]
    async fn the_projects_mode_in_the_store_decides() {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::run_migrations(&pool).await.unwrap();
        let repos = crate::db::repositories::Repositories::new(pool);
        for (id, mode) in [("project-only", "project"), ("default-mode", "default")] {
            sqlx::query::query(
                "INSERT INTO folders (id, name, created_at, updated_at) VALUES (?, 'P', 'now', 'now')",
            )
            .bind(id)
            .execute(&repos.pool)
            .await
            .unwrap();
            crate::projects::save_settings(&repos.pool, id, "", mode)
                .await
                .unwrap();
        }
        repos
            .with_memory_scope(Some("project-only".into()))
            .insert_memory(
                "Launch moved to March",
                crate::domain::types::MemorySource::Manual,
                2,
            )
            .await
            .unwrap();

        for untouched in [Some("default-mode"), Some("deleted-project"), None] {
            let mut body = request(untouched, "{}");
            let before = body.clone();
            apply_with(&repos, &mut body).await;
            assert_eq!(body, before, "{untouched:?}");
        }
        let mut body = request(Some("project-only"), "{}");
        apply_with(&repos, &mut body).await;
        let system = body["messages"][0]["content"].as_str().unwrap();
        assert!(!system.contains("Lausanne"));
        if crate::memory::settings().enabled {
            assert!(system.contains("- Launch moved to March"));
        }
    }
}
