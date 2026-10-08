//! Skill packs: a `SKILL.md` made portable, so the phones have skills too
//! (ADR-0092).
//!
//! On the computer, skills are Hermes's: a folder per skill, read by the
//! runtime. A phone has no runtime, so a skill travels as a definition (its
//! name, its description, its body and the tools it narrows a turn to) in a
//! row that synchronises like an assistant's. Agent-lite reads them the way
//! Hermes does, by progressive disclosure: every turn is offered the names and
//! descriptions, and `load_skill` reads one body when the model picks it. A
//! person can also pick one directly by typing `/name` at the start of a
//! message, and its body joins that turn's instructions.
//!
//! A pack only ever narrows what a turn may use; it cannot grant a tool the
//! conversation does not already have.

use serde::{Deserialize, Serialize};
use sqlx::query::query;
use sqlx::row::Row as _;
use sqlx_sqlite::SqlitePool;
use tauri::AppHandle;

use crate::domain::types::AppError;

pub mod agent;

#[cfg(test)]
mod tests;

pub const MAX_BODY_CHARS: usize = 20_000;
const MAX_DESCRIPTION_CHARS: usize = 400;

/// Each message a literal the i18n extractor reads (ADR-0047).
fn error(code: &str) -> AppError {
    match code {
        "skill_pack_invalid" => AppError::new(
            "skill_pack_invalid",
            "This file is not a skill. It needs a name and a description at the top, between two lines of three dashes.",
        ),
        "skill_pack_name" => AppError::new(
            "skill_pack_name",
            "A skill name uses lowercase letters, digits and dashes, up to 64 characters.",
        ),
        "skill_pack_missing" => {
            AppError::new("skill_pack_missing", "This skill no longer exists.")
        }
        _ => AppError::new(
            "skill_pack_failed",
            "The skill could not be saved. Try again.",
        ),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPack {
    pub id: String,
    pub name: String,
    pub description: String,
    pub body: String,
    pub tools: Vec<String>,
    pub enabled: bool,
    pub updated_at: String,
}

/// What a `SKILL.md` says, before it is a row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSkill {
    pub name: String,
    pub description: String,
    pub body: String,
    pub tools: Vec<String>,
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-')
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|rest| rest.strip_suffix('\''))
        })
        .unwrap_or(value)
        .to_string()
}

/// Reads the front matter a `SKILL.md` opens with (`name`, `description`,
/// and `allowed-tools` or `tools`, inline or as a list) and the body after.
/// Only the simple shape skills are written in; anything else is refused
/// rather than guessed at.
pub fn parse_skill_md(text: &str) -> Result<ParsedSkill, AppError> {
    let text = text.trim_start_matches('\u{feff}');
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Err(error("skill_pack_invalid"));
    }
    let mut name = None;
    let mut description = None;
    let mut tools: Vec<String> = Vec::new();
    let mut in_tools = false;
    let mut closed = false;
    let mut consumed = 1;
    for line in lines.by_ref() {
        consumed += 1;
        if line.trim() == "---" {
            closed = true;
            break;
        }
        if in_tools {
            if let Some(item) = line.trim_start().strip_prefix("- ") {
                tools.push(unquote(item));
                continue;
            }
            in_tools = false;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        match key.trim() {
            "name" => name = Some(unquote(value)),
            "description" => description = Some(unquote(value)),
            "allowed-tools" | "tools" => {
                let value = value.trim();
                if value.is_empty() {
                    in_tools = true;
                } else {
                    tools.extend(
                        value
                            .trim_start_matches('[')
                            .trim_end_matches(']')
                            .split(',')
                            .map(unquote)
                            .filter(|tool| !tool.is_empty()),
                    );
                }
            }
            _ => {}
        }
    }
    if !closed {
        return Err(error("skill_pack_invalid"));
    }
    let name = name
        .filter(|name| !name.is_empty())
        .ok_or_else(|| error("skill_pack_invalid"))?;
    if !valid_name(&name) {
        return Err(error("skill_pack_name"));
    }
    let description: String = description
        .filter(|description| !description.trim().is_empty())
        .ok_or_else(|| error("skill_pack_invalid"))?
        .chars()
        .take(MAX_DESCRIPTION_CHARS)
        .collect();
    let body: String = text
        .lines()
        .skip(consumed)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .chars()
        .take(MAX_BODY_CHARS)
        .collect();
    tools.retain(|tool| {
        !tool.is_empty()
            && tool.len() <= 128
            && tool
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
    });
    tools.dedup();
    tools.truncate(40);
    Ok(ParsedSkill {
        name,
        description,
        body,
        tools,
    })
}

fn pack_of(row: &sqlx_sqlite::SqliteRow) -> SkillPack {
    SkillPack {
        id: row.get("id"),
        name: row.get("name"),
        description: row.get("description"),
        body: row.get("body"),
        tools: serde_json::from_str(&row.get::<String, _>("tools")).unwrap_or_default(),
        enabled: row.get::<i64, _>("enabled") != 0,
        updated_at: row.get("updated_at"),
    }
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<SkillPack>, AppError> {
    Ok(query("SELECT * FROM skill_packs ORDER BY name")
        .fetch_all(pool)
        .await?
        .iter()
        .map(pack_of)
        .collect())
}

/// Saves a parsed skill: a new row, or the row that already has its name.
pub async fn save(pool: &SqlitePool, parsed: &ParsedSkill) -> Result<SkillPack, AppError> {
    let now = chrono::Utc::now().to_rfc3339();
    let existing: Option<String> = query("SELECT id FROM skill_packs WHERE name=?")
        .bind(&parsed.name)
        .fetch_optional(pool)
        .await?
        .map(|row| row.get("id"));
    let tools = serde_json::to_string(&parsed.tools).unwrap_or_else(|_| "[]".into());
    let id = match existing {
        Some(id) => {
            query("UPDATE skill_packs SET description=?,body=?,tools=?,updated_at=? WHERE id=?")
                .bind(&parsed.description)
                .bind(&parsed.body)
                .bind(&tools)
                .bind(&now)
                .bind(&id)
                .execute(pool)
                .await?;
            id
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            query("INSERT INTO skill_packs(id,name,description,body,tools,enabled,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)")
                .bind(&id)
                .bind(&parsed.name)
                .bind(&parsed.description)
                .bind(&parsed.body)
                .bind(&tools)
                .bind(&now)
                .bind(&now)
                .execute(pool)
                .await?;
            id
        }
    };
    query("SELECT * FROM skill_packs WHERE id=?")
        .bind(&id)
        .fetch_optional(pool)
        .await?
        .map(|row| pack_of(&row))
        .ok_or_else(|| error("skill_pack_missing"))
}

async fn pool(app: &AppHandle) -> Result<SqlitePool, AppError> {
    Ok(crate::commands::repositories(app).await?.pool)
}

#[tauri::command]
pub async fn skill_pack_list(app: AppHandle) -> Result<Vec<SkillPack>, AppError> {
    list(&pool(&app).await?).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackImport {
    /// The whole `SKILL.md`.
    pub text: String,
}

#[tauri::command]
pub async fn skill_pack_import(
    app: AppHandle,
    request: SkillPackImport,
) -> Result<SkillPack, AppError> {
    if request.text.len() > 200_000 {
        return Err(error("skill_pack_invalid"));
    }
    let parsed = parse_skill_md(&request.text)?;
    save(&pool(&app).await?, &parsed).await
}

#[tauri::command]
pub async fn skill_pack_set_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<(), AppError> {
    query("UPDATE skill_packs SET enabled=?,updated_at=? WHERE id=?")
        .bind(i64::from(enabled))
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(&id)
        .execute(&pool(&app).await?)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn skill_pack_delete(app: AppHandle, id: String) -> Result<(), AppError> {
    query("DELETE FROM skill_packs WHERE id=?")
        .bind(&id)
        .execute(&pool(&app).await?)
        .await?;
    Ok(())
}
