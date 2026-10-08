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

/// Adds the connectors' and skills' tools to the turn. A general
/// conversation gets every connector and the skill packs; a custom assistant
/// only the connectors its definition names, and no skill pack (ADR-0058).
pub(super) async fn prepare(
    repos: &Repositories,
    task_id: &str,
    last_message: &str,
    grant: &crate::connectors::agent::Grant,
    tools: &mut Vec<Value>,
) -> TurnExtensions {
    let connectors_note = crate::connectors::agent::offer(&repos.pool, task_id, tools, grant).await;
    if *grant != crate::connectors::agent::Grant::General {
        return TurnExtensions {
            skills: SkillTurn::default(),
            connectors_note,
        };
    }
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
