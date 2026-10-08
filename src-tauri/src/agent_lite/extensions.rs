//! What a turn gains beyond its own tools: the person's connectors and skill
//! packs (ADR-0092). Kept apart from the loop so `mod.rs` only asks two
//! questions: what to add before the first completion, and whether a tool
//! call belongs here.

use serde_json::Value;
use tauri::AppHandle;

use crate::db::repositories::Repositories;
use crate::skill_packs::agent::SkillTurn;

pub(super) struct TurnExtensions {
    skills: SkillTurn,
    connectors_note: Option<&'static str>,
}

/// Adds the connectors' and skills' tools to the turn. Only a general
/// conversation gets either: a custom assistant keeps what its definition
/// grants (ADR-0058).
pub(super) async fn prepare(
    repos: &Repositories,
    task_id: &str,
    last_message: &str,
    custom_assistant: bool,
    tools: &mut Vec<Value>,
) -> TurnExtensions {
    if custom_assistant {
        return TurnExtensions {
            skills: SkillTurn::default(),
            connectors_note: None,
        };
    }
    let connectors_note =
        crate::connectors::agent::offer(&repos.pool, task_id, tools, custom_assistant).await;
    let skills = crate::skill_packs::agent::for_turn(&repos.pool, last_message).await;
    skills.apply(tools);
    TurnExtensions {
        skills,
        connectors_note,
    }
}

impl TurnExtensions {
    pub(super) fn system_prompt(&self, base: String) -> String {
        let base = match self.connectors_note {
            Some(note) => format!("{base}\n\n{note}"),
            None => base,
        };
        self.skills.system_prompt(base)
    }
}

/// Runs the tool when it is a connector's or `load_skill`. `None` hands it
/// back to the loop's own tools.
pub(super) async fn dispatch(
    app: &AppHandle,
    repos: &Repositories,
    task_id: &str,
    name: &str,
    args: &Value,
) -> Option<String> {
    if name == crate::skill_packs::agent::TOOL {
        return Some(crate::skill_packs::agent::load(&repos.pool, args).await);
    }
    crate::connectors::agent::dispatch(app, &repos.pool, task_id, name, args).await
}
