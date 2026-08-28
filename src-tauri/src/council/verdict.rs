//! The verdict: finished work judged against the mandate that asked for it.
//!
//! The mandate is what makes this possible at all. "Did the agent do a good
//! job" has no answer; "does criterion 3 hold, and what shows it" does. That
//! is the whole reason the council issues slots rather than a prompt
//! (ADR-0034).
//!
//! Three seats read the same evidence through three lenses, because one
//! reviewer told to check conformance *and* hunt collateral damage does the
//! first and skims the second. What they say is then reconciled **without a
//! model call**:
//!
//! - A criterion marked satisfied with no evidence becomes unverifiable. An
//!   unevidenced pass is an opinion.
//! - A criterion the letter seat names as satisfied-in-appearance is
//!   downgraded to unsatisfied, whatever the conformance seat said. The letter
//!   seat returns an index and the app resolves it -- the same division of
//!   labour the chapter markers use, and for the same reason.
//!
//! One chair call writes the paragraph a person reads first. That is the only
//! model call in this file that is not a seat.

use crate::domain::types::{
    AppError, CouncilMandateDto, CouncilVerdictBody, CouncilVerdictDto, CriterionVerdictDto,
    VerdictFindingDto,
};

use super::deliberate::completion;
use super::evidence;
use super::mandate as mandate_slots;
use super::parse::{extract_json_object, string_field};
use super::prompts::{self, COUNCIL_PROMPT_VERSION};
use super::seats::{self, SeatRole};

pub const PHASE_VERDICT: &str = "verdict";

/// Open a verdict on a cycle's current round.
///
/// The row is written before any model call, so a verdict cut short by a crash
/// is something the sweep can find, and the seats that already answered are not
/// bought again.
pub async fn request(
    app: &tauri::AppHandle,
    mandate_id: &str,
) -> Result<CouncilVerdictDto, AppError> {
    let repos = crate::commands::repositories(app).await?;
    let Some(cycle) = repos.council_mandate(mandate_id).await? else {
        return Err(AppError::new(
            "council_gone",
            "That cycle is no longer here.",
        ));
    };
    if cycle.mandate.is_none() {
        return Err(AppError::new(
            "council_no_mandate",
            "There is no mandate to judge this work against.",
        ));
    }
    let row = repos
        .begin_council_verdict(
            mandate_id,
            cycle.round,
            cycle.session_id.as_deref(),
            COUNCIL_PROMPT_VERSION,
        )
        .await?;
    if let Some(updated) = repos
        .set_council_mandate_status(mandate_id, "reviewing")
        .await?
    {
        super::emit(app, &updated);
    }
    spawn(app.clone(), mandate_id.to_string(), cycle.round);
    Ok(row)
}

fn spawn(app: tauri::AppHandle, mandate_id: String, round: i64) {
    tauri::async_runtime::spawn(async move {
        let key = format!("{mandate_id}#verdict{round}");
        let Some(claim) = super::SittingClaim::take(&key) else {
            return;
        };
        let result = run(&app, &mandate_id, round).await;
        drop(claim);
        if let Err(error) = result {
            tracing::warn!(mandate = %mandate_id, code = %error.code, "a verdict failed");
            if let Ok(repos) = crate::commands::repositories(&app).await {
                let _ = repos
                    .set_council_verdict_failed(&mandate_id, round, &error.message)
                    .await;
                if let Ok(Some(cycle)) = repos
                    .set_council_mandate_status(&mandate_id, "executing")
                    .await
                {
                    super::emit(&app, &cycle);
                }
            }
        }
    });
}

pub async fn run(app: &tauri::AppHandle, mandate_id: &str, round: i64) -> Result<(), AppError> {
    let repos = crate::commands::repositories(app).await?;
    let Some(cycle) = repos.council_mandate(mandate_id).await? else {
        return Ok(());
    };
    let Some(mandate) = cycle.mandate.clone() else {
        return Err(AppError::new(
            "council_no_mandate",
            "There is no mandate to judge this work against.",
        ));
    };

    let gathered = match cycle.working_dir.as_deref() {
        Some(dir) => evidence::gather(dir, cycle.base_commit.as_deref(), &cycle.created_at).await,
        None => evidence::Evidence {
            text: String::new(),
            kind: "missing",
            truncated: false,
        },
    };

    // The roster is built here rather than at convocation, because the fact it
    // depends on -- the model the work ran on -- is not known until the work
    // has run.
    let avoid = cycle
        .session_model
        .as_deref()
        .map(seats::model_family)
        .unwrap_or_else(|| seats::model_family(&crate::providers::generation_model()));
    let (roster, reused) = super::build_roster(seats::VERDICT_COUNCIL, Some(&avoid)).await;

    let rendered = cycle
        .rendered_prompt
        .clone()
        .unwrap_or_else(|| mandate_slots::render(&mandate, &cycle.request, &cycle.questions));
    let criteria_list = render_criteria(&mandate);

    // Three seats, in parallel, each on its own lens and its own weights.
    let existing = repos
        .council_turns(mandate_id, round, PHASE_VERDICT)
        .await?;
    let mut handles = Vec::new();
    for seat in &roster {
        if existing
            .iter()
            .any(|turn| turn.seat_id == seat.id && !turn.failed)
        {
            continue;
        }
        let Some(template) = seats::template_for(&seat.id) else {
            continue;
        };
        let system = match template.role {
            SeatRole::Conformance => prompts::CONFORMANCE_SYSTEM,
            SeatRole::Collateral => prompts::COLLATERAL_SYSTEM,
            SeatRole::Letter => prompts::LETTER_SYSTEM,
            _ => continue,
        };
        let contract = if template.role == SeatRole::Conformance {
            prompts::CONFORMANCE_CONTRACT
        } else {
            prompts::FINDINGS_CONTRACT
        };
        let user = format!(
            "{}\n\n{contract}",
            prompts::verdict_user_message(
                template.instructions,
                &rendered,
                &gathered.text,
                gathered.kind,
                gathered.truncated,
                &criteria_list,
            )
        );
        let model = seat.model.clone();
        let seat_id = seat.id.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let result = completion(&model, system, &user, "council_verdict_seat_failed").await;
            (seat_id, model, result)
        }));
    }
    for handle in handles {
        let Ok((seat_id, model, result)) = handle.await else {
            continue;
        };
        match result {
            Ok(raw) => {
                repos
                    .record_council_turn(
                        mandate_id,
                        round,
                        PHASE_VERDICT,
                        &seat_id,
                        &model,
                        &raw,
                        false,
                    )
                    .await?;
            }
            Err(error) => {
                tracing::warn!(seat = %seat_id, code = %error.code, "a verdict seat failed");
                repos
                    .record_council_turn(
                        mandate_id,
                        round,
                        PHASE_VERDICT,
                        &seat_id,
                        &model,
                        "",
                        true,
                    )
                    .await?;
            }
        }
    }

    let turns = repos
        .council_turns(mandate_id, round, PHASE_VERDICT)
        .await?;
    let mut conformance: Vec<RawCriterion> = Vec::new();
    let mut findings: Vec<VerdictFindingDto> = Vec::new();
    let mut lost_seats: Vec<String> = Vec::new();
    for turn in &turns {
        if turn.failed {
            lost_seats.push(turn.seat_id.clone());
            continue;
        }
        let Some(template) = seats::template_for(&turn.seat_id) else {
            continue;
        };
        match template.role {
            SeatRole::Conformance => conformance = parse_criteria(&turn.content),
            SeatRole::Collateral => findings.extend(parse_findings(
                &turn.content,
                &turn.seat_id,
                mandate.acceptance.len(),
            )),
            SeatRole::Letter => findings.extend(parse_findings(
                &turn.content,
                &turn.seat_id,
                mandate.acceptance.len(),
            )),
            _ => {}
        }
    }

    // Empty evidence is empty evidence, whichever path produced it. A repo in
    // which nothing changed reads as "git" and shows nothing, and a seat that
    // marks a criterion satisfied against nothing has invented the pass.
    let no_evidence = gathered.text.trim().is_empty();
    let criteria = reconcile(&mandate, &conformance, &findings, no_evidence);
    let summary = write_summary(&roster, &criteria, &findings, &reused, &lost_seats).await;
    let body = CouncilVerdictBody {
        criteria,
        findings,
        summary,
    };
    if let Some(_row) = repos
        .set_council_verdict_ready(
            mandate_id,
            round,
            &serde_json::to_string(&body).unwrap_or_default(),
        )
        .await?
    {
        if let Some(cycle) = repos
            .set_council_mandate_status(mandate_id, "settled")
            .await?
        {
            super::emit(app, &cycle);
        }
    }
    Ok(())
}

/// What one seat said about one criterion, before reconciliation.
struct RawCriterion {
    index: usize,
    status: String,
    evidence: String,
}

fn render_criteria(mandate: &crate::domain::types::MandateDto) -> String {
    mandate
        .acceptance
        .iter()
        .enumerate()
        .map(|(index, criterion)| {
            format!(
                "{}. {}\n   Verified by: {}",
                index + 1,
                criterion.statement,
                criterion.verified_by
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn parse_criteria(raw: &str) -> Vec<RawCriterion> {
    let Some(value) = extract_json_object(raw) else {
        return Vec::new();
    };
    let Some(items) = value.get("criteria").and_then(|field| field.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let index = item.get("index").and_then(serde_json::Value::as_u64)? as usize;
            if index == 0 {
                return None;
            }
            Some(RawCriterion {
                index: index - 1,
                status: string_field(item, "status").to_lowercase(),
                evidence: string_field(item, "evidence"),
            })
        })
        .collect()
}

fn parse_findings(raw: &str, seat_id: &str, criteria_count: usize) -> Vec<VerdictFindingDto> {
    let Some(value) = extract_json_object(raw) else {
        return Vec::new();
    };
    let Some(items) = value.get("findings").and_then(|field| field.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let summary = string_field(item, "summary");
            if summary.is_empty() {
                return None;
            }
            // The model hands back an index and the app resolves it, clamped
            // rather than trusted: a number outside the list means "none of
            // them", never criterion seven of five.
            let criterion = item
                .get("criterion")
                .and_then(serde_json::Value::as_u64)
                .map(|value| value as usize)
                .filter(|value| *value >= 1 && *value <= criteria_count);
            Some(VerdictFindingDto {
                // The lens names the kind. The letter seat only ever produces
                // "letter"; the collateral seat produces "skipped" when it ties
                // its finding to a criterion (work asked for and not done) and
                // "collateral" when it does not (work nobody asked for).
                kind: match (seat_id, criterion) {
                    ("letter", _) => "letter".to_string(),
                    (_, Some(_)) => "skipped".to_string(),
                    _ => "collateral".to_string(),
                },
                summary: match criterion {
                    Some(index) => format!("[criterion {index}] {summary}"),
                    None => summary,
                },
                evidence: string_field(item, "evidence"),
                seat: seat_id.to_string(),
            })
        })
        .take(12)
        .collect()
}

/// Settle every criterion of the mandate, applying the two rules that are the
/// app's to enforce rather than a model's to be trusted with.
fn reconcile(
    mandate: &crate::domain::types::MandateDto,
    conformance: &[RawCriterion],
    findings: &[VerdictFindingDto],
    no_evidence: bool,
) -> Vec<CriterionVerdictDto> {
    mandate
        .acceptance
        .iter()
        .enumerate()
        .map(|(index, criterion)| {
            let judged = conformance.iter().find(|entry| entry.index == index);
            let mut status = match judged.map(|entry| entry.status.as_str()) {
                Some("satisfied") => "satisfied",
                Some("unsatisfied") => "unsatisfied",
                // Anything the seat did not answer, or answered with a word
                // that is not one of the three, is unsettled.
                _ => "unverifiable",
            };
            let evidence = judged
                .map(|entry| entry.evidence.clone())
                .unwrap_or_default();

            // An unevidenced pass is an opinion, and this council does not
            // trade in those.
            if status == "satisfied" && evidence.trim().is_empty() {
                status = "unverifiable";
            }
            // Nothing could be read at all: nothing can be satisfied.
            if no_evidence && status == "satisfied" {
                status = "unverifiable";
            }
            // The letter seat outranks the conformance seat on its own
            // question. It only ever downgrades.
            let marker = format!("[criterion {}]", index + 1);
            if status == "satisfied"
                && findings
                    .iter()
                    .any(|finding| finding.kind == "letter" && finding.summary.contains(&marker))
            {
                status = "unsatisfied";
            }

            CriterionVerdictDto {
                statement: criterion.statement.clone(),
                status: status.to_string(),
                evidence,
                seat: judged
                    .map(|_| "conformance".to_string())
                    .unwrap_or_default(),
            }
        })
        .collect()
}

/// The paragraph a person reads before the table. Best-effort: a verdict whose
/// summary failed is still a verdict, and a missing paragraph is better than a
/// failed one.
async fn write_summary(
    roster: &[crate::domain::types::CouncilSeatDto],
    criteria: &[CriterionVerdictDto],
    findings: &[VerdictFindingDto],
    reused: &[String],
    lost_seats: &[String],
) -> Option<String> {
    let model = roster.first().map(|seat| seat.model.clone())?;
    let table = criteria
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            format!(
                "{}. [{}] {} -- {}",
                index + 1,
                entry.status,
                entry.statement,
                entry.evidence
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let found = findings
        .iter()
        .map(|finding| {
            format!(
                "- ({}) {} -- {}",
                finding.kind, finding.summary, finding.evidence
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut caveats = Vec::new();
    if !reused.is_empty() {
        caveats.push(
            "Some seats had to share model weights with each other, so this reading is less independent than it should be."
                .to_string(),
        );
    }
    if !lost_seats.is_empty() {
        caveats.push(format!(
            "These seats did not answer and their lens is missing from this verdict: {}.",
            lost_seats.join(", ")
        ));
    }
    let user = format!(
        "<criteria>\n{table}\n</criteria>\n\n<findings>\n{}\n</findings>\n\n{}",
        if found.is_empty() { "(none)" } else { &found },
        caveats.join(" ")
    );
    completion(
        &model,
        prompts::VERDICT_CHAIR_SYSTEM,
        &user,
        "council_verdict_summary_failed",
    )
    .await
    .ok()
}

/// Re-drive verdicts that were opened and never finished. Called by
/// [`crate::background::sweep`].
pub async fn resume_unfinished(app: &tauri::AppHandle) {
    let Ok(repos) = crate::commands::repositories(app).await else {
        return;
    };
    let Ok(rows) = repos.unfinished_council_verdicts().await else {
        return;
    };
    for (mandate_id, round) in rows {
        if super::is_sitting(&format!("{mandate_id}#verdict{round}")) {
            continue;
        }
        tracing::info!(mandate = %mandate_id, round, "resuming an unfinished verdict");
        spawn(app.clone(), mandate_id, round);
    }
}

/// Whether a verdict found anything a retake should fix.
pub fn needs_retake(verdict: &CouncilVerdictDto) -> bool {
    verdict
        .criteria
        .iter()
        .any(|criterion| criterion.status != "satisfied")
        || !verdict.findings.is_empty()
}

/// A cycle whose session reported it was done, if there is one.
pub async fn cycle_for_finished_session(
    app: &tauri::AppHandle,
    session_id: &str,
) -> Result<Option<CouncilMandateDto>, AppError> {
    let repos = crate::commands::repositories(app).await?;
    Ok(repos
        .council_mandate_for_session(session_id)
        .await?
        .filter(|cycle| cycle.status == "executing"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::types::{AcceptanceCriterionDto, MandateDto};

    fn mandate(count: usize) -> MandateDto {
        MandateDto {
            objective: "do the thing".to_string(),
            acceptance: (0..count)
                .map(|index| AcceptanceCriterionDto {
                    statement: format!("criterion {}", index + 1),
                    verified_by: "read the diff".to_string(),
                })
                .collect(),
            ..MandateDto::default()
        }
    }

    fn raw(index: usize, status: &str, evidence: &str) -> RawCriterion {
        RawCriterion {
            index,
            status: status.to_string(),
            evidence: evidence.to_string(),
        }
    }

    fn letter_finding(criterion: usize) -> VerdictFindingDto {
        VerdictFindingDto {
            kind: "letter".to_string(),
            summary: format!("[criterion {criterion}] the test asserts nothing"),
            evidence: "src/x.test.ts:3".to_string(),
            seat: "letter".to_string(),
        }
    }

    #[test]
    fn an_unevidenced_pass_is_not_a_pass() {
        let settled = reconcile(&mandate(1), &[raw(0, "satisfied", "   ")], &[], false);
        assert_eq!(settled[0].status, "unverifiable");
    }

    #[test]
    fn an_evidenced_pass_stands() {
        let settled = reconcile(
            &mandate(1),
            &[raw(0, "satisfied", "src/x.ts:12")],
            &[],
            false,
        );
        assert_eq!(settled[0].status, "satisfied");
    }

    #[test]
    fn the_letter_seat_outranks_the_conformance_seat_on_its_own_question() {
        let settled = reconcile(
            &mandate(2),
            &[
                raw(0, "satisfied", "src/x.test.ts exists"),
                raw(1, "satisfied", "src/y.ts:4"),
            ],
            &[letter_finding(1)],
            false,
        );
        assert_eq!(settled[0].status, "unsatisfied");
        assert_eq!(
            settled[1].status, "satisfied",
            "it only touches what it named"
        );
    }

    #[test]
    fn the_letter_seat_never_upgrades() {
        let settled = reconcile(
            &mandate(1),
            &[raw(0, "unsatisfied", "nothing was written")],
            &[letter_finding(1)],
            false,
        );
        assert_eq!(settled[0].status, "unsatisfied");
    }

    #[test]
    fn a_criterion_nobody_settled_is_unverifiable_rather_than_missing() {
        let settled = reconcile(&mandate(3), &[raw(0, "satisfied", "x")], &[], false);
        assert_eq!(
            settled.len(),
            3,
            "every criterion of the mandate is answered"
        );
        assert_eq!(settled[1].status, "unverifiable");
        assert_eq!(settled[2].status, "unverifiable");
    }

    #[test]
    fn a_word_that_is_not_one_of_the_three_is_unsettled() {
        let settled = reconcile(&mandate(1), &[raw(0, "mostly fine", "x")], &[], false);
        assert_eq!(settled[0].status, "unverifiable");
    }

    #[test]
    fn a_repository_in_which_nothing_changed_satisfies_nothing() {
        // Not a missing folder: a real repo, read correctly, showing no change.
        // A criterion "satisfied" against that was invented.
        let settled = reconcile(
            &mandate(1),
            &[raw(0, "satisfied", "looks right")],
            &[],
            true,
        );
        assert_eq!(settled[0].status, "unverifiable");
    }

    #[test]
    fn nothing_readable_means_nothing_satisfied() {
        let settled = reconcile(
            &mandate(1),
            &[raw(0, "satisfied", "the agent said so")],
            &[],
            true,
        );
        assert_eq!(settled[0].status, "unverifiable");
    }

    #[test]
    fn a_findings_index_outside_the_list_is_dropped_rather_than_trusted() {
        let raw = r#"{"findings":[{"criterion":9,"summary":"a thing","evidence":"x"},{"criterion":1,"summary":"another","evidence":"y"}]}"#;
        let findings = parse_findings(raw, "collateral", 2);
        assert_eq!(findings.len(), 2);
        assert_eq!(
            findings[0].kind, "collateral",
            "criterion 9 of 2 is none of them"
        );
        assert!(!findings[0].summary.starts_with("[criterion"));
        assert!(findings[1].summary.starts_with("[criterion 1]"));
    }

    #[test]
    fn a_conformance_index_of_zero_is_refused() {
        // The seats count from one, so a zero is a model that lost the thread.
        let parsed = parse_criteria(r#"{"criteria":[{"index":0,"status":"satisfied"}]}"#);
        assert!(parsed.is_empty());
    }

    #[test]
    fn a_retake_is_needed_while_anything_is_unsettled_or_found() {
        let clean = CouncilVerdictDto {
            mandate_id: "m1".into(),
            round: 0,
            status: "ready".into(),
            session_id: None,
            criteria: vec![CriterionVerdictDto {
                statement: "x".into(),
                status: "satisfied".into(),
                evidence: "y".into(),
                seat: "conformance".into(),
            }],
            findings: vec![],
            summary: None,
            prompt_version: "council-v1".into(),
            last_error: None,
            created_at: String::new(),
            updated_at: String::new(),
        };
        assert!(!needs_retake(&clean));

        let mut unverifiable = clean.clone();
        unverifiable.criteria[0].status = "unverifiable".into();
        assert!(
            needs_retake(&unverifiable),
            "unverifiable is not satisfied, and treating it as one is how a cycle closes over a hole"
        );

        let mut with_finding = clean.clone();
        with_finding.findings = vec![letter_finding(1)];
        assert!(needs_retake(&with_finding));
    }
}
