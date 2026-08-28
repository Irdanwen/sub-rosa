//! The sitting: what happens between a request arriving and a mandate being
//! issued.
//!
//! The protocol is fixed, never emergent. Who speaks next is decided by the
//! chair from structured drafts, mechanically, which is the only way a bill
//! can be known before it is spent (ADR-0034).
//!
//! ```text
//! blind            3 calls, parallel, nobody sees anybody
//! questions        0 calls, intersected, at most 3, asked once
//! revision         3 calls, only when the user answered something
//!   or
//! contradiction   <=3 calls, only when the drafts actually diverge
//! chair            1 call, the synthesis
//! objection        1 call, attacks the rendered mandate
//! chair revision   1 call, only when the objection found something
//! ```
//!
//! One invariant holds the cost down and is worth stating on its own: **a seat
//! speaks at most twice.** Once blind, and at most once more -- either to
//! absorb the user's answers or to face the table, never both. A third turn is
//! where spending stops buying quality.

use crate::domain::types::{
    AcceptanceCriterionDto, AppError, CouncilMandateDto, CouncilQuestionDto, CouncilSeatDto,
    MandateDto,
};
use crate::june_api;

use super::merge::{self, DraftSummary};
use super::parse::{extract_json_object, string_field, string_list};
use super::prompts;
use super::seats::{self, SeatRole};
use super::{emit, mandate as mandate_slots};

pub const PHASE_BLIND: &str = "blind";
pub const PHASE_REVISION: &str = "revision";
pub const PHASE_CONTRADICTION: &str = "contradiction";
pub const PHASE_CHAIR: &str = "chair";
pub const PHASE_OBJECTION: &str = "objection";

/// What one seat handed back.
#[derive(Debug, Clone)]
pub struct SeatDraft {
    pub seat_id: String,
    pub mandate: MandateDto,
    pub open_questions: Vec<String>,
    pub what_would_change_my_mind: String,
}

impl SeatDraft {
    /// Objective plus every acceptance statement: what the seat is actually
    /// asking for, with none of the prose around it. This is what the chair
    /// measures agreement on.
    fn substance(&self) -> String {
        let mut text = self.mandate.objective.clone();
        for criterion in &self.mandate.acceptance {
            text.push(' ');
            text.push_str(&criterion.statement);
        }
        text
    }
}

/// Read a seat's answer. `None` means it said nothing usable, which is
/// recorded as a failed turn rather than retried into the ground.
pub fn parse_draft(seat_id: &str, raw: &str) -> Option<SeatDraft> {
    let value = extract_json_object(raw)?;
    let acceptance = value
        .get("acceptance")
        .and_then(|field| field.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let statement = string_field(item, "statement");
                    if statement.is_empty() {
                        return None;
                    }
                    Some(AcceptanceCriterionDto {
                        statement,
                        verified_by: string_field(item, "verifiedBy"),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Some(SeatDraft {
        seat_id: seat_id.to_string(),
        mandate: MandateDto {
            objective: string_field(&value, "objective"),
            deliverable: string_list(value.get("deliverable")),
            constraints: string_list(value.get("constraints")),
            acceptance,
            out_of_scope: string_list(value.get("outOfScope")),
            first_step: string_field(&value, "firstStep"),
        },
        open_questions: string_list(value.get("openQuestions")),
        what_would_change_my_mind: string_field(&value, "whatWouldChangeMyMind"),
    })
}

/// The lines the chair recorded as unresolved disagreement.
fn parse_dissent(raw: &str) -> Vec<String> {
    extract_json_object(raw)
        .map(|value| string_list(value.get("dissent")))
        .unwrap_or_default()
        .into_iter()
        .take(3)
        .collect()
}

/// The objection seat's findings, rendered for the chair to answer.
fn parse_objections(raw: &str) -> Vec<String> {
    let Some(value) = extract_json_object(raw) else {
        return Vec::new();
    };
    let Some(items) = value.get("objections").and_then(|field| field.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let problem = string_field(item, "problem");
            if problem.is_empty() {
                return None;
            }
            let slot = string_field(item, "slot");
            let fix = string_field(item, "fix");
            Some(match (slot.is_empty(), fix.is_empty()) {
                (true, true) => problem,
                (true, false) => format!("{problem} Fix: {fix}"),
                (false, true) => format!("[{slot}] {problem}"),
                (false, false) => format!("[{slot}] {problem} Fix: {fix}"),
            })
        })
        .take(4)
        .collect()
}

/// Drive one sitting to the point where it either asks the user something or
/// issues a mandate.
///
/// Every movement re-reads the row first: deleting it is the cancel, and a
/// sitting that carries on after being cancelled bills for work nobody wanted.
pub async fn run(app: &tauri::AppHandle, mandate_id: &str) -> Result<(), AppError> {
    let repos = crate::commands::repositories(app).await?;
    let Some(cycle) = repos.council_mandate(mandate_id).await? else {
        return Ok(());
    };
    let started_at = cycle.created_at.clone();
    let round = cycle.round;

    // --- Movement 1: the blind round -------------------------------------
    let positions: Vec<CouncilSeatDto> = seats::with_role(&cycle.seats, SeatRole::Position)
        .into_iter()
        .cloned()
        .collect();
    if positions.is_empty() {
        return Err(AppError::new(
            "council_no_seats",
            "This council has no seats, so there is nobody to deliberate.",
        ));
    }

    let answers = render_answers(&cycle.questions);
    let blind = run_seat_phase(
        app,
        &cycle,
        round,
        PHASE_BLIND,
        &positions,
        |_seat, seat_instructions| {
            (
                prompts::BLIND_SYSTEM.to_string(),
                prompts::blind_user_message(
                    seat_instructions,
                    &cycle.request,
                    cycle.situation.as_deref(),
                    "",
                ),
            )
        },
    )
    .await?;
    if blind.is_empty() {
        return Err(AppError::new(
            "council_no_drafts",
            "Every seat failed to answer. Nothing was issued and nothing more will be spent.",
        ));
    }
    if !still_ours(&repos, mandate_id, &started_at).await {
        return Ok(());
    }

    // --- Movement 2: the questions ----------------------------------------
    //
    // Only on the first pass, and only once. `cycle.questions` being non-empty
    // means the user has already been here.
    if cycle.questions.is_empty() {
        let summaries: Vec<DraftSummary> = blind
            .iter()
            .map(|draft| DraftSummary {
                seat_id: draft.seat_id.clone(),
                substance: draft.substance(),
                questions: draft.open_questions.clone(),
            })
            .collect();
        let questions = merge::intersect_questions(&summaries);
        if !questions.is_empty() {
            let json = serde_json::to_string(&questions).unwrap_or_else(|_| "[]".to_string());
            if let Some(updated) = repos
                .set_council_questions(mandate_id, &json, "questions")
                .await?
            {
                emit(app, &updated);
            }
            // The user is now the slow part. `answer_questions` puts the cycle
            // back to `deliberating` and calls this again.
            return Ok(());
        }
    }

    // --- Movement 3: the second turn, which is one of two ------------------
    //
    // A seat speaks at most twice. When the user answered something, that
    // second turn absorbs the answers -- drafts built on a guess are exactly
    // what the questions existed to prevent, and handing the chair a guessy
    // draft with the truth stapled to it asks it to un-guess. When there was
    // nothing to answer, the second turn faces the table instead.
    let answered = !answers.trim().is_empty();
    let working: Vec<SeatDraft> = if answered {
        let revised = run_seat_phase(
            app,
            &cycle,
            round,
            PHASE_REVISION,
            &positions,
            |_seat, seat_instructions| {
                (
                    prompts::BLIND_SYSTEM.to_string(),
                    prompts::blind_user_message(
                        seat_instructions,
                        &cycle.request,
                        cycle.situation.as_deref(),
                        &answers,
                    ),
                )
            },
        )
        .await?;
        merge_drafts(blind, revised)
    } else {
        let summaries: Vec<DraftSummary> = blind
            .iter()
            .map(|draft| DraftSummary {
                seat_id: draft.seat_id.clone(),
                substance: draft.substance(),
                questions: Vec::new(),
            })
            .collect();
        let dissenting = merge::dissenting_seats(&summaries);
        if dissenting.is_empty() {
            blind
        } else {
            let seats_to_reopen: Vec<CouncilSeatDto> = positions
                .iter()
                .filter(|seat| dissenting.contains(&seat.id))
                .cloned()
                .collect();
            let revised = run_seat_phase(
                app,
                &cycle,
                round,
                PHASE_CONTRADICTION,
                &seats_to_reopen,
                |seat, seat_instructions| {
                    // Its own draft, and the table WITHOUT it. Showing a seat
                    // its own words back as "what the others proposed" is how
                    // a contradiction round turns into agreement with itself.
                    let own = blind
                        .iter()
                        .find(|draft| draft.seat_id == seat.id)
                        .map(render_draft)
                        .unwrap_or_default();
                    let others = blind
                        .iter()
                        .filter(|draft| draft.seat_id != seat.id)
                        .map(render_draft)
                        .collect::<Vec<_>>()
                        .join("\n\n");
                    (
                        prompts::CONTRADICTION_SYSTEM.to_string(),
                        prompts::contradiction_user_message(
                            seat_instructions,
                            &cycle.request,
                            &own,
                            &others,
                        ),
                    )
                },
            )
            .await?;
            merge_drafts(blind, revised)
        }
    };
    if !still_ours(&repos, mandate_id, &started_at).await {
        return Ok(());
    }

    // --- Movement 4: the chair's synthesis ---------------------------------
    let drafts_text = render_drafts(&working);
    let chair_raw = match already_said(&repos, mandate_id, round, PHASE_CHAIR, "chair").await {
        Some(raw) => raw,
        None => {
            let raw = completion(
                &chair_model(&cycle),
                prompts::CHAIR_SYSTEM,
                &prompts::chair_user_message(
                    &cycle.request,
                    cycle.situation.as_deref(),
                    &drafts_text,
                    &answers,
                    None,
                    None,
                ),
                "council_chair_failed",
            )
            .await?;
            repos
                .record_council_turn(
                    mandate_id,
                    round,
                    PHASE_CHAIR,
                    "chair",
                    &chair_model(&cycle),
                    &raw,
                    false,
                )
                .await?;
            raw
        }
    };
    let mut synthesis = parse_draft("chair", &chair_raw).ok_or_else(|| {
        AppError::new(
            "council_chair_unreadable",
            "The chair did not return a mandate that could be read.",
        )
    })?;
    let mut dissent = parse_dissent(&chair_raw);
    if !still_ours(&repos, mandate_id, &started_at).await {
        return Ok(());
    }

    // --- Movement 5: the objection -----------------------------------------
    //
    // It attacks the rendered mandate rather than the JSON, because the
    // rendered mandate is the artefact that will actually be read.
    let objection_seat = seats::with_role(&cycle.seats, SeatRole::Objection)
        .first()
        .cloned()
        .cloned();
    let mut objections: Vec<String> = Vec::new();
    if let Some(seat) = objection_seat {
        if let Some(raw) = already_said(&repos, mandate_id, round, PHASE_OBJECTION, &seat.id).await
        {
            objections = parse_objections(&raw);
        } else {
            let (provisional, _) = mandate_slots::normalize(&synthesis.mandate);
            let rendered = mandate_slots::render(&provisional, &cycle.request, &cycle.questions);
            match completion(
                &seat.model,
                prompts::OBJECTION_SYSTEM,
                &prompts::objection_user_message(&cycle.request, &rendered),
                "council_objection_failed",
            )
            .await
            {
                Ok(raw) => {
                    repos
                        .record_council_turn(
                            mandate_id,
                            round,
                            PHASE_OBJECTION,
                            &seat.id,
                            &seat.model,
                            &raw,
                            false,
                        )
                        .await?;
                    objections = parse_objections(&raw);
                }
                // A council that loses its objection seat still issues a mandate.
                // It is worse, and the record says which seat was missing.
                Err(error) => {
                    tracing::warn!(code = %error.code, "the objection seat failed");
                    repos
                        .record_council_turn(
                            mandate_id,
                            round,
                            PHASE_OBJECTION,
                            &seat.id,
                            &seat.model,
                            "",
                            true,
                        )
                        .await?;
                }
            }
        }
    }

    // --- Movement 6: the chair answers the objection -----------------------
    if !objections.is_empty() {
        if !still_ours(&repos, mandate_id, &started_at).await {
            return Ok(());
        }
        let (provisional, _) = mandate_slots::normalize(&synthesis.mandate);
        let rendered = mandate_slots::render(&provisional, &cycle.request, &cycle.questions);
        let revised_raw =
            match already_said(&repos, mandate_id, round, PHASE_CHAIR, "chair-revision").await {
                Some(raw) => raw,
                None => {
                    let raw = completion(
                        &chair_model(&cycle),
                        prompts::CHAIR_SYSTEM,
                        &prompts::chair_user_message(
                            &cycle.request,
                            cycle.situation.as_deref(),
                            &drafts_text,
                            &answers,
                            Some(&rendered),
                            Some(&objections.join("\n")),
                        ),
                        "council_chair_failed",
                    )
                    .await?;
                    repos
                        .record_council_turn(
                            mandate_id,
                            round,
                            PHASE_CHAIR,
                            "chair-revision",
                            &chair_model(&cycle),
                            &raw,
                            false,
                        )
                        .await?;
                    raw
                }
            };
        if let Some(revised) = parse_draft("chair", &revised_raw) {
            synthesis = revised;
            let revised_dissent = parse_dissent(&revised_raw);
            if !revised_dissent.is_empty() {
                dissent = revised_dissent;
            }
        }
    }

    // --- Issue -------------------------------------------------------------
    let (final_mandate, cuts) = mandate_slots::normalize(&synthesis.mandate);
    let problems = mandate_slots::validate(&final_mandate);
    if !problems.is_empty() {
        return Err(AppError::new("council_mandate_invalid", problems.join(" ")));
    }
    let rendered = mandate_slots::render(&final_mandate, &cycle.request, &cycle.questions);
    if !still_ours(&repos, mandate_id, &started_at).await {
        return Ok(());
    }
    if let Some(updated) = repos
        .set_council_mandate_issued(
            mandate_id,
            &serde_json::to_string(&final_mandate).unwrap_or_default(),
            &rendered,
            &serde_json::to_string(&dissent).unwrap_or_else(|_| "[]".to_string()),
            &serde_json::to_string(&cuts).unwrap_or_else(|_| "[]".to_string()),
        )
        .await?
    {
        emit(app, &updated);
    }
    Ok(())
}

/// Run one phase across a set of seats, in parallel, skipping any seat whose
/// answer is already on disk.
///
/// The skip is the resume: a sitting killed at the third of four seats restarts
/// at the fourth rather than re-buying the three that landed.
async fn run_seat_phase<F>(
    app: &tauri::AppHandle,
    cycle: &CouncilMandateDto,
    round: i64,
    phase: &str,
    seats_to_run: &[CouncilSeatDto],
    build: F,
) -> Result<Vec<SeatDraft>, AppError>
where
    F: Fn(&CouncilSeatDto, &str) -> (String, String),
{
    let repos = crate::commands::repositories(app).await?;
    let existing = repos.council_turns(&cycle.id, round, phase).await?;

    let mut handles = Vec::new();
    for seat in seats_to_run {
        if existing
            .iter()
            .any(|turn| turn.seat_id == seat.id && !turn.failed)
        {
            continue;
        }
        let instructions = seats::template_for(&seat.id)
            .map(|template| template.instructions)
            .unwrap_or_default();
        let (system, user) = build(seat, instructions);
        let model = seat.model.clone();
        let seat_id = seat.id.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let result = completion(&model, &system, &user, "council_seat_failed").await;
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
                    .record_council_turn(&cycle.id, round, phase, &seat_id, &model, &raw, false)
                    .await?;
            }
            Err(error) => {
                // Recorded, not retried. A council of three that loses one seat
                // still deliberates, and the record says it did.
                tracing::warn!(seat = %seat_id, code = %error.code, "a seat failed to answer");
                repos
                    .record_council_turn(&cycle.id, round, phase, &seat_id, &model, "", true)
                    .await?;
            }
        }
        // Per seat rather than per phase: a blind round is three calls in
        // parallel and the surface should fill in as they land, not all at
        // once when the slowest one does.
        if let Some(updated) = repos.council_mandate(&cycle.id).await? {
            emit(app, &updated);
        }
    }

    let turns = repos.council_turns(&cycle.id, round, phase).await?;
    Ok(turns
        .iter()
        .filter(|turn| !turn.failed)
        .filter_map(|turn| parse_draft(&turn.seat_id, &turn.content))
        .collect())
}

/// What a single-seat movement already said, if it has already said it.
///
/// The blind round resumes because `run_seat_phase` skips seats that are on
/// disk. The chair and the objection are one call each and had no such guard,
/// so a sitting killed after the chair spoke used to buy the chair again on
/// every resume -- the exact waste the turn table exists to prevent.
async fn already_said(
    repos: &crate::db::repositories::Repositories,
    mandate_id: &str,
    round: i64,
    phase: &str,
    seat_id: &str,
) -> Option<String> {
    repos
        .council_turns(mandate_id, round, phase)
        .await
        .ok()?
        .into_iter()
        .find(|turn| turn.seat_id == seat_id && !turn.failed && !turn.content.trim().is_empty())
        .map(|turn| turn.content)
}

/// A revised draft replaces the seat's earlier one. Seats that did not speak
/// again keep the draft they had.
fn merge_drafts(base: Vec<SeatDraft>, revised: Vec<SeatDraft>) -> Vec<SeatDraft> {
    let mut out = base;
    for draft in revised {
        match out
            .iter_mut()
            .find(|existing| existing.seat_id == draft.seat_id)
        {
            Some(existing) => *existing = draft,
            None => out.push(draft),
        }
    }
    out
}

/// The chair runs on the first seat's model. It is a merge, not an opinion, so
/// which weights do it matters less than that they are one of the table's.
fn chair_model(cycle: &CouncilMandateDto) -> String {
    cycle
        .seats
        .first()
        .map(|seat| seat.model.clone())
        .unwrap_or_else(crate::providers::generation_model)
}

fn render_draft(draft: &SeatDraft) -> String {
    let mut out = format!("<draft seat=\"{}\">\n", draft.seat_id);
    out.push_str(&format!("objective: {}\n", draft.mandate.objective));
    if !draft.mandate.deliverable.is_empty() {
        out.push_str(&format!(
            "deliverable: {}\n",
            draft.mandate.deliverable.join(" | ")
        ));
    }
    if !draft.mandate.constraints.is_empty() {
        out.push_str(&format!(
            "constraints: {}\n",
            draft.mandate.constraints.join(" | ")
        ));
    }
    for criterion in &draft.mandate.acceptance {
        out.push_str(&format!(
            "acceptance: {} [verified by: {}]\n",
            criterion.statement, criterion.verified_by
        ));
    }
    if !draft.mandate.out_of_scope.is_empty() {
        out.push_str(&format!(
            "out of scope: {}\n",
            draft.mandate.out_of_scope.join(" | ")
        ));
    }
    if !draft.mandate.first_step.is_empty() {
        out.push_str(&format!("first step: {}\n", draft.mandate.first_step));
    }
    if !draft.what_would_change_my_mind.is_empty() {
        out.push_str(&format!(
            "would change its mind if: {}\n",
            draft.what_would_change_my_mind
        ));
    }
    out.push_str("</draft>");
    out
}

fn render_drafts(drafts: &[SeatDraft]) -> String {
    drafts
        .iter()
        .map(render_draft)
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn render_answers(questions: &[CouncilQuestionDto]) -> String {
    questions
        .iter()
        .filter_map(|question| {
            let answer = question.answer.as_deref()?.trim();
            if answer.is_empty() {
                return None;
            }
            Some(format!("{} -> {}", question.question.trim(), answer))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Whether the row this sitting started on is still the row on disk. Deleting
/// it is the cancel.
async fn still_ours(
    repos: &crate::db::repositories::Repositories,
    mandate_id: &str,
    started_at: &str,
) -> bool {
    match repos.council_mandate(mandate_id).await {
        Ok(Some(row)) => row.created_at == started_at,
        Ok(None) => false,
        // A database error is not a cancellation. Carrying on risks finishing
        // work nobody wanted; stopping risks dropping work they did.
        Err(_) => true,
    }
}

/// One non-streaming completion on a named model, through the sidecar -- the
/// seam `agent_lite`, memory extraction and long-form summaries all use, so
/// rail handling and cache accounting stay in one place.
pub async fn completion(
    model: &str,
    system: &str,
    user: &str,
    error_code: &str,
) -> Result<String, AppError> {
    let mut body = serde_json::json!({
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        // Low, not zero: a seat that always returns the same words is a seat
        // whose independence was bought and then thrown away.
        "temperature": 0.4,
        "max_tokens": 4000
    });
    if !model.trim().is_empty() {
        body["model"] = serde_json::Value::String(model.trim().to_string());
    }
    let response = june_api::proxy_agent_chat_completions(body).await?;
    if !(200..300).contains(&response.status) {
        return Err(AppError::new(
            error_code,
            format!("The model returned status {}.", response.status),
        ));
    }
    let bytes = response.collect_body().await?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| AppError::new(error_code, error.to_string()))?;
    june_api::extract_chat_completion_text(&value)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| AppError::new(error_code, "The model returned no text."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_draft_survives_a_fenced_answer_with_a_preamble() {
        let raw = "Thinking about it.\n```json\n{\"objective\":\"go faster\",\"deliverable\":[\"a.ts\"],\"acceptance\":[{\"statement\":\"it loads\",\"verifiedBy\":\"open it\"}],\"openQuestions\":[\"which page?\"]}\n```";
        let draft = parse_draft("shape", raw).expect("draft");
        assert_eq!(draft.mandate.objective, "go faster");
        assert_eq!(draft.mandate.acceptance[0].verified_by, "open it");
        assert_eq!(draft.open_questions, vec!["which page?"]);
    }

    #[test]
    fn a_criterion_with_no_statement_is_not_a_criterion() {
        let raw = r#"{"acceptance":[{"verifiedBy":"open it"},{"statement":"it loads","verifiedBy":"open it"}]}"#;
        let draft = parse_draft("shape", raw).expect("draft");
        assert_eq!(draft.mandate.acceptance.len(), 1);
    }

    #[test]
    fn an_unusable_answer_is_none_rather_than_an_empty_draft() {
        assert!(parse_draft("shape", "I cannot help with that.").is_none());
    }

    #[test]
    fn substance_is_the_objective_and_the_criteria_only() {
        let draft = parse_draft(
            "shape",
            r#"{"objective":"go faster","constraints":["never touch the schema"],"acceptance":[{"statement":"it loads quickly","verifiedBy":"x"}]}"#,
        )
        .expect("draft");
        let substance = draft.substance();
        assert!(substance.contains("go faster"));
        assert!(substance.contains("it loads quickly"));
        assert!(
            !substance.contains("schema"),
            "agreement is measured on what is asked for, not on the fine print"
        );
    }

    #[test]
    fn a_revised_draft_replaces_the_seats_earlier_one() {
        let base = vec![
            parse_draft("shape", r#"{"objective":"first"}"#).unwrap(),
            parse_draft("risk", r#"{"objective":"risky"}"#).unwrap(),
        ];
        let revised = vec![parse_draft("shape", r#"{"objective":"second"}"#).unwrap()];
        let merged = merge_drafts(base, revised);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].mandate.objective, "second");
        assert_eq!(merged[1].mandate.objective, "risky");
    }

    #[test]
    fn objections_read_back_with_their_slot_and_their_fix() {
        let raw = r#"{"objections":[{"slot":"acceptance","problem":"criterion 2 cannot be checked.","fix":"name the command."},{"problem":"the objective drifted."}]}"#;
        let objections = parse_objections(raw);
        assert_eq!(objections.len(), 2);
        assert!(objections[0].starts_with("[acceptance]"));
        assert!(objections[0].contains("Fix: name the command."));
        assert_eq!(objections[1], "the objective drifted.");
    }

    #[test]
    fn a_sound_mandate_draws_no_objection() {
        assert!(parse_objections(r#"{"objections":[]}"#).is_empty());
        assert!(parse_objections("The mandate is sound.").is_empty());
    }

    #[test]
    fn the_chairs_dissent_is_capped_at_three_lines() {
        let raw = r#"{"objective":"x","dissent":["a","b","c","d","e"]}"#;
        assert_eq!(parse_dissent(raw).len(), 3);
    }

    #[test]
    fn only_answered_questions_reach_a_prompt() {
        let questions = vec![
            CouncilQuestionDto {
                id: "q1".into(),
                question: "Which page?".into(),
                raised_by: 2,
                answer: Some("Settings.".into()),
            },
            CouncilQuestionDto {
                id: "q2".into(),
                question: "By when?".into(),
                raised_by: 2,
                answer: Some("   ".into()),
            },
            CouncilQuestionDto {
                id: "q3".into(),
                question: "Tests?".into(),
                raised_by: 2,
                answer: None,
            },
        ];
        let rendered = render_answers(&questions);
        assert_eq!(rendered, "Which page? -> Settings.");
    }
}
