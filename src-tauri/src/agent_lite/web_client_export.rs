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
    // WP20: projects (ADR-0085), saved items (ADR-0088), custom assistants
    // (ADR-0058) and the gallery files a browser makes.
    "project_settings",
    "project_files",
    "saved_items",
    "assistants",
    "assistant_references",
    "account_studio_files",
    "account_file_manifests",
];

/// A template: Rust's own text with `{name}` where the web client puts a
/// value. Rendering with placeholders, rather than restating the prose,
/// keeps the export honest when the sentence changes.
fn after<'a>(whole: &'a str, prefix: &str) -> &'a str {
    whole
        .strip_prefix(prefix)
        .expect("a section extends the opening it was rendered from")
}

/// The project section of `projects::context::agent_lite_section`, piece by
/// piece (ADR-0085).
fn project_words() -> serde_json::Value {
    use crate::projects::context::{agent_lite_section, search_tool_definition, ProjectContext};
    let section = |instructions: &str, files: &[&str], mode: &str| {
        agent_lite_section(&ProjectContext {
            folder_id: String::new(),
            name: "{name}".into(),
            instructions: instructions.into(),
            memory_mode: mode.into(),
            file_names: files.iter().map(|name| name.to_string()).collect(),
        })
    };
    let opening = section("", &[], crate::projects::MEMORY_DEFAULT);
    serde_json::json!({
        "opening": opening,
        "instructions": after(&section("{instructions}", &[], crate::projects::MEMORY_DEFAULT), &opening),
        "files": after(&section("", &["{files}"], crate::projects::MEMORY_DEFAULT), &opening),
        "ownMemory": after(&section("", &[], crate::projects::MEMORY_PROJECT), &opening),
        "memoryDefault": crate::projects::MEMORY_DEFAULT,
        "memoryProject": crate::projects::MEMORY_PROJECT,
        "tool": search_tool_definition(),
    })
}

/// The past chats block of `memory::past_chats::format_block` (ADR-0081).
fn past_chat_words() -> serde_json::Value {
    use crate::memory::past_chats::{self as past, format_block, PastChatSnippet};
    let header = format_block(&[]);
    let header = header.trim_end_matches('\n');
    let line = |role: &str| {
        let block = format_block(&[PastChatSnippet {
            task_id: String::new(),
            title: "{title}".into(),
            role: role.into(),
            excerpt: "{excerpt}".into(),
            created_at: "{date}".into(),
        }]);
        after(&block, header).to_string()
    };
    let user = line("user");
    let (intro, user_line) = user.split_at(user.find('\n').expect("the intro ends a line") + 1);
    let assistant = line("assistant");
    serde_json::json!({
        "header": header,
        "excerptsIntro": intro,
        "userLine": user_line,
        "assistantLine": after(&assistant, intro),
        "turnSnippets": past::TURN_SNIPPETS,
        "blockChars": past::TURN_BLOCK_CHARS,
        "snippetChars": past::SNIPPET_CHARS,
        "titleChars": past::TITLE_CHARS,
        "toolResults": past::TOOL_RESULTS,
        "tool": past::declaration(),
    })
}

/// A custom assistant's prompt (`assistants::runtime::system_prompt`) and its
/// reference search (ADR-0058).
fn assistant_words() -> serde_json::Value {
    use crate::assistants::runtime::{
        search_references_definition, system_prompt, AssistantSnapshot,
    };
    let snapshot = AssistantSnapshot {
        definition: crate::assistants::AssistantDefinition {
            name: "{name}".into(),
            instructions: "{instructions}".into(),
            ..Default::default()
        },
        references: Vec::new(),
    };
    serde_json::json!({
        "systemPrompt": system_prompt(&snapshot, None),
        "searchReferences": search_references_definition(),
    })
}

/// The canvas rewrite (ADR-0087) and the picture refine pass (ADR-0088).
fn editing_words() -> serde_json::Value {
    use crate::note_ai::{prompts, RewriteKind};
    serde_json::json!({
        "canvas": {
            "system": prompts::SHARED_RULES,
            "message": prompts::user_message(RewriteKind::Canvas, "{document}", None, Some("{instruction}")),
            "temperature": (f64::from(crate::note_ai::TEMPERATURE) * 100.0).round() / 100.0,
            "maxChars": crate::note_ai::MAX_SELECTION_CHARS,
            "promptVersion": prompts::NOTE_AI_PROMPT_VERSION,
        },
        "refine": {
            "critiqueSystem": crate::image_refine::CRITIQUE_SYSTEM,
            "editSuffix": after(&crate::image_refine::edit_prompt("{instruction}."), "{instruction}."),
            "maxPasses": crate::image_refine::MAX_PASSES,
            "editModels": crate::image_refine::PREFERRED_EDIT_MODELS,
        },
    })
}

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
        "cardsPrompt": crate::data_cards::CARDS_PROMPT,
        "project": project_words(),
        "pastChats": past_chat_words(),
        "assistant": assistant_words(),
        "editing": editing_words(),
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
    // Every template keeps its placeholders: a sentence that lost one would
    // show the person a literal brace or drop their text.
    assert!(value["project"]["opening"]
        .as_str()
        .unwrap()
        .contains("{name}"));
    assert!(value["project"]["instructions"]
        .as_str()
        .unwrap()
        .ends_with("{instructions}"));
    assert!(value["project"]["files"]
        .as_str()
        .unwrap()
        .contains("{files}"));
    for line in ["userLine", "assistantLine"] {
        let line = value["pastChats"][line].as_str().unwrap();
        assert!(line.contains("{title}") && line.contains("{date}") && line.contains("{excerpt}"));
    }
    let assistant = value["assistant"]["systemPrompt"].as_str().unwrap();
    assert!(assistant.contains("{name}") && assistant.contains("{instructions}"));
    let canvas = value["editing"]["canvas"]["message"].as_str().unwrap();
    assert!(canvas.contains("{document}") && canvas.contains("{instruction}"));
}
