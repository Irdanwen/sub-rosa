//! The prompts of a deep research run, and the reading of what they return.
//!
//! These are the product (ADR-0027's rule for fork-side prompts): when a
//! report disappoints, change the words here and bump
//! [`RESEARCH_PROMPT_VERSION`]. Nothing of it goes in `june-api/`.

use super::{PlanSection, ResearchPlan};

pub const RESEARCH_PROMPT_VERSION: u32 = 1;

/// Characters of one page handed to the note-taking pass. A long article is
/// read from its start, which is where pages put what they are about.
pub const READ_PAGE_CHARS: usize = 14_000;
pub const CLARIFY_MAX_TOKENS: u32 = 500;
pub const PLAN_MAX_TOKENS: u32 = 1_500;
pub const NOTE_MAX_TOKENS: u32 = 700;
pub const REPORT_MAX_TOKENS: u32 = 8_000;

pub const CLARIFY_SYSTEM: &str = "You prepare a research assignment. Read the person's request and decide whether anything essential is ambiguous: the scope, the period, the place, the audience or the purpose. Ask at most three short questions, only about what would change where you search or what the report concludes, and none when the request is already clear. Answer with one JSON object and nothing else: {\"questions\":[\"…\"]}. Write the questions in the language of the request.";

pub const PLAN_SYSTEM: &str = "You plan a research report. Given the request and the person's answers to the clarifying questions, write the plan as one JSON object and nothing else: {\"title\":\"<the report's title>\",\"sections\":[{\"title\":\"<what this section answers>\",\"queries\":[\"<a web search query>\"]}]}. Three to six sections, in the order a reader needs them. One to three queries per section, each a short search-engine query (not a question to a person), specific enough to find primary sources, figures and recent facts. Write the title and the section titles in the language of the request; queries may be in English when the best sources are.";

pub const NOTE_SYSTEM: &str = "You take research notes on one source for a report. Write only what the source itself says that bears on the research question and its plan: facts, figures with their units and dates, named people and organisations, definitions, and the source's own conclusions. Keep the source's numbers exact. No opinions of your own, no introduction, at most 200 words, as short bullet points. If the source says nothing useful for the question (an error page, a cookie wall, an unrelated page), answer with the single word IRRELEVANT.";

pub const REPORT_SYSTEM: &str = "You write a research report from numbered source notes. Rules:\n- Use only what the notes say. Never add facts from memory.\n- After every claim, cite the note it comes from as [n], using the numbers you were given. Several sources: [2][5]. Never invent a number.\n- Start with the title as a level-one heading (#), then a section headed as \"Executive summary\" (in the report's language) of five to eight sentences, then one level-two heading (##) per section of the plan, then a short conclusion that says what remains uncertain and where sources disagree.\n- Use short paragraphs, bullet lists where they help, and a markdown table when comparing figures.\n- Do not write a list of sources or references at the end: the app adds it.\n- Write in the language of the request.";

/// The request as the planning passes read it.
pub fn request_text(question: &str, questions: &[String], answers: &[String]) -> String {
    let mut out = format!("Request: {}\n", question.trim());
    let pairs: Vec<(&String, &str)> = questions
        .iter()
        .enumerate()
        .map(|(index, asked)| {
            (
                asked,
                answers.get(index).map(|a| a.trim()).unwrap_or_default(),
            )
        })
        .filter(|(_, answer)| !answer.is_empty())
        .collect();
    if !pairs.is_empty() {
        out.push_str("\nClarifications:\n");
        for (asked, answer) in pairs {
            out.push_str(&format!("- {}: {}\n", asked.trim(), answer));
        }
    }
    out
}

fn plan_outline(plan: &ResearchPlan) -> String {
    let mut out = format!("Report: {}\n", plan.title.trim());
    for section in &plan.sections {
        out.push_str(&format!("- {}\n", section.title.trim()));
    }
    out
}

pub fn note_user(request: &str, plan: &ResearchPlan, title: &str, url: &str, text: &str) -> String {
    let text: String = text.chars().take(READ_PAGE_CHARS).collect();
    format!(
        "{request}\nPlan:\n{}\nSource: {} ({})\n\n{}\n",
        plan_outline(plan),
        title.trim(),
        url.trim(),
        text.trim()
    )
}

/// The notes as the report pass reads them, numbered the way it must cite.
pub fn report_user(
    request: &str,
    plan: &ResearchPlan,
    notes: &[(usize, String, String)],
) -> String {
    let mut out = format!(
        "{request}\nPlan:\n{}\nSource notes:\n\n",
        plan_outline(plan)
    );
    for (index, title, text) in notes {
        out.push_str(&format!("[{index}] {}\n{}\n\n", title.trim(), text.trim()));
    }
    out
}

/// The JSON object in a reply, wherever the model put it (bare, fenced, or
/// after a sentence it was asked not to write).
pub fn json_object(reply: &str) -> Option<serde_json::Value> {
    let start = reply.find('{')?;
    let end = reply.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(&reply[start..=end])
        .ok()
        .filter(serde_json::Value::is_object)
}

fn strings(value: Option<&serde_json::Value>, max: usize, max_chars: usize) -> Vec<String> {
    value
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|text| !text.is_empty())
                .map(|text| text.chars().take(max_chars).collect())
                .take(max)
                .collect()
        })
        .unwrap_or_default()
}

/// At most three questions; none when the reply has none to offer.
pub fn parse_questions(reply: &str) -> Vec<String> {
    match json_object(reply) {
        Some(value) => strings(value.get("questions"), 3, 300),
        None => Vec::new(),
    }
}

/// The plan the model proposed, or a one-section plan over the question when
/// it answered with something else: the person edits the plan anyway.
pub fn parse_plan(reply: &str, question: &str) -> ResearchPlan {
    let value = json_object(reply);
    let title = value
        .as_ref()
        .and_then(|value| value.get("title"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(|title| title.chars().take(160).collect::<String>());
    let sections: Vec<PlanSection> = value
        .as_ref()
        .and_then(|value| value.get("sections"))
        .and_then(serde_json::Value::as_array)
        .map(|sections| {
            sections
                .iter()
                .filter_map(|section| {
                    let title = section
                        .get("title")
                        .and_then(serde_json::Value::as_str)?
                        .trim()
                        .chars()
                        .take(160)
                        .collect::<String>();
                    let queries = strings(section.get("queries"), 3, 200);
                    (!title.is_empty() && !queries.is_empty())
                        .then_some(PlanSection { title, queries })
                })
                .take(8)
                .collect()
        })
        .unwrap_or_default();
    let question_title: String = question.trim().chars().take(160).collect();
    if sections.is_empty() {
        return ResearchPlan {
            title: title.unwrap_or_else(|| question_title.clone()),
            sections: vec![PlanSection {
                title: question_title.clone(),
                queries: vec![question_title],
            }],
        };
    }
    ResearchPlan {
        title: title.unwrap_or(question_title),
        sections,
    }
}

/// A note-taking reply that says the source was of no use.
pub fn is_irrelevant(note: &str) -> bool {
    let head: String = note
        .trim()
        .trim_matches(|c: char| !c.is_alphanumeric())
        .chars()
        .take(12)
        .collect();
    note.trim().len() < 40 && head.eq_ignore_ascii_case("irrelevant")
}
