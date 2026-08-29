//! The council: deliberation that issues a verifiable mandate (ADR-0034).
//!
//! Sub Rosa reaches a whole catalog of text models and drives one capable
//! agent, and until this module the two facts did not touch: a session ran on
//! one model, chosen once, and inherited whatever that model could not see.
//!
//! A council reads a request on several model families at once, independently,
//! and turns it into a **mandate** -- capped slots whose centre is a list of
//! acceptance criteria, each naming how it is checked. One agent executes it.
//! The council then judges the finished work against that same mandate.
//!
//! Three properties are the whole design, and each is enforced somewhere here:
//!
//! - **The app owns the prompt.** Seats fill fields, [`mandate::render`] makes
//!   the string. No model is ever asked for the string itself.
//! - **The protocol is fixed.** Who speaks next is decided mechanically by
//!   [`merge`], so a sitting's bill is knowable before it is spent.
//! - **Deliberation is plural, execution is single.** No seat holds a tool. The
//!   agent writes.
//!
//! Desktop only: there is no Hermes on iOS, so there would be nothing for a
//! mandate to be handed to.
//!
//! Nothing here touches `june-api/` -- every call goes to
//! `/v1/chat/completions` through the sidecar, the seam `agent_lite`, memory
//! extraction and `longform` already use (ADR-0027).

pub mod deliberate;
pub mod evidence;
pub mod mandate;
pub mod merge;
pub mod parse;
pub mod prompts;
pub mod seat_models;
pub mod seats;
pub mod verdict;

use crate::domain::types::{AppError, CouncilMandateDto, CouncilQuestionDto, MandateDto};
use prompts::COUNCIL_PROMPT_VERSION;
use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

/// Emitted whenever a cycle changes, so the surfaces follow a sitting without
/// polling.
pub const COUNCIL_EVENT: &str = "june://council";

/// How many entries of the working folder the seats are shown. Enough to tell
/// a Rust workspace from a photo library, short of pasting a repository into
/// every prompt of every seat.
const SITUATION_MAX_ENTRIES: usize = 60;

/// Cycles being deliberated in this process right now.
///
/// A row parked in `deliberating` means one of two things -- a sitting is
/// working on it, or the process died mid-sitting -- and the row alone cannot
/// tell them apart. Same problem and same answer as `longform::ACTIVE`.
static ACTIVE: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

fn active() -> MutexGuard<'static, HashSet<String>> {
    ACTIVE.lock().unwrap_or_else(|poison| poison.into_inner())
}

pub(crate) struct SittingClaim(String);

impl SittingClaim {
    pub(crate) fn take(mandate_id: &str) -> Option<Self> {
        let mut active = active();
        if !active.insert(mandate_id.to_string()) {
            return None;
        }
        Some(Self(mandate_id.to_string()))
    }
}

impl Drop for SittingClaim {
    fn drop(&mut self) {
        active().remove(&self.0);
    }
}

pub fn is_sitting(mandate_id: &str) -> bool {
    active().contains(mandate_id)
}

pub(crate) fn emit(app: &AppHandle, cycle: &CouncilMandateDto) {
    let _ = app.emit(COUNCIL_EVENT, cycle);
}

/// Build the roster for a council against the live catalog.
///
/// `avoid_family` is what the verdict passes: a reviewer sharing weights with
/// the author shares its blind spots.
/// A roster and what is honest to say about it.
pub(crate) struct Roster {
    pub seats: Vec<crate::domain::types::CouncilSeatDto>,
    pub reused_families: Vec<String>,
    /// The user pinned two seats onto one family. See `reused_by_choice` on
    /// [`SittingPlan`].
    pub reused_by_choice: bool,
}

async fn build_roster(council_id: &str, avoid_family: Option<&str>) -> Roster {
    let templates = seats::seats_for(council_id);
    let configured = crate::providers::generation_model();
    let catalog: Vec<String> = crate::june_api::list_models("text")
        .await
        .map(|models| models.into_iter().map(|model| model.id).collect())
        .unwrap_or_default();

    // What the user fixed, seat by seat. A pin that this catalog or this
    // sitting cannot honour comes back None and the seat is filled as if it
    // had never been pinned (see `seat_models`).
    let pins = seat_models::pins();
    let pinned: Vec<Option<String>> = templates
        .iter()
        .map(|template| seat_models::pinned_model(&pins, template.id, &catalog, avoid_family))
        .collect();
    let held: Vec<String> = pinned
        .iter()
        .flatten()
        .map(|model| seats::model_family(model))
        .collect();
    let wanted = pinned.iter().filter(|model| model.is_none()).count();

    // Offline or signed out: seat everyone on the configured model. A council
    // of one family is a worse council, not a broken one, and pretending
    // otherwise would be the actual failure.
    let (assigned, _) = if catalog.is_empty() {
        (vec![configured.clone(); wanted], Vec::new())
    } else {
        seats::assign_models(
            &catalog,
            std::slice::from_ref(&configured),
            wanted,
            avoid_family,
            &held,
        )
    };

    // Weave the two back into seat order.
    let mut assigned = assigned.into_iter();
    let models: Vec<String> = pinned
        .into_iter()
        .map(|model| model.unwrap_or_else(|| assigned.next().unwrap_or_else(|| configured.clone())))
        .collect();

    // Computed from the roster that exists rather than from how it was built,
    // so a family the user doubled up on is reported exactly like one the
    // catalog could not avoid. Which of the two it was is `reused_by_choice`,
    // because the sentence shown to the user differs.
    let reused = duplicate_families(&models);
    // Two seats the user pinned onto one family is a choice. A pin that
    // collides with an automatic pick is not: that only happens when the
    // catalog had no other family left, which is the catalog's doing.
    let pinned_families: Vec<String> = held;
    let reused_by_choice = pinned_families
        .iter()
        .enumerate()
        .any(|(index, family)| pinned_families[..index].contains(family));
    Roster {
        seats: seats::roster(council_id, &models),
        reused_families: reused,
        reused_by_choice,
    }
}

/// One entry per seat beyond the first that shares a family, so an empty list
/// means every seat is on its own weights.
fn duplicate_families(models: &[String]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    let mut duplicates: Vec<String> = Vec::new();
    for model in models {
        let family = seats::model_family(model);
        if seen.contains(&family) {
            duplicates.push(family);
        } else {
            seen.push(family);
        }
    }
    duplicates
}

/// One model call a sitting would make.
///
/// `certain` splits the two ends of the estimate: the calls a sitting always
/// makes, and the ones it only makes if the council has to ask the user
/// something or answer an objection. Both ends are reachable, and a user
/// deciding whether to convene is entitled to know which they might be buying.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedCall {
    pub phase: String,
    pub seat_id: String,
    pub model: String,
    /// Estimated from the real prompt strings this sitting would send, not
    /// from a guess at their size.
    pub prompt_tokens: i64,
    /// The weakest number here: what a seat writes back varies with the
    /// request. A typical filled-in draft, and named as typical.
    pub completion_tokens: i64,
    pub certain: bool,
}

/// What a sitting will cost, before anything is spent.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SittingPlan {
    pub council_id: String,
    pub seats: Vec<crate::domain::types::CouncilSeatDto>,
    /// A council that agrees, on a request that needs no clarification.
    pub min_model_calls: i64,
    /// One that asks, and then answers an objection.
    pub max_model_calls: i64,
    /// Families held by more than one seat. Empty is the good case, and a
    /// non-empty one is shown rather than letting the roster imply a diversity
    /// it does not have.
    pub reused_families: Vec<String>,
    /// Whether that doubling up is the user's own doing: they pinned two seats
    /// onto one family. Blaming a thin catalog for a choice someone made is
    /// the kind of small lie this surface exists to avoid.
    pub reused_by_choice: bool,
    /// The ground the seats would be handed, so it can be shown before anyone
    /// commits to a sitting.
    pub situation: Option<String>,
    pub calls: Vec<PlannedCall>,
}

/// Four characters to a token. The usual rough rule, and rough is the honest
/// register for a figure shown before the work: what matters to the person
/// reading it is cents against euros, not the third decimal.
fn approx_tokens(chars: usize) -> i64 {
    chars.div_ceil(4) as i64
}

/// What a filled-in draft costs to write back. Named as typical because it is:
/// the real figure moves with the request, and this is the number in the
/// estimate that moves most.
const TYPICAL_COMPLETION_TOKENS: i64 = 900;

pub async fn plan(
    council_id: &str,
    request: &str,
    working_dir: Option<&str>,
    unrestricted: bool,
) -> SittingPlan {
    let roster = build_roster(council_id, None).await;
    let seats_of = &roster.seats;
    let situation = situation(working_dir, unrestricted).await;
    let positions: Vec<&crate::domain::types::CouncilSeatDto> = seats_of
        .iter()
        .filter(|seat| seat.role == seats::SeatRole::Position.as_str())
        .collect();
    let objection = seats_of
        .iter()
        .find(|seat| seat.role == seats::SeatRole::Objection.as_str());

    // Priced from the strings this sitting would actually send. A seat's
    // blind prompt is its instructions plus the shared contract plus the
    // request plus the ground -- all of which are known here.
    let contract_chars = prompts::BLIND_SYSTEM.len() + 1_400;
    let ground_chars = request.trim().len() + situation.as_deref().map_or(0, str::len);
    let blind_tokens = approx_tokens(contract_chars + ground_chars + 600);

    let mut calls: Vec<PlannedCall> = Vec::new();
    for seat in &positions {
        calls.push(PlannedCall {
            phase: "blind".to_string(),
            seat_id: seat.id.clone(),
            model: seat.model.clone(),
            prompt_tokens: blind_tokens,
            completion_tokens: TYPICAL_COMPLETION_TOKENS,
            certain: true,
        });
    }
    // The chair reads every draft, so its prompt carries the table.
    let chair_model = seats_of
        .first()
        .map(|seat| seat.model.clone())
        .unwrap_or_else(crate::providers::generation_model);
    let table_tokens = TYPICAL_COMPLETION_TOKENS * positions.len() as i64;
    calls.push(PlannedCall {
        phase: "chair".to_string(),
        seat_id: "chair".to_string(),
        model: chair_model.clone(),
        prompt_tokens: blind_tokens + table_tokens,
        completion_tokens: TYPICAL_COMPLETION_TOKENS,
        certain: true,
    });
    if let Some(seat) = objection {
        calls.push(PlannedCall {
            phase: "objection".to_string(),
            seat_id: seat.id.clone(),
            model: seat.model.clone(),
            prompt_tokens: approx_tokens(prompts::OBJECTION_SYSTEM.len() + 2_000) + blind_tokens,
            completion_tokens: 400,
            certain: true,
        });
    }
    // The second turn every seat may or may not take, and the chair answering
    // an objection that may or may not exist.
    for seat in &positions {
        calls.push(PlannedCall {
            phase: "second turn".to_string(),
            seat_id: seat.id.clone(),
            model: seat.model.clone(),
            prompt_tokens: blind_tokens + table_tokens,
            completion_tokens: TYPICAL_COMPLETION_TOKENS,
            certain: false,
        });
    }
    calls.push(PlannedCall {
        phase: "chair revision".to_string(),
        seat_id: "chair-revision".to_string(),
        model: chair_model,
        prompt_tokens: blind_tokens + table_tokens * 2,
        completion_tokens: TYPICAL_COMPLETION_TOKENS,
        certain: false,
    });

    let min_model_calls = calls.iter().filter(|call| call.certain).count() as i64;
    SittingPlan {
        council_id: council_id.to_string(),
        seats: roster.seats.clone(),
        min_model_calls,
        max_model_calls: calls.len() as i64,
        reused_families: roster.reused_families,
        reused_by_choice: roster.reused_by_choice,
        situation,
        calls,
    }
}

/// What the seats are told about the ground the agent will work on.
///
/// Without this, seats write mandates that ask for impossible things, and the
/// verification half of every acceptance criterion is guesswork. It is
/// deliberately a listing rather than a reading: a seat needs to know whether
/// this is a Rust workspace or a folder of photos, not what is in the files.
pub async fn situation(working_dir: Option<&str>, unrestricted: bool) -> Option<String> {
    let working_dir = working_dir?.trim();
    if working_dir.is_empty() {
        return None;
    }
    let path = std::path::Path::new(working_dir);
    let mut out = format!("Working folder: {working_dir}\n");
    out.push_str(if unrestricted {
        "Runtime mode: unrestricted. The agent can write anywhere it is pointed and run commands.\n"
    } else {
        "Runtime mode: sandboxed. The agent may only write inside the working folder.\n"
    });

    let mut entries: Vec<String> = Vec::new();
    if let Ok(mut dir) = tokio::fs::read_dir(path).await {
        while let Ok(Some(entry)) = dir.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && name != ".git" && name != ".github" {
                continue;
            }
            let is_dir = entry
                .file_type()
                .await
                .map(|kind| kind.is_dir())
                .unwrap_or(false);
            entries.push(if is_dir { format!("{name}/") } else { name });
            if entries.len() >= SITUATION_MAX_ENTRIES {
                break;
            }
        }
    }
    entries.sort();
    let is_repo = entries.iter().any(|entry| entry == ".git/");
    if entries.is_empty() {
        out.push_str("The folder is empty or could not be read.\n");
    } else {
        out.push_str(&format!("Contains: {}\n", entries.join(", ")));
    }
    if is_repo {
        out.push_str(
            "It is a git repository, so what the agent changes can be read back exactly.\n",
        );
    } else {
        out.push_str(
            "It is not a git repository, so what changed can only be told from what the agent says it touched -- prefer acceptance criteria that check a file's contents over ones that check a diff.\n",
        );
    }
    Some(out)
}

/// Convene a council on a request. Returns as soon as the row exists.
pub async fn convene(
    app: &AppHandle,
    request: &str,
    working_dir: Option<&str>,
    unrestricted: bool,
) -> Result<CouncilMandateDto, AppError> {
    let request = request.trim();
    if request.is_empty() {
        return Err(AppError::new(
            "council_empty_request",
            "There is nothing to put to the council.",
        ));
    }
    let repos = crate::commands::repositories(app).await?;
    let roster = build_roster(seats::MANDATE_COUNCIL, None).await.seats;
    let situation = situation(working_dir, unrestricted).await;
    let id = Uuid::new_v4().to_string();
    let cycle = repos
        .begin_council_mandate(
            &id,
            seats::MANDATE_COUNCIL,
            request,
            &serde_json::to_string(&roster).unwrap_or_else(|_| "[]".to_string()),
            situation.as_deref(),
            working_dir,
            COUNCIL_PROMPT_VERSION,
        )
        .await?;
    emit(app, &cycle);
    spawn_sitting(app.clone(), id);
    Ok(cycle)
}

fn spawn_sitting(app: AppHandle, mandate_id: String) {
    tauri::async_runtime::spawn(async move {
        let Some(claim) = SittingClaim::take(&mandate_id) else {
            return;
        };
        let result = deliberate::run(&app, &mandate_id).await;
        drop(claim);
        if let Err(error) = result {
            tracing::warn!(mandate = %mandate_id, code = %error.code, "a sitting failed");
            if let Ok(repos) = crate::commands::repositories(&app).await {
                if let Ok(Some(cycle)) = repos
                    .set_council_mandate_failed(&mandate_id, &error.message)
                    .await
                {
                    emit(&app, &cycle);
                }
            }
        }
    });
}

/// Re-drive sittings that were asked for and never finished. Called by
/// [`crate::background::sweep`].
pub async fn resume_unfinished(app: &AppHandle) {
    let Ok(repos) = crate::commands::repositories(app).await else {
        return;
    };
    let Ok(ids) = repos.unfinished_council_mandates().await else {
        return;
    };
    for id in ids {
        if is_sitting(&id) {
            continue;
        }
        tracing::info!(mandate = %id, "resuming an unfinished sitting");
        spawn_sitting(app.clone(), id);
    }
}

// --- Commands --------------------------------------------------------------

#[tauri::command]
pub async fn council_plan(
    council_id: Option<String>,
    request: Option<String>,
    working_dir: Option<String>,
    unrestricted: Option<bool>,
) -> Result<SittingPlan, AppError> {
    Ok(plan(
        council_id.as_deref().unwrap_or(seats::MANDATE_COUNCIL),
        request.as_deref().unwrap_or_default(),
        working_dir.as_deref(),
        unrestricted.unwrap_or(false),
    )
    .await)
}

#[tauri::command]
pub async fn council_convene(
    app: AppHandle,
    request: String,
    working_dir: Option<String>,
    unrestricted: Option<bool>,
) -> Result<CouncilMandateDto, AppError> {
    convene(
        &app,
        &request,
        working_dir.as_deref(),
        unrestricted.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn council_cycle(
    app: AppHandle,
    mandate_id: String,
) -> Result<Option<CouncilMandateDto>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    Ok(repos.council_mandate(&mandate_id).await?)
}

#[tauri::command]
pub async fn council_cycles(
    app: AppHandle,
    limit: Option<i64>,
) -> Result<Vec<CouncilMandateDto>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    Ok(repos.list_council_mandates(limit.unwrap_or(30)).await?)
}

/// What one seat said, parsed, for the surfaces to show.
///
/// The blind round is not scaffolding to be hidden once the mandate exists: it
/// is one independent answer per model family, which is exactly the
/// single-model baseline the council is measured against (ADR-0034). Showing
/// it is how a user finds out, over twenty sittings, whether the council is
/// worth its surcharge.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeatDraftDto {
    pub seat_id: String,
    pub model: String,
    /// blind | revision | contradiction
    pub phase: String,
    pub failed: bool,
    pub mandate: Option<MandateDto>,
    pub open_questions: Vec<String>,
    pub what_would_change_my_mind: String,
    pub created_at: String,
}

/// Every seat's draft for one round, in the order the phases run.
#[tauri::command]
pub async fn council_drafts(
    app: AppHandle,
    mandate_id: String,
    round: Option<i64>,
) -> Result<Vec<SeatDraftDto>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let round = round.unwrap_or(0);
    let mut out = Vec::new();
    // The objection rides along so a surface can tell "nobody attacked this
    // mandate" from "nobody had anything to say about it". Its seat can fail
    // like any other, and that failure is the one worth knowing about before
    // handing the mandate over.
    for phase in [
        deliberate::PHASE_BLIND,
        deliberate::PHASE_REVISION,
        deliberate::PHASE_CONTRADICTION,
        deliberate::PHASE_OBJECTION,
    ] {
        for turn in repos.council_turns(&mandate_id, round, phase).await? {
            let parsed = if turn.failed {
                None
            } else {
                deliberate::parse_draft(&turn.seat_id, &turn.content)
            };
            out.push(SeatDraftDto {
                seat_id: turn.seat_id,
                model: turn.model,
                phase: phase.to_string(),
                // A turn that came back unreadable is as failed as one that
                // never came back, and the surface should say so rather than
                // render an empty draft as an opinion.
                failed: turn.failed || parsed.is_none(),
                mandate: parsed.as_ref().map(|draft| draft.mandate.clone()),
                open_questions: parsed
                    .as_ref()
                    .map(|draft| draft.open_questions.clone())
                    .unwrap_or_default(),
                what_would_change_my_mind: parsed
                    .map(|draft| draft.what_would_change_my_mind)
                    .unwrap_or_default(),
                created_at: turn.created_at,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn council_cycle_for_session(
    app: AppHandle,
    session_id: String,
) -> Result<Option<CouncilMandateDto>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    Ok(repos.council_mandate_for_session(&session_id).await?)
}

/// The user's answers to the questions the seats agreed on. Puts the cycle
/// back to deliberating and wakes the sitting.
#[tauri::command]
pub async fn council_answer_questions(
    app: AppHandle,
    mandate_id: String,
    answers: Vec<CouncilQuestionDto>,
) -> Result<CouncilMandateDto, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let Some(cycle) = repos.council_mandate(&mandate_id).await? else {
        return Err(AppError::new(
            "council_gone",
            "That sitting is no longer here.",
        ));
    };
    // Answers arrive from the surface, so they are matched back onto the
    // questions the council actually asked rather than trusted wholesale: a
    // question that was never asked cannot acquire an answer.
    let merged: Vec<CouncilQuestionDto> = cycle
        .questions
        .iter()
        .map(|question| CouncilQuestionDto {
            answer: answers
                .iter()
                .find(|given| given.id == question.id)
                .and_then(|given| given.answer.clone())
                .map(|answer| answer.trim().to_string())
                .filter(|answer| !answer.is_empty()),
            ..question.clone()
        })
        .collect();
    let json = serde_json::to_string(&merged).unwrap_or_else(|_| "[]".to_string());
    let updated = repos
        .set_council_questions(&mandate_id, &json, "deliberating")
        .await?
        .ok_or_else(|| AppError::new("council_gone", "That sitting is no longer here."))?;
    emit(&app, &updated);
    spawn_sitting(app.clone(), mandate_id);
    Ok(updated)
}

/// The user's edits to the issued mandate. Re-rendered here, never accepted as
/// a string: the app owns the prompt whoever wrote the fields.
#[tauri::command]
pub async fn council_update_mandate(
    app: AppHandle,
    mandate_id: String,
    mandate: MandateDto,
) -> Result<CouncilMandateDto, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let Some(cycle) = repos.council_mandate(&mandate_id).await? else {
        return Err(AppError::new(
            "council_gone",
            "That sitting is no longer here.",
        ));
    };
    // Editing is only meaningful while the mandate is still the user's to
    // change. Once a session is executing it, the string it was handed is a
    // fact -- rewriting the row would leave the verdict judging work against a
    // mandate nobody was ever given.
    if cycle.status != "ready" {
        return Err(AppError::new(
            "council_mandate_not_editable",
            "This mandate has already been handed to the agent, so it can no longer be changed.",
        ));
    }
    let (normalized, cuts) = mandate::normalize(&mandate);
    let problems = mandate::validate(&normalized);
    if !problems.is_empty() {
        return Err(AppError::new("council_mandate_invalid", problems.join(" ")));
    }
    let rendered = mandate::render(&normalized, &cycle.request, &cycle.questions);
    let updated = repos
        .set_council_mandate_issued(
            &mandate_id,
            &serde_json::to_string(&normalized).unwrap_or_default(),
            &rendered,
            &serde_json::to_string(&cycle.dissent).unwrap_or_else(|_| "[]".to_string()),
            &serde_json::to_string(&cuts).unwrap_or_else(|_| "[]".to_string()),
        )
        .await?
        .ok_or_else(|| AppError::new("council_gone", "That sitting is no longer here."))?;
    emit(&app, &updated);
    Ok(updated)
}

/// Bind the cycle to the session that is executing it. Called once the session
/// exists, which is the moment the verdict becomes possible.
#[tauri::command]
pub async fn council_bind_session(
    app: AppHandle,
    mandate_id: String,
    session_id: String,
    working_dir: Option<String>,
    session_model: Option<String>,
) -> Result<CouncilMandateDto, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    // The folder's HEAD, captured now. A verdict that diffs against a later
    // base cannot see what this session committed, and one that diffs against
    // the wrong base looks like an answer.
    let base_commit = match working_dir.as_deref() {
        Some(dir) => evidence::head_commit(dir).await,
        None => None,
    };
    let updated = repos
        .set_council_mandate_session(
            &mandate_id,
            &session_id,
            working_dir.as_deref(),
            base_commit.as_deref(),
            session_model.as_deref(),
        )
        .await?
        .ok_or_else(|| AppError::new("council_gone", "That sitting is no longer here."))?;
    emit(&app, &updated);
    Ok(updated)
}

/// What a retake carries, and the cycle it belongs to.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Retake {
    pub cycle: CouncilMandateDto,
    /// Sent as a follow-up turn in the SAME session: it already holds the work
    /// and the reasoning that produced it, and starting a fresh one would make
    /// the agent rediscover its own tree before it could fix anything.
    pub prompt: String,
}

/// Open a corrective pass over what the last verdict left unsettled.
///
/// No model call: the instructions are rendered from the verdict itself
/// (`mandate::render_retake`). A model asked to paraphrase a verdict into a
/// correction can soften it, and a second pass arriving with a gentler version
/// of the problem is worse than no second pass.
#[tauri::command]
pub async fn council_retake(app: AppHandle, mandate_id: String) -> Result<Retake, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let Some(cycle) = repos.council_mandate(&mandate_id).await? else {
        return Err(AppError::new(
            "council_gone",
            "That cycle is no longer here.",
        ));
    };
    if cycle.round >= mandate::MAX_RETAKES {
        return Err(AppError::new(
            "council_retakes_exhausted",
            "This cycle has had both of its corrections. What is still unsatisfied is listed in the verdict, and the next move is yours.",
        ));
    }
    let Some(slots) = cycle.mandate.clone() else {
        return Err(AppError::new(
            "council_no_mandate",
            "There is no mandate to correct against.",
        ));
    };
    let Some(verdict_row) = repos.council_verdict(&mandate_id, cycle.round).await? else {
        return Err(AppError::new(
            "council_no_verdict",
            "This work has not been judged yet, so there is nothing to correct.",
        ));
    };
    let next_round = cycle.round + 1;
    let prompt = mandate::render_retake(&slots, &verdict_row, cycle.round);
    let updated = repos
        .set_council_mandate_round(&mandate_id, next_round, "executing")
        .await?
        .ok_or_else(|| AppError::new("council_gone", "That cycle is no longer here."))?;
    emit(&app, &updated);
    Ok(Retake {
        cycle: updated,
        prompt,
    })
}

/// Judge the finished work against the mandate that asked for it.
#[tauri::command]
pub async fn council_request_verdict(
    app: AppHandle,
    mandate_id: String,
    reply: Option<String>,
) -> Result<crate::domain::types::CouncilVerdictDto, AppError> {
    verdict::request(&app, &mandate_id, reply.as_deref()).await
}

#[tauri::command]
pub async fn council_verdicts(
    app: AppHandle,
    mandate_id: String,
) -> Result<Vec<crate::domain::types::CouncilVerdictDto>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    Ok(repos.council_verdicts(&mandate_id).await?)
}

/// The cycle a session is executing, if that session is one the council is
/// still waiting on. The status rule lives here rather than in the surface: a
/// caller should not have to know which statuses mean "the work is out".
#[tauri::command]
pub async fn council_cycle_awaiting_verdict(
    app: AppHandle,
    session_id: String,
) -> Result<Option<CouncilMandateDto>, AppError> {
    verdict::cycle_for_finished_session(&app, &session_id).await
}

/// Deleting the row is the cancel, and it is the only one: a sitting in flight
/// notices between movements and stands down.
#[tauri::command]
pub async fn council_forget(app: AppHandle, mandate_id: String) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    repos.delete_council_mandate(&mandate_id).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mandate_council_is_priced_through_its_second_turns() {
        // Three positions and an objection: blind + chair + objection are
        // certain, and each position's second turn plus the chair's revision
        // are the top of the range.
        let seats = seats::roster(
            seats::MANDATE_COUNCIL,
            &[
                "a-glm".to_string(),
                "b-kimi".to_string(),
                "c-qwen".to_string(),
                "d-llama".to_string(),
            ],
        );
        assert_eq!(
            seats
                .iter()
                .filter(|seat| seat.role == seats::SeatRole::Position.as_str())
                .count(),
            3
        );
    }

    #[test]
    fn the_prompt_version_travels_with_the_module() {
        // A cycle and its verdicts record it, so a retake landing after an app
        // update can be told from the pass it supersedes.
        assert!(!COUNCIL_PROMPT_VERSION.is_empty());
    }

    #[tokio::test]
    async fn a_folder_that_is_not_a_repository_says_so_to_the_seats() {
        let dir = std::env::temp_dir().join(format!("council-sit-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.expect("mkdir");
        tokio::fs::write(dir.join("notes.md"), "x")
            .await
            .expect("write");

        let situation = situation(dir.to_str(), false).await.expect("situation");
        assert!(situation.contains("notes.md"));
        assert!(situation.contains("sandboxed"));
        assert!(
            situation.contains("not a git repository"),
            "a mandate written without knowing that asks for criteria nobody can check"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[test]
    fn duplicate_families_describes_the_roster_that_exists() {
        // Computed from the final roster rather than from how it was built, so
        // a family the user doubled up on reports exactly like one the catalog
        // could not avoid. What differs is the sentence, not the count.
        let none = duplicate_families(&[
            "zai-org-glm-5-2".to_string(),
            "kimi-k2-6".to_string(),
            "deepseek-ai/deepseek-r1".to_string(),
        ]);
        assert!(none.is_empty());

        let doubled = duplicate_families(&[
            "zai-org-glm-5-2".to_string(),
            "zai-org-glm-5-1".to_string(),
            "kimi-k2-6".to_string(),
        ]);
        assert_eq!(doubled, vec!["glm".to_string()]);

        // One entry per seat beyond the first, so three seats on one family
        // reads as two seats too many rather than as one.
        let tripled = duplicate_families(&[
            "zai-org-glm-5-2".to_string(),
            "zai-org-glm-5-1".to_string(),
            "zai-org-glm-5-3".to_string(),
        ]);
        assert_eq!(tripled.len(), 2);
    }

    #[tokio::test]
    async fn no_working_folder_means_no_situation_rather_than_an_empty_one() {
        assert!(situation(None, false).await.is_none());
        assert!(situation(Some("   "), false).await.is_none());
    }

    #[tokio::test]
    async fn the_unrestricted_mode_is_stated_rather_than_implied() {
        let dir = std::env::temp_dir().join(format!("council-sit-full-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.expect("mkdir");
        let situation = situation(dir.to_str(), true).await.expect("situation");
        assert!(situation.contains("unrestricted"));
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
