//! Memory of past chats ("reference chat history", ADR-0081).
//!
//! Remembered facts are what extraction decided to keep. This is the rest:
//! what was actually said in the user's other conversations on this device,
//! found by word in `agent_messages_fts` (migration 020) the moment a turn
//! needs it. Nothing is summarised or stored ahead of time, so turning the
//! switch off leaves nothing behind.
//!
//! Two ways in, both off with the switch (and with memory itself):
//! - on the phone, a short "From earlier conversations" block rides along with
//!   the turn, next to the memory block, screened for relevance and capped;
//! - on both shells, a `search_past_chats` tool reaches further back on
//!   request (agent-lite here, the `june_context` MCP on the desktop).
//!
//! Only general chats are read. A custom assistant's conversation is its own
//! world (ADR-0058) and is never quoted into another chat.

use crate::db::repositories::Repositories;
use serde::Serialize;
use sqlx::{query::query, row::Row};
use sqlx_sqlite::SqlitePool;
use std::time::Duration;

/// Excerpts that ride along with a turn, at most.
const TURN_SNIPPETS: usize = 5;
/// Candidates the relevance screen chooses between.
const TURN_CANDIDATES: i64 = 15;
/// What the excerpts may cost the prompt, all together and one by one.
const TURN_BLOCK_CHARS: usize = 1_500;
const SNIPPET_CHARS: usize = 300;
/// A turn waits this long for its excerpts at most, screen included.
const TURN_BUDGET: Duration = Duration::from_millis(1_500);
/// Results of one `search_past_chats` call.
const TOOL_RESULTS: i64 = 8;

/// Whether past chats are consulted at all.
pub fn enabled() -> bool {
    let settings = super::settings();
    settings.enabled && settings.reference_chat_history
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PastChatSnippet {
    pub task_id: String,
    pub title: String,
    /// "user" or "assistant".
    pub role: String,
    pub excerpt: String,
    pub created_at: String,
}

/// Messages of other general chats matching an FTS5 expression, best bm25
/// first, one excerpt per message. `exclude_task` is the chat asking.
///
/// `scope` is the memory scope of that chat (ADR-0085): a project that keeps
/// its memory to itself reads only its own chats, and every other chat reads
/// everything except such a project's chats.
pub async fn search(
    pool: &SqlitePool,
    fts: &str,
    exclude_task: Option<&str>,
    limit: i64,
    scope: Option<&str>,
) -> Result<Vec<PastChatSnippet>, sqlx::error::Error> {
    let rows = query(
        "SELECT f.task_id AS task_id, t.title AS title, m.role AS role, m.created_at AS created_at,
                snippet(agent_messages_fts, 2, '', '', '…', 40) AS excerpt
         FROM agent_messages_fts f
         JOIN agent_tasks t ON t.id = f.task_id
         JOIN agent_messages m ON m.id = f.message_id
         WHERE agent_messages_fts MATCH ?1
           AND f.task_id <> ?2
           AND m.role IN ('user', 'assistant')
           AND t.ephemeral = 0
           AND t.safety_profile NOT IN ('custom_assistant', 'customAssistant')
           AND NOT EXISTS (SELECT 1 FROM assistant_conversations a WHERE a.task_id = t.id)
           AND CASE WHEN ?4 IS NULL THEN NOT EXISTS (
                 SELECT 1 FROM session_folders sf
                 JOIN project_settings p ON p.id = sf.folder_id
                 WHERE p.memory_mode = 'project'
                   AND (sf.session_id = t.id OR sf.session_id = t.hermes_session_id))
               ELSE EXISTS (
                 SELECT 1 FROM session_folders sf
                 WHERE sf.folder_id = ?4
                   AND (sf.session_id = t.id OR sf.session_id = t.hermes_session_id))
               END
         ORDER BY bm25(agent_messages_fts)
         LIMIT ?3",
    )
    .bind(fts)
    .bind(exclude_task.unwrap_or_default())
    .bind(limit.clamp(1, 50))
    .bind(scope)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| PastChatSnippet {
            task_id: row.get("task_id"),
            title: row.get("title"),
            role: row.get("role"),
            excerpt: row.get("excerpt"),
            created_at: row.get("created_at"),
        })
        .collect())
}

/// The FTS expression for a message: any of its content words.
fn match_for(message: &str) -> Option<String> {
    crate::ask::passages_match(&crate::ask::content_terms(message))
}

/// The block for one agent-lite turn of `task_id`, or `None` when the switch
/// is off. With nothing relevant it still names the tool, so the model knows
/// where to look when the user mentions an earlier chat.
pub async fn block_for_turn(repos: &Repositories, task_id: &str, message: &str) -> Option<String> {
    if !enabled() {
        return None;
    }
    let snippets = match match_for(message) {
        Some(fts) => tokio::time::timeout(TURN_BUDGET, relevant(repos, &fts, task_id, message))
            .await
            .unwrap_or_default(),
        None => Vec::new(),
    };
    Some(format_block(&snippets))
}

async fn relevant(
    repos: &Repositories,
    fts: &str,
    task_id: &str,
    message: &str,
) -> Vec<PastChatSnippet> {
    let candidates = match search(
        &repos.pool,
        fts,
        Some(task_id),
        TURN_CANDIDATES,
        repos.memory_scope(),
    )
    .await
    {
        Ok(candidates) => candidates,
        Err(error) => {
            tracing::warn!("Past chat search failed: {error}");
            return Vec::new();
        }
    };
    // Which of them bear on the message (ADR-0064); without a reflex, the
    // best-ranked few, as with memory recall.
    crate::egress_ledger::scoped(
        "memory",
        None,
        crate::reflex::screen::screen(
            &format!("Message: {message}"),
            SCREEN_INSTRUCTIONS,
            candidates,
            |snippet| format!("{}: {}", snippet.title, snippet.excerpt),
            TURN_SNIPPETS,
        ),
    )
    .await
    .kept
}

const SCREEN_INSTRUCTIONS: &str = "Is this excerpt from another of the person's conversations \
relevant to the message in the state? Answer yes only if it helps answer that message.";

const BLOCK_HEADER: &str = "Earlier conversations: the user can be reminded of their other chats \
on this device. When they refer to something discussed before, call search_past_chats rather \
than guessing.";

/// The block: the header, then each excerpt under its chat's title and date,
/// every excerpt and the whole list capped.
pub fn format_block(snippets: &[PastChatSnippet]) -> String {
    let mut block = String::from(BLOCK_HEADER);
    if snippets.is_empty() {
        block.push('\n');
        return block;
    }
    block.push_str(
        " These excerpts from other chats may bear on this message. Use them only if they help, \
         and do not recite them unprompted.\n",
    );
    let mut budget = TURN_BLOCK_CHARS;
    for snippet in snippets.iter().take(TURN_SNIPPETS) {
        let speaker = if snippet.role == "assistant" {
            "you said"
        } else {
            "the user said"
        };
        let excerpt = clip(&one_line(&snippet.excerpt), SNIPPET_CHARS);
        let line = format!(
            "- \"{}\" ({}, {speaker}): {excerpt}\n",
            clip(&one_line(&snippet.title), 80),
            date_of(&snippet.created_at)
        );
        let cost = line.chars().count();
        if cost > budget {
            break;
        }
        budget -= cost;
        block.push_str(&line);
    }
    block
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut clipped: String = text.chars().take(max.saturating_sub(1)).collect();
    clipped.push('…');
    clipped
}

fn date_of(timestamp: &str) -> &str {
    timestamp.get(..10).unwrap_or(timestamp)
}

/// The agent-lite tool, offered only while past chats are on.
pub fn tool_definition() -> Option<serde_json::Value> {
    enabled().then(|| {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": "search_past_chats",
                "description": "Search what was said in the user's other conversations on this device. Use it when the user refers to an earlier chat (\"like we discussed\", \"what did you suggest last week\"). Returns excerpts with the conversation title and date.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "A few keywords, in the user's language."
                        }
                    },
                    "required": ["query"]
                }
            }
        })
    })
}

/// Runs `search_past_chats` for the chat `task_id`; the text is the tool
/// result the model reads.
pub async fn run_tool(repos: &Repositories, task_id: &str, query_text: &str) -> String {
    if !enabled() {
        return "Past chats are not available: the user turned this off in Settings.".to_string();
    }
    let Some(fts) = match_for(query_text) else {
        return "search_past_chats needs a few keywords.".to_string();
    };
    match search(
        &repos.pool,
        &fts,
        Some(task_id),
        TOOL_RESULTS,
        repos.memory_scope(),
    )
    .await
    {
        Ok(snippets) if snippets.is_empty() => {
            "Nothing in the user's other conversations matches that.".to_string()
        }
        Ok(snippets) => {
            let items: Vec<serde_json::Value> = snippets
                .iter()
                .map(|snippet| {
                    serde_json::json!({
                        "conversation": snippet.title,
                        "date": date_of(&snippet.created_at),
                        "speaker": snippet.role,
                        "excerpt": clip(&one_line(&snippet.excerpt), SNIPPET_CHARS * 2),
                    })
                })
                .collect();
            serde_json::to_string(&items)
                .unwrap_or_else(|_| "Past chat search failed to serialize.".to_string())
        }
        Err(error) => format!("Past chat search failed: {error}"),
    }
}

/// The desktop soul's line about the MCP tool, while past chats are on. The
/// tool itself is advertised by the MCP only when it was started with the
/// switch on, so the line hedges rather than promises.
pub fn soul_note() -> Option<&'static str> {
    enabled().then_some(
        "Earlier conversations: when the user refers to something discussed in another chat, \
         use the search_past_chats tool if it is available rather than guessing.\n",
    )
}

/// Extra arguments for the desktop `june_context` MCP: `--memory=off`
/// withholds every memory tool, `--past-chats=off` only this one.
pub fn context_mcp_args(memory_enabled: bool) -> String {
    if !memory_enabled {
        "      - \"--memory=off\"\n".to_string()
    } else if !super::settings().reference_chat_history {
        "      - \"--past-chats=off\"\n".to_string()
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::run_migrations(&pool).await.unwrap();
        pool
    }

    async fn chat(pool: &SqlitePool, id: &str, title: &str, profile: &str, lines: &[(&str, &str)]) {
        query("INSERT INTO agent_tasks(id,title,prompt,status,safety_profile,created_at,updated_at) VALUES(?,?,'p','completed',?,'2026-09-01T10:00:00Z','2026-09-01T10:00:00Z')")
            .bind(id)
            .bind(title)
            .bind(profile)
            .execute(pool)
            .await
            .unwrap();
        for (index, (role, content)) in lines.iter().enumerate() {
            query("INSERT INTO agent_messages(id,task_id,role,content,created_at) VALUES(?,?,?,?,'2026-09-01T10:00:00Z')")
                .bind(format!("{id}-{index}"))
                .bind(id)
                .bind(role)
                .bind(content)
                .execute(pool)
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn search_reads_other_general_chats_only() {
        let pool = pool().await;
        chat(
            &pool,
            "current",
            "Today",
            "general",
            &[("user", "Which tent for the Lyon trip?")],
        )
        .await;
        chat(
            &pool,
            "older",
            "Camping gear",
            "general",
            &[
                ("user", "I want a light tent for the Lyon trip"),
                ("assistant", "A two-person tent under two kilos fits"),
            ],
        )
        .await;
        chat(
            &pool,
            "assistant",
            "Story",
            "custom_assistant",
            &[("user", "Write about a tent in Lyon")],
        )
        .await;
        let fts = match_for("Which tent for Lyon?").unwrap();
        let hits = search(&pool, &fts, Some("current"), 10, None)
            .await
            .unwrap();
        assert!(!hits.is_empty());
        assert!(hits.iter().all(|hit| hit.task_id == "older"));
        assert_eq!(hits[0].title, "Camping gear");
        // Without an exclusion the asking chat matches too.
        let all = search(&pool, &fts, None, 10, None).await.unwrap();
        assert!(all.iter().any(|hit| hit.task_id == "current"));
        assert!(!all.iter().any(|hit| hit.task_id == "assistant"));
    }

    #[tokio::test]
    async fn search_skips_conversations_owned_by_an_assistant() {
        let pool = pool().await;
        chat(
            &pool,
            "owned",
            "Plan",
            "general",
            &[("user", "Budget for the garden")],
        )
        .await;
        query("INSERT INTO assistant_conversations(task_id,assistant_id,snapshot_json,created_at) VALUES('owned','a1','{}','t0')")
            .execute(&pool)
            .await
            .unwrap();
        let fts = match_for("garden budget").unwrap();
        assert!(search(&pool, &fts, None, 10, None)
            .await
            .unwrap()
            .is_empty());
    }

    fn snippet(title: &str, role: &str, excerpt: &str) -> PastChatSnippet {
        PastChatSnippet {
            task_id: "t".to_string(),
            title: title.to_string(),
            role: role.to_string(),
            excerpt: excerpt.to_string(),
            created_at: "2026-09-01T10:00:00Z".to_string(),
        }
    }

    #[test]
    fn the_block_names_the_tool_even_when_nothing_matched() {
        let block = format_block(&[]);
        assert!(block.starts_with("Earlier conversations:"));
        assert!(block.contains("search_past_chats"));
        assert!(!block.contains("\n-"));
    }

    #[test]
    fn the_block_dates_and_attributes_each_excerpt() {
        let block = format_block(&[
            snippet("Camping", "user", "a light\n tent"),
            snippet("Camping", "assistant", "under two kilos"),
        ]);
        assert!(block.contains("- \"Camping\" (2026-09-01, the user said): a light tent\n"));
        assert!(block.contains("(2026-09-01, you said): under two kilos"));
    }

    #[test]
    fn the_block_caps_each_excerpt_their_count_and_its_length() {
        let long = "word ".repeat(400);
        let many: Vec<PastChatSnippet> = (0..12).map(|_| snippet("T", "user", &long)).collect();
        let block = format_block(&many);
        let lines: Vec<&str> = block
            .lines()
            .filter(|line| line.starts_with("- "))
            .collect();
        assert!(!lines.is_empty() && lines.len() <= TURN_SNIPPETS);
        assert!(lines
            .iter()
            .all(|line| line.chars().count() <= SNIPPET_CHARS + 60));
        let excerpts: usize = lines.iter().map(|line| line.chars().count() + 1).sum();
        assert!(excerpts <= TURN_BLOCK_CHARS);
    }

    #[test]
    fn the_mcp_withholds_memory_tools_or_only_past_chats() {
        assert_eq!(context_mcp_args(false), "      - \"--memory=off\"\n");
        // Defaults: memory on, past chats on, no argument.
        if super::super::settings().reference_chat_history {
            assert_eq!(context_mcp_args(true), "");
        }
    }
}
