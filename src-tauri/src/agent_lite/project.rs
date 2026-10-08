//! A phone chat filed in a project (ADR-0085): the project's instructions in
//! the system prompt, its files behind `search_project_files`, and its memory
//! scope for every memory read and write of the turn. Rebuilt every turn, like
//! the rest of the prompt, so an edit to the project reaches the next message.

use crate::db::repositories::Repositories;
use crate::projects::context::{self, ProjectContext};

pub(super) const TOOL: &str = "search_project_files";

/// The project of a turn's chat. A custom assistant's conversation runs on
/// its immutable snapshot (ADR-0058), so a project never reaches into it.
pub(super) async fn of_turn(
    repos: &Repositories,
    task_id: &str,
    custom_assistant: bool,
) -> Option<ProjectContext> {
    if custom_assistant {
        return None;
    }
    context::for_session(&repos.pool, task_id).await
}

pub(super) fn with_section(prompt: String, project: Option<&ProjectContext>) -> String {
    match project {
        Some(project) => format!("{prompt}\n\n{}", context::agent_lite_section(project)),
        None => prompt,
    }
}

/// The file search, offered only when the project has files to search.
pub(super) fn offer_tool(tools: &mut Vec<serde_json::Value>, project: Option<&ProjectContext>) {
    if project.is_some_and(|project| !project.file_names.is_empty()) {
        tools.push(context::search_tool_definition());
    }
}

pub(super) async fn run_tool(
    repos: &Repositories,
    project: &ProjectContext,
    args: &serde_json::Value,
) -> String {
    let query = args
        .get("query")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    crate::projects::files::search(&repos.pool, &project.folder_id, query).await
}
