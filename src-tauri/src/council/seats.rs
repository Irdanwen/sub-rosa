//! Who sits, and on which weights.
//!
//! The one rule that makes a council worth its cost: **two seats never run on
//! the same model family**. Three personas over one set of weights is one
//! opinion in three voices, and it agrees with itself. Diversity here is bought
//! in the catalog, not in the prompt.
//!
//! The rosters are built in and deliberately few. A settings screen offering
//! twenty councils is a settings screen nobody reads.

use crate::domain::types::CouncilSeatDto;

/// What a seat is there to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeatRole {
    /// Holds a position on what the mandate should ask for (blind round).
    Position,
    /// Never answers the request: attacks the mandate the others converged on.
    Objection,
    /// Judges the finished work criterion by criterion.
    Conformance,
    /// Hunts what no criterion covers: changes nobody asked for, work quietly
    /// skipped.
    Collateral,
    /// Hunts criteria satisfied in the letter and not in the substance.
    Letter,
}

impl SeatRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Position => "position",
            Self::Objection => "objection",
            Self::Conformance => "conformance",
            Self::Collateral => "collateral",
            Self::Letter => "letter",
        }
    }
}

/// A seat before it has been given a model.
pub struct SeatTemplate {
    pub id: &'static str,
    pub name: &'static str,
    pub role: SeatRole,
    /// One line, shown to the user. Prose, not the seat's instructions.
    pub charge: &'static str,
    /// The seat's actual instructions, appended to the phase prompt.
    pub instructions: &'static str,
}

/// The council that turns a request into a mandate.
pub const MANDATE_COUNCIL: &str = "mandate";

/// The council that judges finished work.
pub const VERDICT_COUNCIL: &str = "verdict";

/// Three positions and one objection.
///
/// Three rather than two because the question filter needs a majority to mean
/// anything: with two seats "raised by two" is unanimity, and unanimity is too
/// high a bar for "the user should be asked this".
pub const MANDATE_SEATS: &[SeatTemplate] = &[
    SeatTemplate {
        id: "shape",
        name: "Shape",
        role: SeatRole::Position,
        charge: "What is actually being asked for, and what finished looks like.",
        instructions: "Your concern is the shape of the work: what the user actually wants to exist at the end, stated so plainly that someone who has never seen the request could recognise it when it arrives. Be suspicious of restating the request back in bigger words. If the request implies a deliverable it does not name, name it.",
    },
    SeatTemplate {
        id: "risk",
        name: "Risk",
        role: SeatRole::Position,
        charge: "What breaks, and what the request quietly assumes.",
        instructions: "Your concern is what goes wrong: the assumption the request rests on without saying so, the thing that will be broken on the way, the part that looks small and is not. Your constraints and out-of-scope entries carry most of your value. Do not invent risk to have something to say -- a request with little risk should get few constraints.",
    },
    SeatTemplate {
        id: "ground",
        name: "Ground",
        role: SeatRole::Position,
        charge: "What the terrain allows, and how each criterion gets checked.",
        instructions: "Your concern is the ground: what the working folder actually contains, what the agent can actually run, and therefore what can actually be verified. You own the verification half of every acceptance criterion. A criterion nobody can check is worth nothing, so prefer a narrower criterion that can be checked over a broad one that cannot.",
    },
    SeatTemplate {
        id: "objection",
        name: "Objection",
        role: SeatRole::Objection,
        charge: "Attacks the mandate the others converged on.",
        instructions: "You do not answer the request and you never propose a mandate of your own. You are given the mandate the other seats converged on, and your only job is to find what is wrong with it: a criterion that cannot be checked the way it claims, an objective that has drifted from what was asked, a constraint that forbids the only reasonable route, a deliverable nobody could recognise as done. Say nothing when there is nothing wrong -- an objection invented to look useful costs the user a round.",
    },
];

/// The three lenses a verdict is read through. Separate seats rather than one
/// reviewer with three instructions, because a single pass told to check
/// conformance *and* look for collateral damage does the first and skims the
/// second.
pub const VERDICT_SEATS: &[SeatTemplate] = &[
    SeatTemplate {
        id: "conformance",
        name: "Conformance",
        role: SeatRole::Conformance,
        charge: "Judges every acceptance criterion, with the evidence.",
        instructions: "Take the acceptance criteria one at a time and settle each one against the evidence you were given. Quote the evidence: a path, a line, the output of a command, the passage you read. A criterion you cannot settle from the evidence is unverifiable -- say so rather than guessing, and never mark something satisfied because it is plausible that it is.",
    },
    SeatTemplate {
        id: "collateral",
        name: "Collateral",
        role: SeatRole::Collateral,
        charge: "What changed without being asked, and what was quietly skipped.",
        instructions: "You do not check the criteria -- another seat does that. You look at what the criteria do not cover: files touched that no part of the mandate called for, behaviour changed on the way past, a constraint the mandate set and the work walked through, and above all work that was reported as done and was not done. Silently skipping half a task and reporting success is the most common way an agent run fails, and it is what you are here for.",
    },
    SeatTemplate {
        id: "letter",
        name: "Letter",
        role: SeatRole::Letter,
        charge: "Criteria satisfied in the letter and not in the substance.",
        instructions: "The agent was given the acceptance criteria, so it knew what it would be judged on. Your job is the gap that opens when something is built to pass a check rather than to work: a test that asserts nothing, a value hardcoded to make an assertion true, a function that exists and returns a stub, a file created empty so that it exists. For each criterion the evidence claims is satisfied, ask what the cheapest way to make that evidence appear would have been, and whether that is what happened.",
    },
];

pub fn seats_for(council_id: &str) -> &'static [SeatTemplate] {
    match council_id {
        VERDICT_COUNCIL => VERDICT_SEATS,
        _ => MANDATE_SEATS,
    }
}

/// Vendor words that are never a model family.
///
/// `deepseek` is deliberately absent: it is a vendor *and* a family, and the
/// family is what a reader means by it.
const VENDOR_TOKENS: &[&str] = &[
    "zai",
    "org",
    "openai",
    "meta",
    "mistralai",
    "moonshotai",
    "moonshot",
    "nvidia",
    "google",
    "anthropic",
    "microsoft",
    "ai",
    "inc",
    "labs",
    "research",
    "team",
    "hf",
];

/// The family a model id belongs to.
///
/// A heuristic, and honest about it: it drops leading vendor words and takes
/// the first real token, stripped of a trailing version digit, so
/// `zai-org-glm-5-2` and `zai-org-glm-5-1` both read `glm` while `kimi-k2-6`
/// reads `kimi`. When it is wrong it errs toward *merging* two families into
/// one, which costs a seat some choice of id but can never make the roster
/// claim a diversity it does not have -- the direction that matters.
pub fn model_family(model_id: &str) -> String {
    let normalized = model_id.to_lowercase().replace(['/', '_', '.', ':'], "-");
    for token in normalized.split('-') {
        let token = token.trim();
        if token.is_empty() || VENDOR_TOKENS.contains(&token) {
            continue;
        }
        let head: String = token
            .chars()
            .take_while(|c| c.is_ascii_alphabetic())
            .collect();
        if head.len() >= 2 {
            return head;
        }
    }
    normalized
}

/// Assign one model per seat, never repeating a family while a fresh one is
/// available.
///
/// `preferred` is tried first in order (the app's configured model, then the
/// curated picks), so a two-seat council on a rich catalog lands on the models
/// the user would have chosen. `avoid_family` is what the verdict passes: a
/// reviewer sharing weights with the author shares its blind spots.
///
/// Returns one id per seat plus the families that had to be reused, which is
/// what the caller reports instead of quietly pretending the roster is diverse.
pub fn assign_models(
    catalog: &[String],
    preferred: &[String],
    seats: usize,
    avoid_family: Option<&str>,
) -> (Vec<String>, Vec<String>) {
    let mut ordered: Vec<String> = Vec::new();
    for candidate in preferred.iter().chain(catalog.iter()) {
        if !ordered.iter().any(|existing| existing == candidate) {
            ordered.push(candidate.clone());
        }
    }

    let mut chosen: Vec<String> = Vec::new();
    let mut taken_families: Vec<String> = Vec::new();
    let avoided = avoid_family.map(str::to_lowercase);

    // First pass: one model per fresh family, skipping the family the caller
    // asked us to stay away from.
    for candidate in &ordered {
        if chosen.len() == seats {
            break;
        }
        let family = model_family(candidate);
        if avoided.as_deref() == Some(family.as_str()) {
            continue;
        }
        if taken_families.contains(&family) {
            continue;
        }
        taken_families.push(family);
        chosen.push(candidate.clone());
    }

    // Second pass: the catalog ran out of families before it ran out of seats.
    // Every seat filled from here is named in `reused`, so the roster reports
    // the diversity it could not get instead of implying one it does not have.
    let mut reused: Vec<String> = Vec::new();
    if chosen.len() < seats && !ordered.is_empty() {
        // Anything off the avoided family first. Falling back to it is a last
        // resort -- a reviewer on the author's weights is worse than a
        // different one and better than none.
        let mut pool: Vec<&String> = ordered
            .iter()
            .filter(|candidate| avoided.as_deref() != Some(model_family(candidate).as_str()))
            .collect();
        if pool.is_empty() {
            pool = ordered.iter().collect();
        }
        // Ids nobody is sitting on yet come first, so two seats only share a
        // model when there is genuinely nothing else.
        pool.sort_by_key(|candidate| chosen.iter().any(|taken| &taken == candidate));
        let mut index = 0usize;
        while chosen.len() < seats {
            let candidate = pool[index % pool.len()];
            index += 1;
            reused.push(model_family(candidate));
            chosen.push(candidate.clone());
        }
    }

    (chosen, reused)
}

/// Build the frozen roster: templates plus the models they will run on.
pub fn roster(council_id: &str, models: &[String]) -> Vec<CouncilSeatDto> {
    seats_for(council_id)
        .iter()
        .enumerate()
        .map(|(index, template)| {
            let model = models
                .get(index)
                .cloned()
                .or_else(|| models.last().cloned())
                .unwrap_or_default();
            CouncilSeatDto {
                id: template.id.to_string(),
                name: template.name.to_string(),
                role: template.role.as_str().to_string(),
                charge: template.charge.to_string(),
                model_family: model_family(&model),
                model,
            }
        })
        .collect()
}

/// The seats of a roster holding one role.
pub fn with_role(seats: &[CouncilSeatDto], role: SeatRole) -> Vec<&CouncilSeatDto> {
    seats
        .iter()
        .filter(|seat| seat.role == role.as_str())
        .collect()
}

pub fn template_for(seat_id: &str) -> Option<&'static SeatTemplate> {
    MANDATE_SEATS
        .iter()
        .chain(VERDICT_SEATS.iter())
        .find(|template| template.id == seat_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families_collapse_versions_and_vendors() {
        assert_eq!(model_family("zai-org-glm-5-2"), "glm");
        assert_eq!(model_family("zai-org-glm-5-1"), "glm");
        assert_eq!(model_family("kimi-k2-6"), "kimi");
        assert_eq!(model_family("openai/gpt-oss-120b"), "gpt");
        assert_eq!(model_family("meta-llama/llama-3.1-70b"), "llama");
        assert_eq!(model_family("qwen3-235b-a22b"), "qwen");
        assert_eq!(model_family("deepseek-ai/deepseek-r1"), "deepseek");
        assert_eq!(model_family("mistralai-mistral-large"), "mistral");
        assert_eq!(model_family("nvidia/parakeet-tdt-0.6b-v3"), "parakeet");
    }

    #[test]
    fn a_rich_catalog_seats_one_family_each() {
        let catalog = vec![
            "zai-org-glm-5-2".to_string(),
            "zai-org-glm-5-1".to_string(),
            "kimi-k2-6".to_string(),
            "qwen3-235b".to_string(),
        ];
        let (models, reused) = assign_models(&catalog, &[], 3, None);
        assert_eq!(models, vec!["zai-org-glm-5-2", "kimi-k2-6", "qwen3-235b"]);
        assert!(reused.is_empty());
    }

    #[test]
    fn the_preferred_model_leads_the_roster() {
        let catalog = vec!["kimi-k2-6".to_string(), "zai-org-glm-5-2".to_string()];
        let (models, _) = assign_models(&catalog, &["zai-org-glm-5-2".to_string()], 2, None);
        assert_eq!(models[0], "zai-org-glm-5-2");
        assert_eq!(models[1], "kimi-k2-6");
    }

    #[test]
    fn a_thin_catalog_reuses_a_family_and_says_which() {
        let catalog = vec!["zai-org-glm-5-2".to_string(), "zai-org-glm-5-1".to_string()];
        let (models, reused) = assign_models(&catalog, &[], 3, None);
        assert_eq!(models.len(), 3);
        assert_eq!(
            reused.len(),
            2,
            "the roster must be able to report what it could not get"
        );
        assert!(reused.iter().all(|family| family == "glm"));
    }

    #[test]
    fn the_verdict_stays_off_the_authors_weights() {
        let catalog = vec![
            "zai-org-glm-5-2".to_string(),
            "kimi-k2-6".to_string(),
            "qwen3-235b".to_string(),
            "deepseek-r1".to_string(),
        ];
        let (models, reused) = assign_models(&catalog, &[], 3, Some("glm"));
        assert!(reused.is_empty());
        assert!(
            models.iter().all(|model| model_family(model) != "glm"),
            "a reviewer sharing weights with the author shares its blind spots"
        );
    }

    #[test]
    fn a_single_model_catalog_still_seats_the_verdict() {
        // One family, and it is the author's. A reviewer on the same weights is
        // worse than a different one and better than none -- and the roster
        // records the reuse, so the verdict can say so.
        let catalog = vec!["zai-org-glm-5-2".to_string()];
        let (models, reused) = assign_models(&catalog, &[], 3, Some("glm"));
        assert_eq!(models.len(), 3);
        assert_eq!(reused.len(), 3);
    }

    #[test]
    fn an_empty_catalog_seats_nobody_rather_than_inventing_a_model() {
        let (models, reused) = assign_models(&[], &[], 3, None);
        assert!(models.is_empty());
        assert!(reused.is_empty());
    }

    #[test]
    fn the_roster_records_the_family_each_seat_landed_on() {
        let seats = roster(
            MANDATE_COUNCIL,
            &[
                "zai-org-glm-5-2".to_string(),
                "kimi-k2-6".to_string(),
                "qwen3-235b".to_string(),
                "deepseek-r1".to_string(),
            ],
        );
        assert_eq!(seats.len(), 4);
        assert_eq!(seats[0].model_family, "glm");
        assert_eq!(seats[3].role, "objection");
        assert_eq!(with_role(&seats, SeatRole::Position).len(), 3);
    }
}
