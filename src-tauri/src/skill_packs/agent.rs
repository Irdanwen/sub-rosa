//! Skill packs in an agent-lite turn: the descriptions on offer, the body
//! when one is picked, and the narrowing it brings.

use serde_json::{json, Value};
use sqlx_sqlite::SqlitePool;

use super::{list, SkillPack};

pub const TOOL: &str = "load_skill";
/// Most skills described in one turn's instructions.
pub(crate) const MAX_OFFERED: usize = 30;

/// `load_skill`'s answer when no enabled pack has that name.
pub(crate) fn missing(name: &str) -> String {
    format!("No enabled skill is called {name}.")
}
pub(crate) const UNREADABLE: &str = "The skills could not be read.";

/// What a turn takes from the skills.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct SkillTurn {
    /// Joins the system prompt.
    pub prompt: Option<String>,
    /// The tools a picked skill narrows the turn to, when it names any.
    pub narrow: Vec<String>,
    /// Whether `load_skill` is offered.
    pub offer_loader: bool,
}

/// The pack a message picks with `/name` at its start, if any.
pub fn picked<'a>(packs: &'a [SkillPack], message: &str) -> Option<&'a SkillPack> {
    let rest = message.trim_start().strip_prefix('/')?;
    let name: String = rest.chars().take_while(|c| !c.is_whitespace()).collect();
    packs.iter().find(|pack| pack.enabled && pack.name == name)
}

pub fn body_block(pack: &SkillPack) -> String {
    format!(
        "<skill name=\"{}\">\n{}\n</skill>",
        pack.name,
        pack.body.replace("</skill>", "</ skill>")
    )
}

/// What the skills give one turn, from the packs and the user's message.
pub fn plan(packs: &[SkillPack], message: &str) -> SkillTurn {
    if let Some(pack) = picked(packs, message) {
        return SkillTurn {
            prompt: Some(format!(
                "The user picked the skill \"{}\" for this message. Follow its instructions for this turn:\n{}",
                pack.name,
                body_block(pack)
            )),
            narrow: pack.tools.clone(),
            offer_loader: false,
        };
    }
    let offered: Vec<&SkillPack> = packs
        .iter()
        .filter(|pack| pack.enabled)
        .take(MAX_OFFERED)
        .collect();
    if offered.is_empty() {
        return SkillTurn::default();
    }
    let lines: Vec<String> = offered
        .iter()
        .map(|pack| format!("- {}: {}", pack.name, pack.description))
        .collect();
    SkillTurn {
        prompt: Some(format!(
            "Skills: the user installed these instruction packs. When one fits the request, call load_skill with its name and follow what it says.\n{}",
            lines.join("\n")
        )),
        narrow: Vec::new(),
        offer_loader: true,
    }
}

pub async fn for_turn(pool: &SqlitePool, message: &str) -> SkillTurn {
    match list(pool).await {
        Ok(packs) => plan(&packs, message),
        Err(_) => SkillTurn::default(),
    }
}

impl SkillTurn {
    pub fn system_prompt(&self, base: String) -> String {
        match &self.prompt {
            Some(section) => format!("{base}\n\n{section}"),
            None => base,
        }
    }

    /// Adds `load_skill` and applies a picked skill's narrowing. Narrowing
    /// keeps only tools the turn already offered, so it can never widen.
    pub fn apply(&self, tools: &mut Vec<Value>) {
        if !self.narrow.is_empty() {
            tools.retain(|tool| {
                tool.pointer("/function/name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| self.narrow.iter().any(|allowed| allowed == name))
            });
        }
        if self.offer_loader {
            tools.push(json!({"type": "function", "function": {
                "name": TOOL,
                "description": "Read the full instructions of one of the user's skills before following it.",
                "parameters": {"type": "object", "properties": {
                    "name": {"type": "string", "description": "The skill's name, as listed."}
                }, "required": ["name"]}
            }}));
        }
    }
}

/// `load_skill`: the body of an enabled pack, or a sentence saying it is not
/// there.
pub async fn load(pool: &SqlitePool, args: &Value) -> String {
    let name = args
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    match list(pool).await {
        Ok(packs) => packs
            .iter()
            .find(|pack| pack.enabled && pack.name == name)
            .map(body_block)
            .unwrap_or_else(|| missing(name)),
        Err(_) => UNREADABLE.into(),
    }
}
