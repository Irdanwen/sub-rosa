//! The web client's copy of agent-lite, generated from here (WP19).
//!
//! The web client runs the same chat as the phone: the same system prompt,
//! the same tool declarations, the same memory and personalization blocks,
//! and it writes the same rows. None of that prose or that codec is written a
//! second time in TypeScript. This test renders it into
//! `packages/chat-core/agent-lite.json`, which the website reads, and fails
//! when the committed file no longer matches what Rust would say. Run it with
//! `SUBROSA_WRITE_WEB_EXPORT=1` to rewrite the file after a change here.

use super::budget::MAX_TOOL_ROUNDS;
use super::tool_defs::tool_definitions;
use super::{FINAL_ANSWER_NUDGE, SYSTEM_PROMPT, WEB_PAGE_CHARS, WEB_SEARCH_RESULTS};
use crate::personalization::Personality;

/// The tools a browser can run: everything that reads or writes synchronised
/// objects, and the two web tools Carpe Diem answers for a browser key.
const WEB_TOOLS: &[&str] = &[
    "search_notes",
    "web_search",
    "fetch_page",
    "read_note",
    "list_recent_notes",
    "create_note",
    "append_to_note",
    "remember",
    "search_memories",
];

/// The tables the web client reads or writes, with the columns that travel.
const WEB_TABLES: &[&str] = &[
    "agent_tasks",
    "agent_messages",
    "memories",
    "notes",
    "folders",
    "account_session_folders",
];

fn export() -> serde_json::Value {
    let tools: Vec<serde_json::Value> = tool_definitions(true)
        .as_array()
        .expect("tool definitions are a list")
        .iter()
        .filter(|tool| {
            tool.pointer("/function/name")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|name| WEB_TOOLS.contains(&name))
        })
        .cloned()
        .collect();
    let tables: serde_json::Map<String, serde_json::Value> = WEB_TABLES
        .iter()
        .map(|name| {
            let (kind, columns) =
                crate::account::columns_of(name).expect("a web table is a travelling table");
            (
                name.to_string(),
                serde_json::json!({ "kind": kind, "columns": columns }),
            )
        })
        .collect();
    let personalities: serde_json::Map<String, serde_json::Value> = [
        Personality::Professional,
        Personality::Friendly,
        Personality::Candid,
        Personality::Efficient,
        Personality::Nerdy,
    ]
    .into_iter()
    .map(|personality| {
        (
            serde_json::to_value(personality)
                .expect("a personality serializes")
                .as_str()
                .expect("a personality is a string")
                .to_string(),
            serde_json::json!(personality.instruction()),
        )
    })
    .collect();
    serde_json::json!({
        "generatedBy": "src-tauri/src/agent_lite/web_client_export.rs",
        "systemPrompt": SYSTEM_PROMPT,
        "defaultModel": crate::providers::DEFAULT_GENERATION_MODEL,
        "finalAnswerNudge": FINAL_ANSWER_NUDGE,
        "memoryBlockHeader": crate::memory::MEMORY_BLOCK_HEADER,
        "injectedMemoryLimit": crate::memory::INJECTED_MEMORY_LIMIT,
        "personalization": {
            "header": crate::personalization::BLOCK_HEADER,
            "about": crate::personalization::ABOUT_LABEL,
            "style": crate::personalization::STYLE_LABEL,
            "personality": crate::personalization::PERSONALITY_LABEL,
            "maxFieldChars": crate::personalization::MAX_FIELD_CHARS,
            "personalities": personalities,
        },
        "limits": {
            "maxToolRounds": MAX_TOOL_ROUNDS,
            "webSearchResults": WEB_SEARCH_RESULTS,
            "webPageChars": WEB_PAGE_CHARS,
        },
        "tools": tools,
        "tables": tables,
    })
}

#[test]
fn the_web_client_reads_what_agent_lite_says() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../packages/chat-core/agent-lite.json");
    let rendered = format!(
        "{}\n",
        serde_json::to_string_pretty(&export()).expect("the export serializes")
    );
    if std::env::var_os("SUBROSA_WRITE_WEB_EXPORT").is_some() {
        std::fs::write(&path, &rendered).expect("the export is written");
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        committed == rendered,
        "packages/chat-core/agent-lite.json is stale: run this test with SUBROSA_WRITE_WEB_EXPORT=1"
    );
}

#[test]
fn the_export_names_only_tools_and_tables_that_exist() {
    let value = export();
    assert_eq!(value["tools"].as_array().unwrap().len(), WEB_TOOLS.len());
    for name in WEB_TABLES {
        assert!(value["tables"][name]["columns"].as_array().is_some());
    }
    assert!(value["systemPrompt"]
        .as_str()
        .unwrap()
        .starts_with("You are Sub Rosa's assistant"));
}
