//! The web client's assignments, scheduled tasks and daily brief (ADR-0091),
//! as Rust says them (see `mod.rs`): the travelling tables, the tool groups,
//! the words a run's prompt is made of, the clock's margins and the brief's
//! rules. The schedule and the prompt assembly are ported in TypeScript and
//! checked against the vectors rendered here by the Rust functions.

use crate::assignments::prompt::{self, words, Autonomy, Reviewed, RunPrompt};
use crate::assignments::schedule;
use crate::moments::daily;

fn groups() -> serde_json::Value {
    prompt::TOOL_GROUPS
        .iter()
        .map(|group| {
            serde_json::json!({
                "id": group.id,
                "lite": group.lite,
                "acts": group.acts,
            })
        })
        .collect()
}

/// Kind, title, autonomy, late slot, reviews and approved proposal.
type Case<'a> = (
    &'a str,
    &'a str,
    Autonomy,
    Option<&'a str>,
    &'a [Reviewed],
    Option<&'a str>,
);

fn prompt_vectors() -> serde_json::Value {
    let reviewed = vec![
        Reviewed {
            when: "2026-10-08".into(),
            approved: false,
            feedback: Some("Shorter, and only French sources".into()),
            result: Some("A long digest".into()),
        },
        Reviewed {
            when: "2026-10-07".into(),
            approved: true,
            feedback: None,
            result: None,
        },
    ];
    let cases: [Case; 4] = [
        (
            "assignment",
            "Veille énergie",
            Autonomy::Ask,
            Some("2026-10-08 09:00"),
            &reviewed,
            None,
        ),
        ("task", "Morning digest", Autonomy::Act, None, &[], None),
        (
            "assignment",
            "Inbox",
            Autonomy::Ask,
            None,
            &[],
            Some("Send the three drafts"),
        ),
        (
            "assignment",
            " Spaced ",
            Autonomy::Act,
            None,
            &reviewed,
            None,
        ),
    ];
    cases
        .iter()
        .map(|(kind, title, autonomy, late, reviewed, proposal)| {
            let goal = "Watch the French energy market\nand say what changed.";
            serde_json::json!({
                "input": {
                    "kind": kind,
                    "title": title,
                    "goal": goal,
                    "autonomy": autonomy.as_str(),
                    "lateFor": late,
                    "reviewed": reviewed.iter().map(|review| serde_json::json!({
                        "when": review.when,
                        "approved": review.approved,
                        "feedback": review.feedback,
                        "result": review.result,
                    })).collect::<Vec<_>>(),
                    "approvedProposal": proposal,
                },
                "prompt": prompt::run_prompt(&RunPrompt {
                    kind,
                    title,
                    goal,
                    autonomy: *autonomy,
                    late_for: *late,
                    reviewed,
                    approved_proposal: *proposal,
                }),
            })
        })
        .collect()
}

fn summary_vectors() -> serde_json::Value {
    [
        "Some work.\n\n## Result\n\n- Two new tenders, one due Friday.",
        "# Digest\nNothing new today.",
        "",
        "**Result:**\n* **Three** items moved.",
        "---\n\nA very long line that goes on and on about what was found, repeated until it passes the limit of the summary the inbox shows for one result, which is two hundred and forty characters, so that the clipping is part of what the vectors pin down for the web.",
    ]
    .iter()
    .map(|answer| serde_json::json!({ "answer": answer, "summary": prompt::result_summary(answer) }))
    .collect()
}

fn run_id_vectors() -> serde_json::Value {
    [
        (
            "0192f000-0000-7000-8000-000000000001",
            "2026-10-07T07:00:00Z",
        ),
        ("0192f000-0000-7000-8000-000000000001", "approved:run-1"),
        ("abc", "event:trigger:item"),
    ]
    .iter()
    .map(|(assignment, slot)| {
        serde_json::json!({
            "assignmentId": assignment,
            "slot": slot,
            "runId": crate::assignments::store::run_id(assignment, slot),
        })
    })
    .collect()
}

fn follow_up_vectors() -> serde_json::Value {
    [
        "# Notes\nWe met.\n## Next steps\n- [ ] Call Anna\n- **Send** the deck\n* Book the room\n- Too many",
        "**À faire**\n• Relancer le client\n# Autre\n- not this",
        "Nothing here.",
    ]
    .iter()
    .map(|content| serde_json::json!({ "content": content, "followUps": daily::follow_ups(content) }))
    .collect()
}

/// The agenda line of a day's entries (`daily::agenda_of`), which the web
/// client computes from a connected calendar's events.
fn agenda_vectors() -> serde_json::Value {
    let event = |start: i64, all_day: bool, title: &str, at: &str| daily::AgendaEvent {
        start,
        all_day,
        title: title.into(),
        at: at.into(),
    };
    let day = [
        event(1_000, false, "Stand-up", "09:00"),
        event(500, true, "Holiday", ""),
        event(5_000, false, "Review", "14:00"),
        event(3_000, false, "Lunch", "12:00"),
    ];
    let cases: [(&[daily::AgendaEvent], i64); 5] = [
        (&day, 0),
        (&day, 2_000),
        (&day, 9_000),
        (&day[1..2], 0),
        (&[], 0),
    ];
    cases
        .iter()
        .map(|(events, now)| {
            serde_json::json!({
                "events": events,
                "now": now,
                "agenda": daily::agenda_of(events, *now),
            })
        })
        .collect()
}

fn card_id_vectors() -> serde_json::Value {
    [
        ("mac", "2026-10-08"),
        ("0191d1a4-0000-7000-8000-00000000b10b", "2026-12-31"),
    ]
    .iter()
    .map(|(device, day)| {
        serde_json::json!({
            "device": device,
            "day": day,
            "id": crate::moments::daily_cards::card_id(device, day),
        })
    })
    .collect()
}

fn export() -> serde_json::Value {
    serde_json::json!({
        "generatedBy": "src-tauri/src/agent_lite/web_features/assignments.rs",
        "promptVersion": prompt::ASSIGNMENT_PROMPT_VERSION,
        "tables": super::tables(&["assignments", "assignment_runs", "daily_brief_cards"]),
        "toolGroups": groups(),
        "feedbackInPrompt": prompt::FEEDBACK_IN_PROMPT,
        "maxResultInPrompt": prompt::MAX_RESULT_IN_PROMPT,
        "words": {
            "approvedBeforeTitle": words::APPROVED_BEFORE_TITLE,
            "approvedAfterTitle": words::APPROVED_AFTER_TITLE,
            "taskBeforeTitle": words::TASK_BEFORE_TITLE,
            "taskAfterTitle": words::TASK_AFTER_TITLE,
            "assignmentBeforeTitle": words::ASSIGNMENT_BEFORE_TITLE,
            "assignmentAfterTitle": words::ASSIGNMENT_AFTER_TITLE,
            "askRule": words::ASK_RULE,
            "actRule": words::ACT_RULE,
            "approved": words::APPROVED,
            "rejected": words::REJECTED,
            "yourResult": words::YOUR_RESULT,
            "resultOpen": words::RESULT_OPEN,
            "resultClose": words::RESULT_CLOSE,
            "myFeedback": words::MY_FEEDBACK,
            "feedbackHeader": words::FEEDBACK_HEADER,
            "lateBeforeSlot": words::LATE_BEFORE_SLOT,
            "lateAfterSlot": words::LATE_AFTER_SLOT,
            "summaryRule": words::SUMMARY_RULE,
            "eventCause": words::EVENT_CAUSE,
            "maxProposalChars": words::MAX_PROPOSAL_CHARS,
        },
        "clock": {
            "lateAfterMinutes": schedule::LATE_AFTER.num_minutes(),
            "fallbackGraceMinutes": schedule::FALLBACK_GRACE.num_minutes(),
            "runTimeoutHours": crate::assignments::PHONE_RUN_TIMEOUT_HOURS,
            "startTimeoutMinutes": crate::assignments::START_TIMEOUT_MINUTES,
            "carryOutDays": crate::assignments::store::CARRY_OUT_DAYS,
        },
        "limits": {
            "titleChars": crate::assignments::MAX_TITLE_CHARS,
            "goalChars": crate::assignments::MAX_GOAL_CHARS,
        },
        "jobTag": crate::assignments::ASSIGNMENT_JOB_TAG,
        "dailyBrief": {
            "notifyWindowMinutes": daily::NOTIFY_WINDOW_MINUTES,
            "maxTopics": daily::MAX_TOPICS,
            "maxTopicChars": daily::MAX_TOPIC_CHARS,
            "linksPerTopic": daily::LINKS_PER_TOPIC,
            "maxNotes": daily::MAX_NOTES,
            "maxFollowUps": daily::MAX_FOLLOW_UPS,
            "maxItems": daily::MAX_ITEMS,
            "followUpHeadings": daily::FOLLOW_UP_HEADINGS,
            "defaultAtMinute": daily::DailyBriefSettings::default().at_minute,
            "keepDays": crate::moments::daily_cards::KEEP_DAYS,
        },
        "vectors": {
            "prompts": prompt_vectors(),
            "summaries": summary_vectors(),
            "runIds": run_id_vectors(),
            "followUps": follow_up_vectors(),
            "agendas": agenda_vectors(),
            "cardIds": card_id_vectors(),
        },
    })
}

#[test]
fn the_web_client_reads_what_rust_says() {
    super::written("assignments", export());
}
