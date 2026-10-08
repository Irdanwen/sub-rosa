//! What a run is told, and what it may use. Pure, so the words and the
//! permissions are tested rather than trusted.
//!
//! The tools are named once, as groups the person can read ("Search the web",
//! "Your notes"), and each group says what it means on each shell: Hermes
//! toolsets on the desktop, agent-lite tool names on the phone. A group that
//! leaves the device or changes the machine is dropped whenever the autonomy
//! is "ask first", whatever the person ticked.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// The prompt's own version, written on nothing yet but bumped with the
/// words, the way `NOTE_AI_PROMPT_VERSION` is.
pub const ASSIGNMENT_PROMPT_VERSION: u32 = 1;

/// How many reviewed results a run reads back.
pub const FEEDBACK_IN_PROMPT: usize = 5;
pub(crate) const MAX_RESULT_IN_PROMPT: usize = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Autonomy {
    /// "Ask before anything leaves the device": read, prepare, propose.
    Ask,
    /// "Act within these tools".
    Act,
}

impl Autonomy {
    pub fn parse(raw: &str) -> Self {
        if raw == "act" {
            Self::Act
        } else {
            Self::Ask
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Act => "act",
        }
    }
}

pub struct ToolGroup {
    pub id: &'static str,
    /// Hermes toolsets this group turns on (desktop runs).
    pub hermes: &'static [&'static str],
    /// Agent-lite tools this group turns on (phone runs).
    pub lite: &'static [&'static str],
    /// Leaves the device or changes the machine: never under "ask first".
    pub acts: bool,
}

/// The desktop's health and finance server (ADR-0099), apart from the
/// notes' `mcp-june_context` so that ticking the notes does not bring them.
pub const PERSONAL_DATA_TOOLSET: &str = "mcp-june_personal";

pub const TOOL_GROUPS: &[ToolGroup] = &[
    ToolGroup {
        id: "web",
        hermes: &["web", "vision"],
        lite: &["web_search", "fetch_page", "places_search"],
        acts: false,
    },
    ToolGroup {
        id: "notes",
        hermes: &["mcp-june_context", "session_search"],
        lite: &[
            "search_notes",
            "read_note",
            "list_recent_notes",
            "search_calendar",
            "search_past_chats",
            "create_note",
            "append_to_note",
        ],
        acts: false,
    },
    // Health and finances, read only (ADR-0099). Never part of the notes:
    // a run reads them only when its definition names them.
    ToolGroup {
        id: "personal",
        hermes: &[PERSONAL_DATA_TOOLSET],
        lite: &[
            crate::health::tool::TOOL,
            crate::finance::tool::SPENDING_TOOL,
            crate::finance::tool::SEARCH_TOOL,
        ],
        acts: false,
    },
    ToolGroup {
        id: "memory",
        hermes: &["memory"],
        lite: &["search_memories", "remember"],
        acts: false,
    },
    // The connected services (ADR-0092). Each connector tool keeps its own
    // allow, ask or deny rule inside a run, so an "ask" waits as a card.
    ToolGroup {
        id: "connectors",
        hermes: &[],
        lite: &["connectors"],
        acts: false,
    },
    ToolGroup {
        id: "files",
        hermes: &["file", "code_execution"],
        lite: &[],
        acts: true,
    },
    ToolGroup {
        id: "terminal",
        hermes: &["terminal"],
        lite: &[],
        acts: true,
    },
    ToolGroup {
        id: "browser",
        hermes: &["browser"],
        lite: &[],
        acts: true,
    },
];

/// The groups a run actually gets: the ones ticked, known, and allowed by
/// the autonomy.
pub fn effective_groups(tools: &[String], autonomy: Autonomy) -> Vec<&'static ToolGroup> {
    TOOL_GROUPS
        .iter()
        .filter(|group| tools.iter().any(|tool| tool == group.id))
        .filter(|group| autonomy == Autonomy::Act || !group.acts)
        .collect()
}

/// The `enabled_toolsets` a desktop run is created with. Always explicit, so
/// a run never falls back to whatever the cron default is that day, and
/// always with `todo`, the agent's own scratchpad.
pub fn hermes_toolsets(groups: &[&ToolGroup]) -> Vec<String> {
    let mut set: BTreeSet<&str> = BTreeSet::from(["todo"]);
    for group in groups {
        set.extend(group.hermes.iter().copied());
    }
    set.into_iter().map(str::to_string).collect()
}

/// The agent-lite tools a phone run may be offered.
pub fn lite_tools(groups: &[&ToolGroup]) -> BTreeSet<&'static str> {
    groups
        .iter()
        .flat_map(|group| group.lite.iter().copied())
        .collect()
}

/// One reviewed result, as the next run reads it back.
#[derive(Debug, Clone)]
pub struct Reviewed {
    pub when: String,
    pub approved: bool,
    pub feedback: Option<String>,
    pub result: Option<String>,
}

pub struct RunPrompt<'a> {
    pub kind: &'a str,
    pub title: &'a str,
    pub goal: &'a str,
    pub autonomy: Autonomy,
    /// `Some(slot)` when the run is late, with the slot it answers.
    pub late_for: Option<&'a str>,
    pub reviewed: &'a [Reviewed],
    /// A proposal the person approved, to carry out now.
    pub approved_proposal: Option<&'a str>,
}

fn clipped(text: &str, limit: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(limit).collect();
    cut.push('…');
    cut
}

/// The words a run's prompt is made of, in the order [`run_prompt`] joins
/// them. Kept as values so the web client reads the same sentences
/// (`agent_lite::web_features::assignments`) instead of a copy.
pub(crate) mod words {
    pub const APPROVED_BEFORE_TITLE: &str = "You are working on my assignment \"";
    pub const APPROVED_AFTER_TITLE: &str = "\". You proposed the following and I approved it. Carry it out now, within the tools you have, then tell me plainly what you did and anything you could not do.\n\nYour proposal:\n";
    pub const TASK_BEFORE_TITLE: &str = "This is a scheduled task I set up, \"";
    pub const TASK_AFTER_TITLE: &str = "\". Do it now:\n";
    pub const ASSIGNMENT_BEFORE_TITLE: &str =
        "You are working on a standing assignment I gave you, \"";
    pub const ASSIGNMENT_AFTER_TITLE: &str = "\". This is one of its regular runs.\n\nThe goal:\n";
    pub const ASK_RULE: &str = "Ask before anything leaves this device: do not send, post, buy, book, delete or change anything outside this conversation. Read, research and prepare, then end with a short proposal of what you would do next. I approve or reject it before anything happens.";
    pub const ACT_RULE: &str =
        "You may act within the tools you have, and only toward this goal. End with what you did.";
    pub const APPROVED: &str = "I approved";
    pub const REJECTED: &str = "I rejected";
    pub const YOUR_RESULT: &str = " your result";
    pub const RESULT_OPEN: &str = " (\"";
    pub const RESULT_CLOSE: &str = "\")";
    pub const MY_FEEDBACK: &str = ". My feedback: ";
    pub const FEEDBACK_HEADER: &str =
        "What I said about your recent results, newest first. Take it into account:\n";
    pub const LATE_BEFORE_SLOT: &str = "This run is late: it was due at ";
    pub const LATE_AFTER_SLOT: &str = ". Check whether anything has gone out of date since.";
    pub const SUMMARY_RULE: &str = "Finish with a short summary of the result, at most three sentences, under the heading \"Result\".";
    /// Joined to the goal of a run a connector event started.
    pub const EVENT_CAUSE: &str = "\n\nWhat started this run: ";
    /// How much of an approved proposal the carry-out run reads.
    pub const MAX_PROPOSAL_CHARS: usize = 2_000;
}

/// The message a run starts from. It is the user turn of the run's chat, so
/// it reads as the person's own standing instruction.
pub fn run_prompt(input: &RunPrompt) -> String {
    let mut parts = Vec::new();
    if let Some(proposal) = input.approved_proposal {
        parts.push(format!(
            "{}{}{}{}",
            words::APPROVED_BEFORE_TITLE,
            input.title.trim(),
            words::APPROVED_AFTER_TITLE,
            clipped(proposal, words::MAX_PROPOSAL_CHARS)
        ));
        return parts.join("\n\n");
    }
    if input.kind == "task" {
        parts.push(format!(
            "{}{}{}{}",
            words::TASK_BEFORE_TITLE,
            input.title.trim(),
            words::TASK_AFTER_TITLE,
            input.goal.trim()
        ));
    } else {
        parts.push(format!(
            "{}{}{}{}",
            words::ASSIGNMENT_BEFORE_TITLE,
            input.title.trim(),
            words::ASSIGNMENT_AFTER_TITLE,
            input.goal.trim()
        ));
    }
    parts.push(match input.autonomy {
        Autonomy::Ask => words::ASK_RULE.to_string(),
        Autonomy::Act => words::ACT_RULE.to_string(),
    });
    let reviewed: Vec<String> = input
        .reviewed
        .iter()
        .take(FEEDBACK_IN_PROMPT)
        .map(|review| {
            let verdict = if review.approved {
                words::APPROVED
            } else {
                words::REJECTED
            };
            let mut line = format!("- {}: {verdict}{}", review.when, words::YOUR_RESULT);
            if let Some(result) = review.result.as_deref().filter(|r| !r.trim().is_empty()) {
                line.push_str(&format!(
                    "{}{}{}",
                    words::RESULT_OPEN,
                    clipped(result, MAX_RESULT_IN_PROMPT),
                    words::RESULT_CLOSE
                ));
            }
            if let Some(feedback) = review.feedback.as_deref().filter(|f| !f.trim().is_empty()) {
                line.push_str(&format!("{}{}", words::MY_FEEDBACK, feedback.trim()));
            }
            line
        })
        .collect();
    if !reviewed.is_empty() {
        parts.push(format!("{}{}", words::FEEDBACK_HEADER, reviewed.join("\n")));
    }
    if let Some(slot) = input.late_for {
        parts.push(format!(
            "{}{slot}{}",
            words::LATE_BEFORE_SLOT,
            words::LATE_AFTER_SLOT
        ));
    }
    parts.push(words::SUMMARY_RULE.to_string());
    parts.join("\n\n")
}

/// The line a notification and the inbox show for a result: the summary the
/// run was asked for, or its first real line.
pub fn result_summary(answer: &str) -> String {
    let lines: Vec<&str> = answer.lines().map(str::trim).collect();
    let heading = lines.iter().position(|line| {
        line.trim_start_matches('#')
            .trim()
            .trim_matches('*')
            .trim_end_matches(':')
            .eq_ignore_ascii_case("result")
    });
    let from = heading.map_or(0, |index| index + 1);
    let summary = lines[from..]
        .iter()
        .find(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("---"))
        .copied()
        .unwrap_or_default()
        .trim_start_matches(['-', '*', '•'])
        .replace("**", "");
    clipped(&summary, 240)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tools(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn ask_first_drops_whatever_leaves_the_device() {
        let ticked = tools(&["web", "terminal", "browser", "notes"]);
        let asked: Vec<_> = effective_groups(&ticked, Autonomy::Ask)
            .iter()
            .map(|group| group.id)
            .collect();
        assert_eq!(asked, ["web", "notes"]);
        let acting: Vec<_> = effective_groups(&ticked, Autonomy::Act)
            .iter()
            .map(|group| group.id)
            .collect();
        assert_eq!(acting, ["web", "notes", "terminal", "browser"]);
    }

    #[test]
    fn a_desktop_run_names_its_toolsets_and_a_phone_run_its_tools() {
        let groups = effective_groups(&tools(&["web", "memory", "made-up"]), Autonomy::Act);
        assert_eq!(
            hermes_toolsets(&groups),
            ["memory", "todo", "vision", "web"]
        );
        let lite = lite_tools(&groups);
        assert!(lite.contains("web_search") && lite.contains("remember"));
        assert!(!lite.contains("create_note"), "notes were not ticked");
        // Nothing ticked still gets an explicit, minimal list.
        assert_eq!(hermes_toolsets(&[]), ["todo"]);
    }

    #[test]
    fn the_notes_never_bring_the_health_and_the_money_with_them() {
        let personal = ["health_summary", "spending_summary", "transactions_search"];
        let notes = effective_groups(&tools(&["notes"]), Autonomy::Ask);
        let lite = lite_tools(&notes);
        assert!(personal.iter().all(|tool| !lite.contains(tool)));
        assert!(!hermes_toolsets(&notes).contains(&PERSONAL_DATA_TOOLSET.to_string()));
        assert!(hermes_toolsets(&notes).contains(&"mcp-june_context".to_string()));

        // Named, they reach both shells, under either autonomy: reading
        // them leaves nothing and changes nothing.
        for autonomy in [Autonomy::Ask, Autonomy::Act] {
            let groups = effective_groups(&tools(&["notes", "personal"]), autonomy);
            let lite = lite_tools(&groups);
            assert!(personal.iter().all(|tool| lite.contains(tool)));
            assert!(hermes_toolsets(&groups).contains(&PERSONAL_DATA_TOOLSET.to_string()));
        }
    }

    #[test]
    fn feedback_reaches_the_next_run_newest_first() {
        let reviewed = vec![
            Reviewed {
                when: "8 Oct".into(),
                approved: false,
                feedback: Some("Shorter, and only French sources".into()),
                result: Some("A long digest".into()),
            },
            Reviewed {
                when: "7 Oct".into(),
                approved: true,
                feedback: None,
                result: None,
            },
        ];
        let prompt = run_prompt(&RunPrompt {
            kind: "assignment",
            title: "Veille énergie",
            goal: "Watch the French energy market",
            autonomy: Autonomy::Ask,
            late_for: Some("2026-10-08T07:00:00Z"),
            reviewed: &reviewed,
            approved_proposal: None,
        });
        assert!(prompt.contains("Watch the French energy market"));
        assert!(prompt.contains("Ask before anything leaves this device"));
        let rejected = prompt.find("8 Oct: I rejected").unwrap();
        let approved = prompt.find("7 Oct: I approved").unwrap();
        assert!(rejected < approved);
        assert!(prompt.contains("My feedback: Shorter, and only French sources"));
        assert!(prompt.contains("This run is late"));
    }

    #[test]
    fn an_approved_proposal_is_carried_out_not_proposed_again() {
        let prompt = run_prompt(&RunPrompt {
            kind: "assignment",
            title: "Inbox",
            goal: "Draft replies",
            autonomy: Autonomy::Ask,
            late_for: None,
            reviewed: &[],
            approved_proposal: Some("Send the three drafts"),
        });
        assert!(prompt.contains("Carry it out now"));
        assert!(prompt.contains("Send the three drafts"));
        assert!(!prompt.contains("I approve or reject it"));
    }

    #[test]
    fn the_summary_is_the_result_section_or_the_first_line() {
        assert_eq!(
            result_summary("Some work.\n\n## Result\n\n- Two new tenders, one due Friday."),
            "Two new tenders, one due Friday."
        );
        assert_eq!(
            result_summary("# Digest\nNothing new today."),
            "Nothing new today."
        );
        assert_eq!(result_summary(""), "");
    }
}
