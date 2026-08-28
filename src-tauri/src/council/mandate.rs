//! The mandate: capped slots in, one deterministic string out.
//!
//! This module is where ADR-0034's first rule lives. **The app owns the
//! prompt; the council owns the fields.** Seats fill slots, this renders them,
//! and no model is ever handed the job of writing the string the agent
//! receives. It is the same division ADR-0027 draws around time: the model
//! supplies what it can know, the app composes what it cannot.
//!
//! The caps are not decoration either. Three models asked for "the best
//! prompt" each return nine hundred words and the merge returns two thousand;
//! length buries the constraints that matter. A slot that will not fit is
//! *cut*, and every cut is reported -- a truncation nobody is told about reads
//! as "everything you asked for is in there".

use crate::domain::types::{AcceptanceCriterionDto, CouncilQuestionDto, MandateDto};

pub const OBJECTIVE_MAX_WORDS: usize = 30;
pub const DELIVERABLE_MAX: usize = 5;
pub const CONSTRAINTS_MAX: usize = 5;
pub const ACCEPTANCE_MAX: usize = 7;
pub const OUT_OF_SCOPE_MAX: usize = 5;
pub const LINE_MAX_CHARS: usize = 200;
pub const STATEMENT_MAX_CHARS: usize = 240;

/// What normalising a mandate had to cut. Empty is the good case, and a
/// non-empty one is shown, never swallowed.
pub type Cuts = Vec<String>;

/// Bring a mandate inside its caps, and say what that cost.
///
/// Every list is trimmed of blanks and de-duplicated case-insensitively before
/// it is cut to length, so a model that repeats itself does not spend a slot
/// twice. Criteria with no means of verification are dropped rather than
/// truncated: an unverifiable criterion is not a shorter criterion, it is a
/// different kind of thing, and the verdict would have nothing to do with it.
pub fn normalize(mandate: &MandateDto) -> (MandateDto, Cuts) {
    let mut cuts = Cuts::new();

    let (objective, objective_cut) = clamp_words(&mandate.objective, OBJECTIVE_MAX_WORDS);
    if objective_cut {
        cuts.push(format!(
            "The objective ran past {OBJECTIVE_MAX_WORDS} words and was cut to the first {OBJECTIVE_MAX_WORDS}."
        ));
    }

    let deliverable = clamp_list(
        &mandate.deliverable,
        DELIVERABLE_MAX,
        "deliverable",
        &mut cuts,
    );
    let constraints = clamp_list(
        &mandate.constraints,
        CONSTRAINTS_MAX,
        "constraint",
        &mut cuts,
    );
    let out_of_scope = clamp_list(
        &mandate.out_of_scope,
        OUT_OF_SCOPE_MAX,
        "out-of-scope entry",
        &mut cuts,
    );

    let mut acceptance: Vec<AcceptanceCriterionDto> = Vec::new();
    let mut unverifiable = 0usize;
    for criterion in &mandate.acceptance {
        let statement = clamp_chars(criterion.statement.trim(), STATEMENT_MAX_CHARS);
        let verified_by = clamp_chars(criterion.verified_by.trim(), LINE_MAX_CHARS);
        if statement.is_empty() {
            continue;
        }
        if verified_by.is_empty() {
            unverifiable += 1;
            continue;
        }
        if acceptance
            .iter()
            .any(|existing| existing.statement.eq_ignore_ascii_case(&statement))
        {
            continue;
        }
        acceptance.push(AcceptanceCriterionDto {
            statement,
            verified_by,
        });
    }
    if unverifiable > 0 {
        cuts.push(format!(
            "{unverifiable} acceptance criterion(s) named no way of being checked and were dropped."
        ));
    }
    if acceptance.len() > ACCEPTANCE_MAX {
        cuts.push(format!(
            "{} acceptance criteria were proposed and the last {} were dropped: a mandate holds {ACCEPTANCE_MAX}.",
            acceptance.len(),
            acceptance.len() - ACCEPTANCE_MAX
        ));
        acceptance.truncate(ACCEPTANCE_MAX);
    }

    let (first_step, first_step_cut) = clamp_words(&mandate.first_step, OBJECTIVE_MAX_WORDS);
    if first_step_cut {
        cuts.push("The first step ran long and was cut.".to_string());
    }

    (
        MandateDto {
            objective,
            deliverable,
            constraints,
            acceptance,
            out_of_scope,
            first_step,
        },
        cuts,
    )
}

/// Why a mandate cannot be issued. An empty list means it can.
///
/// Deliberately short: this is the floor below which the cycle has no meaning,
/// not a style guide. A mandate with no objective says nothing, and a mandate
/// with no acceptance criterion cannot be judged -- which would leave the
/// verdict with nothing to do and the whole feature with nothing to show.
pub fn validate(mandate: &MandateDto) -> Vec<String> {
    let mut problems = Vec::new();
    if mandate.objective.trim().is_empty() {
        problems.push("The mandate has no objective.".to_string());
    }
    if mandate.acceptance.is_empty() {
        problems.push(
            "The mandate has no acceptance criterion, so nothing could judge it.".to_string(),
        );
    }
    if mandate
        .acceptance
        .iter()
        .any(|criterion| criterion.verified_by.trim().is_empty())
    {
        problems.push("An acceptance criterion names no way of being checked.".to_string());
    }
    problems
}

/// The string the agent is handed. Deterministic: same mandate, same bytes.
///
/// The criteria are given to the executor on purpose. Hidden tests produce
/// loops where an agent guesses at what it is being measured on, and the
/// defence against building to the test lives in the verdict instead -- one
/// seat looks for exactly that (ADR-0034).
pub fn render(mandate: &MandateDto, request: &str, questions: &[CouncilQuestionDto]) -> String {
    let mut out = String::new();
    out.push_str(
        "You are working under a mandate. It was written before this session started, by several \
models reading the request independently, and it is what your work will be judged against when \
you report it finished.\n\n",
    );

    out.push_str("# Objective\n");
    out.push_str(mandate.objective.trim());
    out.push_str("\n\n");

    if !mandate.deliverable.is_empty() {
        out.push_str("# Deliverable\nWhat must exist when this is done:\n");
        for line in &mandate.deliverable {
            out.push_str(&format!("- {line}\n"));
        }
        out.push('\n');
    }

    if !mandate.constraints.is_empty() {
        out.push_str("# Constraints\nThese hold for the whole of this work:\n");
        for line in &mandate.constraints {
            out.push_str(&format!("- {line}\n"));
        }
        out.push('\n');
    }

    out.push_str(
        "# Acceptance criteria\nEach one says how it is checked. Satisfy them in substance, not \
in appearance: a check that passes because it was written to pass is a failure, and it will be \
read as one.\n",
    );
    for (index, criterion) in mandate.acceptance.iter().enumerate() {
        out.push_str(&format!(
            "{}. {}\n   Verified by: {}\n",
            index + 1,
            criterion.statement.trim(),
            criterion.verified_by.trim()
        ));
    }
    out.push('\n');

    if !mandate.out_of_scope.is_empty() {
        out.push_str(
            "# Out of scope\nDeliberately excluded. Do not do these, and do not do them \
as a favour:\n",
        );
        for line in &mandate.out_of_scope {
            out.push_str(&format!("- {line}\n"));
        }
        out.push('\n');
    }

    if !mandate.first_step.trim().is_empty() {
        out.push_str("# First step\n");
        out.push_str(mandate.first_step.trim());
        out.push_str("\n\n");
    }

    out.push_str("# The request, in the user's own words\n");
    for line in request.trim().lines() {
        out.push_str(&format!("> {line}\n"));
    }
    out.push('\n');

    let answered: Vec<&CouncilQuestionDto> = questions
        .iter()
        .filter(|question| {
            question
                .answer
                .as_deref()
                .map(|answer| !answer.trim().is_empty())
                .unwrap_or(false)
        })
        .collect();
    if !answered.is_empty() {
        out.push_str("# Settled before this started\n");
        for question in answered {
            out.push_str(&format!(
                "- {}\n  {}\n",
                question.question.trim(),
                question.answer.as_deref().unwrap_or("").trim()
            ));
        }
        out.push('\n');
    }

    out.push_str(
        "When you believe every criterion is satisfied, say so plainly and stop. If one of them \
turns out to be impossible or wrong, say which and why rather than substituting something else \
for it, and do not widen the work beyond what is written above.",
    );
    out
}

/// The instructions a retake carries: what the verdict left unsettled, and
/// what it found that no criterion covered.
///
/// Rendered here rather than written by a model, and not because it is cheaper
/// (though it is free). A corrective instruction that paraphrases a verdict can
/// soften it, and the one thing a second pass must not do is arrive with a
/// gentler version of the problem than the one that was found.
pub fn render_retake(
    mandate: &MandateDto,
    verdict: &crate::domain::types::CouncilVerdictDto,
    attempt: i64,
) -> String {
    let unsettled: Vec<(usize, &crate::domain::types::CriterionVerdictDto)> = verdict
        .criteria
        .iter()
        .enumerate()
        .filter(|(_, criterion)| criterion.status != "satisfied")
        .collect();

    let mut out = format!(
        "The work you reported as finished has been read against the mandate it was given. This is pass {} of {MAX_RETAKES} allowed corrections.\n\n",
        attempt + 1
    );

    if unsettled.is_empty() {
        out.push_str("Every acceptance criterion holds. What follows is what the reading found outside them.\n\n");
    } else {
        out.push_str("# Criteria that do not hold\n");
        for (index, criterion) in &unsettled {
            out.push_str(&format!(
                "{}. {} ({})\n",
                index + 1,
                criterion.statement.trim(),
                if criterion.status == "unverifiable" {
                    "could not be verified from the work"
                } else {
                    "not satisfied"
                }
            ));
            if !criterion.evidence.trim().is_empty() {
                out.push_str(&format!(
                    "   What was read: {}\n",
                    criterion.evidence.trim()
                ));
            }
        }
        out.push_str(
            "\nAn unverifiable criterion is not a passing one. Either make it checkable the way the mandate says it is checked, or say plainly that it cannot be and why.\n\n",
        );
    }

    if !verdict.findings.is_empty() {
        out.push_str("# Found outside the criteria\n");
        for finding in &verdict.findings {
            let lens = match finding.kind.as_str() {
                "letter" => "satisfied in appearance only",
                "skipped" => "asked for and not done",
                _ => "changed without being asked",
            };
            out.push_str(&format!("- ({lens}) {}\n", finding.summary.trim()));
            if !finding.evidence.trim().is_empty() {
                out.push_str(&format!("  {}\n", finding.evidence.trim()));
            }
        }
        out.push('\n');
    }

    out.push_str("# The mandate, unchanged\n");
    out.push_str(&format!("Objective: {}\n", mandate.objective.trim()));
    if !mandate.constraints.is_empty() {
        out.push_str("Constraints still in force:\n");
        for line in &mandate.constraints {
            out.push_str(&format!("- {line}\n"));
        }
    }
    if !mandate.out_of_scope.is_empty() {
        out.push_str("Still out of scope:\n");
        for line in &mandate.out_of_scope {
            out.push_str(&format!("- {line}\n"));
        }
    }
    out.push_str(
        "\nFix what is listed above and nothing else. If one of these cannot be fixed, say which and why rather than working around it, and do not widen the work to compensate.",
    );
    out
}

/// A cycle gets two corrections. When they run out the app states what remains
/// rather than looping: a bounded cycle that reports its residue beats an
/// unbounded one that reports success.
pub const MAX_RETAKES: i64 = 2;

fn clamp_words(value: &str, max_words: usize) -> (String, bool) {
    let trimmed = value.trim();
    let words: Vec<&str> = trimmed.split_whitespace().collect();
    if words.len() <= max_words {
        return (trimmed.to_string(), false);
    }
    (words[..max_words].join(" "), true)
}

fn clamp_chars(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    trimmed.chars().take(max_chars).collect::<String>()
}

fn clamp_list(values: &[String], max: usize, noun: &str, cuts: &mut Cuts) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let line = clamp_chars(value, LINE_MAX_CHARS);
        if line.is_empty() {
            continue;
        }
        if out
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(&line))
        {
            continue;
        }
        out.push(line);
    }
    if out.len() > max {
        cuts.push(format!(
            "{} {noun}s were proposed and the last {} were dropped: a mandate holds {max}.",
            out.len(),
            out.len() - max
        ));
        out.truncate(max);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn criterion(statement: &str, verified_by: &str) -> AcceptanceCriterionDto {
        AcceptanceCriterionDto {
            statement: statement.to_string(),
            verified_by: verified_by.to_string(),
        }
    }

    fn sound() -> MandateDto {
        MandateDto {
            objective: "Cut settings page load below 300ms".to_string(),
            deliverable: vec!["src/components/settings/AppSettings.tsx".to_string()],
            constraints: vec!["No change to the settings schema".to_string()],
            acceptance: vec![criterion(
                "The settings page paints in under 300ms on a cold open",
                "performance.now() around the first render, logged",
            )],
            out_of_scope: vec!["The mobile settings list".to_string()],
            first_step: "Measure what it costs today".to_string(),
        }
    }

    #[test]
    fn a_sound_mandate_passes_untouched() {
        let (normalized, cuts) = normalize(&sound());
        assert!(cuts.is_empty());
        assert_eq!(normalized, sound());
        assert!(validate(&normalized).is_empty());
    }

    #[test]
    fn a_criterion_with_no_means_of_checking_is_dropped_and_reported() {
        let mut mandate = sound();
        mandate.acceptance.push(criterion("It looks good", "   "));
        let (normalized, cuts) = normalize(&mandate);
        assert_eq!(normalized.acceptance.len(), 1);
        assert_eq!(cuts.len(), 1, "a silent drop reads as 'it is all in there'");
        assert!(cuts[0].contains("no way of being checked"));
    }

    #[test]
    fn cuts_are_named_rather_than_silent() {
        let mut mandate = sound();
        mandate.deliverable = (0..9).map(|index| format!("file-{index}.ts")).collect();
        mandate.acceptance = (0..9)
            .map(|index| criterion(&format!("criterion {index}"), "reading the diff"))
            .collect();
        let (normalized, cuts) = normalize(&mandate);
        assert_eq!(normalized.deliverable.len(), DELIVERABLE_MAX);
        assert_eq!(normalized.acceptance.len(), ACCEPTANCE_MAX);
        assert_eq!(cuts.len(), 2);
        assert!(cuts.iter().any(|cut| cut.contains("deliverable")));
    }

    #[test]
    fn a_repeated_line_does_not_spend_two_slots() {
        let mut mandate = sound();
        mandate.constraints = vec![
            "No schema change".to_string(),
            "no schema change".to_string(),
            "  No schema change  ".to_string(),
        ];
        let (normalized, _) = normalize(&mandate);
        assert_eq!(normalized.constraints.len(), 1);
    }

    #[test]
    fn an_overlong_objective_is_cut_to_its_first_words() {
        let mut mandate = sound();
        mandate.objective = (0..50)
            .map(|i| format!("word{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        let (normalized, cuts) = normalize(&mandate);
        assert_eq!(
            normalized.objective.split_whitespace().count(),
            OBJECTIVE_MAX_WORDS
        );
        assert!(cuts.iter().any(|cut| cut.contains("objective")));
    }

    #[test]
    fn a_mandate_nothing_could_judge_is_refused() {
        let mut mandate = sound();
        mandate.acceptance.clear();
        let problems = validate(&mandate);
        assert_eq!(problems.len(), 1);
        assert!(problems[0].contains("nothing could judge it"));
    }

    #[test]
    fn rendering_is_deterministic_and_carries_every_slot() {
        let questions = vec![CouncilQuestionDto {
            id: "q1".to_string(),
            question: "Which settings page, desktop or mobile?".to_string(),
            raised_by: 2,
            answer: Some("Desktop.".to_string()),
        }];
        let first = render(&sound(), "make settings faster", &questions);
        let second = render(&sound(), "make settings faster", &questions);
        assert_eq!(first, second, "same mandate, same bytes");

        assert!(first.contains("Cut settings page load below 300ms"));
        assert!(first.contains("Verified by: performance.now()"));
        assert!(first.contains("> make settings faster"));
        assert!(first.contains("Which settings page, desktop or mobile?"));
        assert!(first.contains("Desktop."));
        assert!(first.contains("The mobile settings list"));
    }

    #[test]
    fn an_unanswered_question_never_reaches_the_agent() {
        let questions = vec![CouncilQuestionDto {
            id: "q1".to_string(),
            question: "Which page?".to_string(),
            raised_by: 2,
            answer: None,
        }];
        let rendered = render(&sound(), "go faster", &questions);
        assert!(
            !rendered.contains("Settled before this started"),
            "an unanswered question is not a settled one"
        );
    }

    fn verdict(statuses: &[&str]) -> crate::domain::types::CouncilVerdictDto {
        crate::domain::types::CouncilVerdictDto {
            mandate_id: "m1".to_string(),
            round: 0,
            status: "ready".to_string(),
            session_id: None,
            criteria: statuses
                .iter()
                .enumerate()
                .map(
                    |(index, status)| crate::domain::types::CriterionVerdictDto {
                        statement: format!("criterion {}", index + 1),
                        status: (*status).to_string(),
                        evidence: "src/x.ts:4".to_string(),
                        seat: "conformance".to_string(),
                    },
                )
                .collect(),
            findings: vec![],
            summary: None,
            prompt_version: "council-v1".to_string(),
            last_error: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn a_retake_names_only_what_did_not_hold() {
        let retake = render_retake(&sound(), &verdict(&["satisfied", "unsatisfied"]), 0);
        assert!(retake.contains("criterion 2"));
        assert!(
            !retake.contains("1. criterion 1"),
            "a criterion that holds is not reopened"
        );
        assert!(retake.contains("pass 1 of 2"));
    }

    #[test]
    fn an_unverifiable_criterion_is_reopened_as_unverifiable_not_as_failed() {
        let retake = render_retake(&sound(), &verdict(&["unverifiable"]), 1);
        assert!(retake.contains("could not be verified"));
        assert!(retake.contains("An unverifiable criterion is not a passing one"));
        assert!(retake.contains("pass 2 of 2"));
    }

    #[test]
    fn a_retake_restates_the_constraints_it_must_still_respect() {
        let retake = render_retake(&sound(), &verdict(&["unsatisfied"]), 0);
        assert!(retake.contains("No change to the settings schema"));
        assert!(retake.contains("The mobile settings list"));
    }

    #[test]
    fn a_clean_sweep_of_criteria_still_carries_what_was_found_beside_them() {
        let mut with_finding = verdict(&["satisfied"]);
        with_finding.findings = vec![crate::domain::types::VerdictFindingDto {
            kind: "collateral".to_string(),
            summary: "package.json was reformatted".to_string(),
            evidence: "git diff package.json".to_string(),
            seat: "collateral".to_string(),
        }];
        let retake = render_retake(&sound(), &with_finding, 0);
        assert!(retake.contains("Every acceptance criterion holds"));
        assert!(retake.contains("changed without being asked"));
        assert!(retake.contains("package.json was reformatted"));
    }

    #[test]
    fn empty_slots_leave_no_empty_headings() {
        let mandate = MandateDto {
            objective: "Do the thing".to_string(),
            deliverable: vec![],
            constraints: vec![],
            acceptance: vec![criterion("It is done", "reading the diff")],
            out_of_scope: vec![],
            first_step: String::new(),
        };
        let rendered = render(&mandate, "do the thing", &[]);
        assert!(!rendered.contains("# Deliverable"));
        assert!(!rendered.contains("# Constraints"));
        assert!(!rendered.contains("# Out of scope"));
        assert!(!rendered.contains("# First step"));
        assert!(rendered.contains("# Acceptance criteria"));
    }
}
