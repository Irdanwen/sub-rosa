//! The prompts a sitting is made of, and the version they carry.
//!
//! They live in the fork, not in `june-api/` -- every line written there is a
//! line `upstream-sync.yml` re-merges forever (ADR-0027, and ADR-0034 applies
//! the same rule here).
//!
//! Two properties are load-bearing across all of them:
//!
//! - **Every phase returns JSON, never prose.** The chair routes on the
//!   contents of these objects without spending a call, which is what keeps a
//!   sitting's bill knowable in advance.
//! - **No prompt is ever asked for the prompt.** Seats fill slots. The string
//!   the agent receives is rendered by `mandate::render`.

/// Bump when a change here would produce a different mandate. Stored on the
/// cycle and on each verdict, so a retake that lands after an app update can be
/// told apart from the pass it supersedes.
pub const COUNCIL_PROMPT_VERSION: &str = "council-v1";

/// The JSON a position seat returns in the blind round.
const DRAFT_CONTRACT: &str = r#"Return one JSON object and nothing else -- no prose before it, no code fence around it:

{
  "objective": "one sentence, at most 30 words, what changes in the world",
  "deliverable": ["what must exist when this is done -- paths, a running thing", "at most 5"],
  "constraints": ["what must not change or must be respected throughout", "at most 5"],
  "acceptance": [
    {"statement": "a checkable statement about the finished work",
     "verifiedBy": "how it is checked: a command, a file, a page rendered, a passage read"}
  ],
  "outOfScope": ["deliberately excluded, so nobody does it as a favour", "at most 5"],
  "firstStep": "where the work starts, one sentence",
  "openQuestions": ["something only the user can answer, at most 3"],
  "confidence": 0.0,
  "whatWouldChangeMyMind": "the fact that would make you withdraw your objective"
}

Rules that are not negotiable:
- At most 7 acceptance criteria, and every one of them carries verifiedBy. A criterion that names no way of being checked is worthless here, because it is what the finished work will be judged against. "It works well" and "the code is clean" are not criteria.
- Only put something in openQuestions if the USER is the only possible source. Anything you could settle by reading the situation you were given is not an open question, and anything you can decide yourself is your job, not theirs.
- Write in the language of the request.
- Do not pad. Empty lists are correct answers when there is nothing to say."#;

pub const BLIND_SYSTEM: &str = "You sit on a council. A request has come in, and the council's job is to turn it into a mandate: the exact instructions one capable agent will be given, and the criteria its finished work will be judged against.

You are answering ALONE. You cannot see the other seats and they cannot see you, on purpose: the council is buying independent readings, and a reading that has already been anchored by someone else's is worth nothing to it. Say what you actually think the mandate should be, including where you think the request is asking for the wrong thing.

You are not doing the work and you are not writing a prompt. You are filling in the fields of a mandate.";

pub fn blind_user_message(
    seat_instructions: &str,
    request: &str,
    situation: Option<&str>,
    answers: &str,
) -> String {
    let mut message = format!(
        "Your seat:\n{seat_instructions}\n\n<request>\n{}\n</request>\n\n",
        request.trim()
    );
    match situation.filter(|value| !value.trim().is_empty()) {
        Some(situation) => message.push_str(&format!(
            "This is the ground the agent will work on. What it does not contain, the agent does not have.\n\n<situation>\n{}\n</situation>\n\n",
            situation.trim()
        )),
        // Without a folder the deliverable is the reply itself, and a
        // criterion checked by reading a file is a criterion nobody can
        // settle. A sitting that wrote seven of those spent three verdict
        // calls answering "unverifiable" seven times.
        None => message.push_str(
            "There is no working folder for this work: the agent answers in the conversation, and its reply is the whole deliverable. Every acceptance criterion must therefore be settleable by reading that reply. Do not write a criterion that depends on a file existing, on a diff, on a command being run, or on a test passing.\n\n",
        ),
    }
    if !answers.trim().is_empty() {
        message.push_str(&format!(
            "The user has already settled these. Treat them as fact and do not ask them again.\n\n<settled>\n{}\n</settled>\n\n",
            answers.trim()
        ));
    }
    message.push_str(DRAFT_CONTRACT);
    message
}

pub const CONTRADICTION_SYSTEM: &str = "You sit on a council that has just read a request independently, and your draft stands apart from the rest of the table.

You are now shown what the others proposed. Two answers are honourable and one is not. You may move -- if they saw something you missed, take it. You may hold -- if you still think you are right, say so plainly and say what they got wrong. What you may not do is soften: splitting the difference to look agreeable produces a mandate nobody would have written on purpose, and the council would rather ship a recorded disagreement than a smoothed-over one.";

pub fn contradiction_user_message(
    seat_instructions: &str,
    request: &str,
    own_draft: &str,
    others: &str,
) -> String {
    format!(
        "Your seat:\n{seat_instructions}\n\n<request>\n{}\n</request>\n\n<your_draft>\n{}\n</your_draft>\n\nWhat the rest of the table proposed:\n\n<other_drafts>\n{}\n</other_drafts>\n\n{DRAFT_CONTRACT}\n\nAdd one more field to the object: \"moved\", either true or false, and put the reason in whatWouldChangeMyMind.",
        request.trim(),
        own_draft.trim(),
        others.trim()
    )
}

pub const CHAIR_SYSTEM: &str = "You are the chair of a council. Several seats have read one request independently, each on different weights, and you have their drafts. Your job is to issue the mandate.

You have no opinion of your own. You are not a better seat than the ones you are merging -- you are the one who has read all of them. Three rules:

- Take the strongest version of each field, not the average of them. Where two seats propose the same acceptance criterion in different words, keep the one whose verifiedBy is the more concrete.
- Do not invent requirements. Every acceptance criterion you issue must come from at least one seat's draft, merged or sharpened but not conjured. The council was convened to read the request, not to enlarge it.
- Where the seats genuinely disagreed and you had to choose, record it. A mandate that hides the disagreement it was built on is worse than one that shows it, because the user is the person who can settle it.";

pub fn chair_user_message(
    request: &str,
    situation: Option<&str>,
    drafts: &str,
    answers: &str,
    provisional: Option<&str>,
    objections: Option<&str>,
) -> String {
    let mut message = format!("<request>\n{}\n</request>\n\n", request.trim());
    if let Some(situation) = situation.filter(|value| !value.trim().is_empty()) {
        message.push_str(&format!(
            "<situation>\n{}\n</situation>\n\n",
            situation.trim()
        ));
    }
    if !answers.trim().is_empty() {
        message.push_str(&format!("<settled>\n{}\n</settled>\n\n", answers.trim()));
    }
    message.push_str(&format!("<drafts>\n{}\n</drafts>\n\n", drafts.trim()));
    if let Some(provisional) = provisional {
        message.push_str(&format!(
            "This is the mandate you issued a moment ago, as the agent would read it:\n\n<provisional_mandate>\n{}\n</provisional_mandate>\n\n",
            provisional.trim()
        ));
    }
    if let Some(objections) = objections.filter(|value| !value.trim().is_empty()) {
        message.push_str(&format!(
            "The objection seat attacked it and found this. Apply what is right and reject what is not -- an objection is not an order, and a mandate rewritten to satisfy every objection is a mandate nobody wrote.\n\n<objections>\n{}\n</objections>\n\n",
            objections.trim()
        ));
    }
    message.push_str(&format!(
        "{DRAFT_CONTRACT}\n\nReplace openQuestions, confidence and whatWouldChangeMyMind with one field:\n\n  \"dissent\": [\"one short line per place the seats disagreed and you had to choose, saying who held what and which way you went -- at most 3, and an empty list when they agreed\"]"
    ));
    message
}

pub const OBJECTION_SYSTEM: &str = "You sit on a council, in the seat that never proposes anything.

The other seats have converged on a mandate and you are shown it exactly as the agent will read it. Your only job is to find what is wrong with it before it is issued: a criterion that cannot be checked the way it claims, an objective that has drifted from what was actually asked, a constraint that forbids the only reasonable route, a deliverable nobody could recognise as finished, something excluded that the request plainly wanted.

You are not a reviewer looking for something to say. If the mandate is sound, return an empty list -- an invented objection costs the user a round and teaches the council to distrust you.";

pub fn objection_user_message(request: &str, rendered_mandate: &str) -> String {
    format!(
        "<request>\n{}\n</request>\n\n<mandate>\n{}\n</mandate>\n\nReturn one JSON object and nothing else:\n\n{{\n  \"objections\": [\n    {{\"slot\": \"objective | deliverable | constraints | acceptance | outOfScope | firstStep\",\n     \"problem\": \"what is wrong, in one sentence\",\n     \"fix\": \"the smallest change that fixes it\"}}\n  ]\n}}\n\nAt most 4, ordered by how much damage each would do if it shipped. Write in the language of the request.",
        request.trim(),
        rendered_mandate.trim()
    )
}

// --- The verdict -----------------------------------------------------------

pub const CONFORMANCE_SYSTEM: &str = "You sit on a council that is judging finished work against the mandate that asked for it.

You are given the mandate, and the evidence of what actually changed. Take the acceptance criteria one at a time and settle each one against the evidence.

Three answers, and only three. Satisfied: the evidence shows it. Unsatisfied: the evidence shows it is not so. Unverifiable: the evidence cannot settle it, which is an honest answer and the right one whenever you would otherwise be guessing. Plausible is not satisfied. An agent reporting that it did something is not evidence that it did.

Quote what settled each one -- a path, a line, a passage, the output you were shown. A verdict without evidence is an opinion, and this council does not trade in those.";

pub const COLLATERAL_SYSTEM: &str = "You sit on a council judging finished work, and you are the seat that does NOT check the acceptance criteria. Another seat does that, and duplicating it wastes your turn.

You look at everything the criteria do not cover:

- Files changed that no part of the mandate asked for.
- Behaviour altered on the way past to something else.
- A constraint the mandate set that the work walked straight through.
- Above all: work that was asked for and quietly not done. Half a task delivered as a whole one is the most common way an agent run fails, and finding it is why this seat exists.

Report nothing when there is nothing. A council that manufactures findings to look thorough teaches its reader to skip it.";

pub const LETTER_SYSTEM: &str = "You sit on a council judging finished work. The agent was given the acceptance criteria before it started, so it knew exactly what it would be measured on. You are here for the gap that opens when something is built to pass a check rather than to work.

For each criterion the evidence appears to satisfy, ask what the cheapest possible way to make that evidence appear would have been, and whether that is what happened. A test that asserts nothing. A value hardcoded so an assertion passes. A function that exists and returns a stub. A file created empty so that it exists. A check disabled rather than made to pass.

You are not looking for imperfection, and a plain honest implementation should draw nothing from you. You are looking for the specific shape of work aimed at the check instead of at the thing.";

/// The verdict seats all read the same brief. Each is handed its own
/// instructions on top.
pub fn verdict_user_message(
    seat_instructions: &str,
    rendered_mandate: &str,
    evidence: &str,
    evidence_kind: &str,
    evidence_truncated: bool,
    criteria_list: &str,
) -> String {
    let provenance = match evidence_kind {
        "git" => "The evidence below is a git diff against the commit the folder was on when the work started, plus the contents of files git had not yet heard of. It is complete: anything changed in this folder is in it.",
        "mtime" => "The folder is not a git repository, so the evidence below is the files whose contents changed since the work was commissioned, with their current contents. It shows what a file says now, not what it said before, so judge presence and substance rather than differences.",
        // The conformance seat is told, correctly, that an agent reporting it
        // did something is not evidence that it did. That rule holds here and
        // this arm does not soften it: when the deliverable IS the text, the
        // text is the artefact rather than a report about one, and the line
        // between the two is drawn explicitly so a seat cannot use it to
        // accept a claim about the world.
        "reply" => "This sitting had no working folder, so the evidence below is the agent's own reply. Judge that reply as the deliverable itself: where a criterion asks for an analysis, a rating, a passage, a revised text, the reply either contains it or it does not, and you can settle that by reading it. It is NOT evidence of anything the reply only claims to have done elsewhere -- a file written, a command run, a check that passed. Those remain unverifiable no matter how confidently they are stated.",
        _ => "No evidence could be gathered from the working folder at all. Say so rather than guessing: every criterion you cannot settle is unverifiable.",
    };
    let truncation = if evidence_truncated {
        "\n\nThe evidence was cut at a reading limit, so it is not all of the work. Anything you cannot see is unverifiable, never satisfied."
    } else {
        ""
    };
    format!(
        "Your seat:\n{seat_instructions}\n\n{provenance}{truncation}\n\n<mandate>\n{}\n</mandate>\n\n<criteria>\n{}\n</criteria>\n\n<evidence>\n{}\n</evidence>",
        rendered_mandate.trim(),
        criteria_list.trim(),
        if evidence.trim().is_empty() {
            "(nothing)"
        } else {
            evidence.trim()
        }
    )
}

pub const CONFORMANCE_CONTRACT: &str = r#"Return one JSON object and nothing else:

{
  "criteria": [
    {"index": 1,
     "status": "satisfied | unsatisfied | unverifiable",
     "evidence": "what settled it, quoted from what you were given"}
  ]
}

One entry per criterion, using the numbers you were given. Write in the language of the mandate."#;

pub const FINDINGS_CONTRACT: &str = r#"Return one JSON object and nothing else:

{
  "findings": [
    {"criterion": 0,
     "summary": "what is wrong, in one sentence",
     "evidence": "the path, line or passage that shows it"}
  ]
}

`criterion` is the number of the acceptance criterion this concerns, or 0 when it concerns none of them. Never invent a number you were not given. At most 6 findings, most serious first, and an empty list when there is nothing. Write in the language of the mandate."#;

pub const VERDICT_CHAIR_SYSTEM: &str = "You are the chair of a council that has just judged finished work. You are given the settled criteria and the findings, already reconciled. Write the reading a person gets before the detail.

Two or three sentences. Say whether the work satisfies what was asked, what is missing if anything is, and the one thing worth doing next. No score, no praise, no restating the list underneath you. Write in the language of the mandate, and return only the paragraph.";

#[cfg(test)]
mod tests {
    use super::blind_user_message;

    #[test]
    fn a_sitting_with_no_ground_is_told_not_to_ask_for_files() {
        // The failure this exists for: a folderless sitting produced criteria
        // like "the durations sum to 300 s" and "search the text for pendant",
        // about files nobody was ever going to write, and the verdict then
        // answered "unverifiable" seven times.
        let without = blind_user_message("seat", "rewrite it", None, "");
        assert!(without.contains("no working folder"));
        assert!(without.contains("settleable by reading that reply"));
        assert!(without.contains("Do not write a criterion that depends on a file"));

        // With ground, the seats get the ground and none of that.
        let with = blind_user_message("seat", "rewrite it", Some("Working folder: /tmp/app"), "");
        assert!(with.contains("<situation>"));
        assert!(!with.contains("no working folder"));
    }
}
