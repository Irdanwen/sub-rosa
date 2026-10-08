//! The web client's deep research (ADR-0089), as Rust says it (see `mod.rs`).
//!
//! The prompts, the limits and the depths are the engine's own values. The
//! vectors are what Rust's pure functions answer for fixed inputs (the
//! request text, the plan parsing, the ceiling of each depth, the report
//! assembly with its citations resolved), so the TypeScript port is checked
//! against the original rather than against a restatement of it.

use crate::research::report::{self, HandedSource};
use crate::research::{estimate, prompts, Depth, PlanSection, ResearchPlan};

const DEPTHS: [Depth; 3] = [Depth::Quick, Depth::Standard, Depth::Deep];

fn depths() -> serde_json::Value {
    let map: serde_json::Map<String, serde_json::Value> = DEPTHS
        .iter()
        .map(|depth| {
            (
                depth.as_str().to_string(),
                serde_json::json!({
                    "maxSources": depth.max_sources(),
                    "maxQueries": depth.max_queries(),
                    "resultsPerQuery": depth.results_per_query(),
                    "ownSources": depth.own_sources(),
                }),
            )
        })
        .collect();
    serde_json::Value::Object(map)
}

fn vectors() -> serde_json::Value {
    let plan = ResearchPlan {
        title: "Heat pumps in cold climates".to_string(),
        sections: vec![
            PlanSection {
                title: "How they perform below zero".to_string(),
                queries: vec!["heat pump COP -20C field study".to_string()],
            },
            PlanSection {
                title: "What they cost".to_string(),
                queries: vec!["heat pump installation cost 2026".to_string()],
            },
        ],
    };
    let questions = vec!["Which country?".to_string(), "Which year?".to_string()];
    let answers = vec!["Switzerland".to_string(), String::new()];
    let request = prompts::request_text("Do heat pumps work in winter?", &questions, &answers);
    let handed = vec![
        HandedSource {
            index: 1,
            kind: "web".to_string(),
            title: "Field study [2025]".to_string(),
            url: Some("https://example.org/a study".to_string()),
        },
        HandedSource {
            index: 2,
            kind: "note".to_string(),
            title: "My notes".to_string(),
            url: None,
        },
        HandedSource {
            index: 3,
            kind: "connector".to_string(),
            title: "Drive file".to_string(),
            url: None,
        },
    ];
    let raw = "# Heat pumps\n\nThey work below zero [2]. Costs fell [1, 9][3]. See [the guide](https://x.example) and [note].\nRanges [1-2].\n\n## References\n\n1. invented";
    let assembled = report::assemble(&plan.title, raw, &handed);
    let untitled = report::assemble(&plan.title, "No citation at all [7].", &handed);
    let plan_reply = "Here is the plan:\n```json\n{\"title\":\"  Winter heat  \",\"sections\":[{\"title\":\"Performance\",\"queries\":[\"cop cold\",\"  \",\"heat pump   arctic\"]},{\"title\":\"\",\"queries\":[\"x\"]},{\"title\":\"No queries\",\"queries\":[]}]}\n```";
    serde_json::json!({
        "requestText": {
            "question": "Do heat pumps work in winter?",
            "questions": questions,
            "answers": answers,
            "text": request,
        },
        "noteUser": {
            "title": "A page",
            "url": "https://example.org/page",
            "text": "Body of the page.",
            "plan": plan,
            "user": prompts::note_user(&request, &plan, " A page ", "https://example.org/page", "Body of the page."),
        },
        "reportUser": {
            "notes": [[1, "First", "- a fact"], [2, "Second", "- another"]],
            "user": prompts::report_user(
                &request,
                &plan,
                &[(1, "First".to_string(), "- a fact".to_string()), (2, "Second".to_string(), "- another".to_string())],
            ),
        },
        "parseQuestions": {
            "reply": "Sure! {\"questions\":[\"  Which   city? \",\"\",\"When?\",\"Why?\",\"Fourth?\"]}",
            "questions": prompts::parse_questions("Sure! {\"questions\":[\"  Which   city? \",\"\",\"When?\",\"Why?\",\"Fourth?\"]}"),
        },
        "parsePlan": {
            "reply": plan_reply,
            "question": "Do heat pumps work in winter?",
            "plan": prompts::parse_plan(plan_reply, "Do heat pumps work in winter?"),
            "fallback": prompts::parse_plan("I cannot do that.", "Do heat pumps work in winter?"),
        },
        "irrelevant": {
            "IRRELEVANT": prompts::is_irrelevant("IRRELEVANT"),
            "Irrelevant.": prompts::is_irrelevant("Irrelevant."),
            "- The page says irrelevant things about heat pumps and more.": prompts::is_irrelevant("- The page says irrelevant things about heat pumps and more."),
        },
        "estimates": DEPTHS.iter().map(|depth| estimate(*depth, 5)).collect::<Vec<_>>(),
        "assemble": {
            "title": plan.title,
            "raw": raw,
            "handed": handed.iter().map(|source| serde_json::json!({
                "index": source.index,
                "kind": source.kind,
                "title": source.title,
                "url": source.url,
            })).collect::<Vec<_>>(),
            "markdown": assembled.markdown,
            "cited": assembled.cited.iter().map(|source| source.index).collect::<Vec<_>>(),
            "invented": assembled.invented,
            "reportTitle": report::report_title(&assembled.markdown, &plan.title),
            "withoutTitle": report::without_title(&assembled.markdown),
            "untitledRaw": "No citation at all [7].",
            "untitledMarkdown": untitled.markdown,
            "untitledInvented": untitled.invented,
        },
    })
}

fn export() -> serde_json::Value {
    serde_json::json!({
        "generatedBy": "src-tauri/src/agent_lite/web_features/research.rs",
        "promptVersion": prompts::RESEARCH_PROMPT_VERSION,
        "prompts": {
            "clarify": prompts::CLARIFY_SYSTEM,
            "plan": prompts::PLAN_SYSTEM,
            "note": prompts::NOTE_SYSTEM,
            "report": prompts::REPORT_SYSTEM,
        },
        "maxTokens": {
            "clarify": prompts::CLARIFY_MAX_TOKENS,
            "plan": prompts::PLAN_MAX_TOKENS,
            "note": prompts::NOTE_MAX_TOKENS,
            "report": prompts::REPORT_MAX_TOKENS,
        },
        "readPageChars": prompts::READ_PAGE_CHARS,
        "maxQuestionChars": crate::research::MAX_QUESTION_CHARS,
        "maxSections": crate::research::MAX_SECTIONS,
        "maxAnswerChars": crate::research::MAX_ANSWER_CHARS,
        "depths": depths(),
        "sourceHeadings": report::SOURCE_HEADINGS,
        "vectors": vectors(),
    })
}

#[test]
fn the_web_client_reads_what_rust_says() {
    super::written("research", export());
}
