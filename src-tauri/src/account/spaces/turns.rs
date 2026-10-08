//! An assistant reply in a group chat. It runs on the device of the member
//! who asked, through that member's own Carpe Diem key, and the reply is an
//! ordinary message signed by that member with `paid_by` naming them, so
//! everyone sees who paid. The row is written before the turn starts
//! (ADR-0018): a suspension re-drives it, and whether it is running now is an
//! in-process question, never a column.
use super::store::{self, ObjectRow};
use crate::domain::types::AppError;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::AppHandle;

static LIVE: Mutex<Option<HashSet<String>>> = Mutex::new(None);
const MAX_ATTEMPTS: i64 = 3;
/// What of the conversation goes to the model.
const HISTORY: usize = 40;
const CONTEXT_CHARS: usize = 24_000;

struct Claim(String);
impl Claim {
    fn take(id: &str) -> Option<Self> {
        let mut live = LIVE.lock().unwrap_or_else(|p| p.into_inner());
        live.get_or_insert_with(HashSet::new)
            .insert(id.to_string())
            .then(|| Self(id.to_string()))
    }
}
impl Drop for Claim {
    fn drop(&mut self) {
        let mut live = LIVE.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(set) = live.as_mut() {
            set.remove(&self.0);
        }
    }
}

fn turn_failed() -> AppError {
    AppError::new(
        "space_turn_failed",
        "The assistant could not answer. Try again.",
    )
}

/// Runs every waiting turn that is not already running in this process.
pub async fn resume(app: &AppHandle) {
    let Ok(pool) = crate::account::pool(app).await else {
        return;
    };
    let Ok(turns) = store::turns(&pool).await else {
        return;
    };
    for turn in turns {
        if turn.attempts >= MAX_ATTEMPTS {
            continue;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            run(&app, &turn.id).await;
        });
    }
}

pub async fn run(app: &AppHandle, turn_id: &str) {
    let Some(_claim) = Claim::take(turn_id) else {
        return;
    };
    let _background = crate::ios_background::BackgroundTask::begin("space-turn");
    let Ok(pool) = crate::account::pool(app).await else {
        return;
    };
    let Ok(Some(turn)) = store::turn(&pool, turn_id).await else {
        return;
    };
    match answer(&pool, &turn).await {
        Ok(()) => {
            let _ = store::turn_done(&pool, turn_id).await;
            super::kick(app, Some(turn.space_id.clone()));
        }
        Err(e) => {
            tracing::warn!(code = %e.code, "a shared project's assistant turn failed");
            let _ = store::turn_failed(&pool, turn_id, &e.code).await;
            let _ = tauri::Emitter::emit(app, "subrosa://spaces-updated", vec![turn.space_id]);
        }
    }
}

fn label(names: &std::collections::HashMap<String, String>, account: &str) -> String {
    names
        .get(account)
        .cloned()
        .unwrap_or_else(|| "A member".to_string())
}

async fn answer(pool: &sqlx_sqlite::SqlitePool, turn: &store::TurnRow) -> Result<(), AppError> {
    let settings = store::settings(pool).await?;
    let me = settings
        .identity_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<Value>(json).ok())
        .and_then(|bundle| bundle["account_id"].as_str().map(str::to_string))
        .ok_or_else(turn_failed)?;
    let space = store::space(pool, &turn.space_id).await?;
    let names = super::commands::names(pool, &space.id).await?;
    let project = store::objects(pool, &space.id, "project").await?;
    let instructions = project
        .first()
        .and_then(|p| p.data["instructions"].as_str())
        .unwrap_or_default()
        .to_string();
    let mut context = String::new();
    for kind in ["note", "file"] {
        for object in store::objects(pool, &space.id, kind).await? {
            let (title, text) = if kind == "note" {
                (&object.data["title"], &object.data["body"])
            } else {
                (&object.data["name"], &object.data["text"])
            };
            let room = CONTEXT_CHARS.saturating_sub(context.chars().count());
            if room == 0 {
                break;
            }
            let block = format!(
                "\n--- {} ---\n{}\n",
                title.as_str().unwrap_or_default(),
                text.as_str().unwrap_or_default()
            );
            context.extend(block.chars().take(room));
        }
    }
    let mut system = format!(
        "You are Sub Rosa's assistant in a shared project named \"{}\". Several people take part in this conversation; each of their messages starts with the person's name. Answer the group, address people by name when it helps, and do not claim to be one of them.",
        space.name.trim()
    );
    if !instructions.trim().is_empty() {
        system.push_str("\nThe project's instructions:\n");
        system.push_str(instructions.trim());
    }
    if !context.is_empty() {
        system.push_str("\nThe project's notes and files:");
        system.push_str(&context);
    }
    system.push('\n');
    system.push_str(&crate::i18n::write_in_line());
    let messages: Vec<ObjectRow> = conversation(pool, &space.id, &turn.conversation_id).await?;
    let mut chat = vec![json!({"role": "system", "content": system})];
    for message in messages.iter().rev().take(HISTORY).rev() {
        let text = message.data["text"].as_str().unwrap_or_default();
        if message.data["role"] == "assistant" {
            chat.push(json!({"role": "assistant", "content": text}));
        } else {
            let author = if message.pending {
                me.as_str()
            } else {
                message.author.as_str()
            };
            chat.push(
                json!({"role": "user", "content": format!("{}: {text}", label(&names, author))}),
            );
        }
    }
    let model = crate::providers::generation_model();
    let response = crate::june_api::proxy_agent_chat_completions(json!({
        "model": model,
        "messages": chat,
        "stream": false,
    }))
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(turn_failed());
    }
    let body = response.collect_body().await?;
    let value: Value = serde_json::from_slice(&body).map_err(|_| turn_failed())?;
    let text = crate::june_api::extract_chat_completion_text(&value)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(turn_failed)?;
    let text: String = text.chars().take(100_000).collect();
    let object_id = uuid::Uuid::new_v4().to_string();
    store::enqueue(
        pool,
        store::Enqueue {
            space_id: &space.id,
            object_id: &object_id,
            kind: "message",
            data: &json!({
                "conversation_id": turn.conversation_id,
                "role": "assistant",
                "text": text,
                "model": model.chars().take(200).collect::<String>(),
                "paid_by": me,
                "reply_to": turn.reply_to,
            }),
            deleted: false,
        },
    )
    .await
}

/// The messages of one conversation, oldest first, unsent ones last.
pub async fn conversation(
    pool: &sqlx_sqlite::SqlitePool,
    space_id: &str,
    conversation_id: &str,
) -> Result<Vec<ObjectRow>, AppError> {
    Ok(store::objects(pool, space_id, "message")
        .await?
        .into_iter()
        .filter(|m| m.data["conversation_id"] == conversation_id)
        .collect())
}
