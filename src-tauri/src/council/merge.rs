//! What the chair decides without spending a model call.
//!
//! Two decisions in a sitting are routing decisions, and routing decisions are
//! the ones you must not buy from a model: which questions reach the user, and
//! who speaks in the contradiction round. Both are computed here, from the
//! structured drafts the blind round returned.
//!
//! The measure throughout is token-set overlap (Jaccard) over content words.
//! It is crude and it is the right kind of crude: it cannot be argued with, it
//! costs nothing, and it is the same answer every time -- which is what makes
//! a sitting reproducible and its bill predictable.

use crate::domain::types::CouncilQuestionDto;
use std::collections::BTreeSet;

/// Two questions this alike are the same question asked twice.
///
/// Tuned low on purpose. A false merge costs the user one question they might
/// have wanted to answer separately; a false split lets one seat's phrasing
/// count as two seats agreeing, which would put an idiosyncrasy in front of
/// the user as though it were an ambiguity.
const QUESTION_SIMILARITY: f64 = 0.45;

/// One question wholly inside another this far is the same question, however
/// different their lengths.
///
/// Overlap alone would not catch it: "Which page?" and "Could you tell us
/// which page exactly you mean here?" share both their content words and score
/// 0.29 on Jaccard, because Jaccard punishes the longer phrasing for being
/// longer. Containment is what reads them as one -- which is the common case,
/// since one seat asks tersely and another asks politely.
const QUESTION_CONTAINMENT: f64 = 0.7;

/// Containment only applies from two content words up. A one-word question
/// ("Tests?") is inside half the sentences in any draft, and merging on it
/// would let one seat's aside ride in on another seat's real question.
const CONTAINMENT_MIN_TOKENS: usize = 2;

/// How many seats must raise a question independently before it is put to the
/// user. Two, out of three positions: one is that seat's idiosyncrasy.
pub const QUESTION_QUORUM: usize = 2;

/// At most this many questions reach the user, once. A council that asks four
/// is a form, and nobody fills in a form to start a task.
pub const MAX_QUESTIONS: usize = 3;

/// Below this mean agreement with the rest of the table, a seat is holding a
/// different view and is worth a second round.
///
/// A tuning knob, and the direction of error is deliberate: too high spends
/// calls reopening agreement, too low ships an unresolved disagreement inside
/// a mandate. Shipping the disagreement is the worse failure, so this sits on
/// the generous side.
const AGREEMENT_FLOOR: f64 = 0.5;

/// Never more than this many seats speak twice, whatever the spread.
pub const MAX_DISSENTERS: usize = 3;

/// One seat's blind-round draft, reduced to what routing needs.
pub struct DraftSummary {
    pub seat_id: String,
    /// Objective plus every acceptance statement: what the seat is actually
    /// asking for, without the prose around it.
    pub substance: String,
    pub questions: Vec<String>,
}

/// Content words, lowercased. Short words and the commonest glue in both
/// languages the app is used in are dropped, because they are shared by every
/// sentence and would make everything look alike.
pub fn tokenize(text: &str) -> BTreeSet<String> {
    const STOPWORDS: &[&str] = &[
        "the", "and", "for", "with", "that", "this", "from", "into", "must", "should", "will",
        "are", "was", "were", "has", "have", "not", "but", "its", "our", "your", "les", "des",
        "une", "uns", "pour", "dans", "avec", "que", "qui", "sur", "par", "aux", "est", "sont",
        "pas", "son", "ses", "leur", "leurs", "cette", "ces", "plus", "tout", "tous", "faire",
        "etre", "avoir",
    ];
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|token| token.chars().count() >= 3)
        .filter(|token| !STOPWORDS.contains(token))
        .map(str::to_string)
        .collect()
}

/// How much of the smaller set the two share. Blind to length, where Jaccard
/// is not.
pub fn containment(left: &BTreeSet<String>, right: &BTreeSet<String>) -> f64 {
    let smaller = left.len().min(right.len());
    if smaller == 0 {
        return 0.0;
    }
    left.intersection(right).count() as f64 / smaller as f64
}

/// Whether two questions are the same question.
fn same_question(left: &BTreeSet<String>, right: &BTreeSet<String>) -> bool {
    if jaccard(left, right) >= QUESTION_SIMILARITY {
        return true;
    }
    left.len().min(right.len()) >= CONTAINMENT_MIN_TOKENS
        && containment(left, right) >= QUESTION_CONTAINMENT
}

pub fn jaccard(left: &BTreeSet<String>, right: &BTreeSet<String>) -> f64 {
    if left.is_empty() && right.is_empty() {
        return 1.0;
    }
    let intersection = left.intersection(right).count() as f64;
    let union = left.union(right).count() as f64;
    if union == 0.0 {
        return 0.0;
    }
    intersection / union
}

/// The questions several seats reached independently, ready to put to the user.
///
/// This is the whole reason a multi-seat structure *reduces* the number of
/// questions instead of multiplying it: three agents each asking their three
/// would be nine, and what survives here is the two or three that more than one
/// of them could not proceed without.
pub fn intersect_questions(drafts: &[DraftSummary]) -> Vec<CouncilQuestionDto> {
    struct Cluster {
        tokens: BTreeSet<String>,
        seats: BTreeSet<String>,
        /// Every phrasing seen, so the clearest can represent the cluster.
        phrasings: Vec<String>,
        /// Where this cluster first appeared, so ties break deterministically.
        rank: usize,
    }

    let mut clusters: Vec<Cluster> = Vec::new();
    let mut rank = 0usize;
    for draft in drafts {
        for question in &draft.questions {
            let text = question.trim();
            if text.is_empty() {
                continue;
            }
            let tokens = tokenize(text);
            let existing = clusters
                .iter_mut()
                .find(|cluster| same_question(&cluster.tokens, &tokens));
            match existing {
                Some(cluster) => {
                    cluster.seats.insert(draft.seat_id.clone());
                    cluster.phrasings.push(text.to_string());
                }
                None => {
                    clusters.push(Cluster {
                        tokens,
                        seats: BTreeSet::from([draft.seat_id.clone()]),
                        phrasings: vec![text.to_string()],
                        rank,
                    });
                    rank += 1;
                }
            }
        }
    }

    let mut qualified: Vec<&Cluster> = clusters
        .iter()
        .filter(|cluster| cluster.seats.len() >= QUESTION_QUORUM)
        .collect();
    // Most-raised first, then in the order they were first raised: a stable
    // order matters because the user sees at most three of them.
    qualified.sort_by(|left, right| {
        right
            .seats
            .len()
            .cmp(&left.seats.len())
            .then(left.rank.cmp(&right.rank))
    });

    qualified
        .into_iter()
        .take(MAX_QUESTIONS)
        .enumerate()
        .map(|(index, cluster)| CouncilQuestionDto {
            id: format!("q{}", index + 1),
            // The shortest phrasing, which is nearly always the plainest.
            question: cluster
                .phrasings
                .iter()
                .min_by_key(|phrasing| phrasing.chars().count())
                .cloned()
                .unwrap_or_default(),
            raised_by: cluster.seats.len() as i64,
            answer: None,
        })
        .collect()
}

/// The seats whose draft stands apart from the table, worth a second round.
///
/// Empty means the council agreed, and an agreeing council costs one round
/// rather than two. That is not a shortcut: there is nothing for a
/// contradiction round to contradict.
pub fn dissenting_seats(drafts: &[DraftSummary]) -> Vec<String> {
    if drafts.len() < 2 {
        return Vec::new();
    }
    let tokens: Vec<BTreeSet<String>> = drafts
        .iter()
        .map(|draft| tokenize(&draft.substance))
        .collect();

    let mut scored: Vec<(String, f64)> = Vec::new();
    for (index, draft) in drafts.iter().enumerate() {
        let mut total = 0.0;
        for (other, other_tokens) in tokens.iter().enumerate() {
            if other == index {
                continue;
            }
            total += jaccard(&tokens[index], other_tokens);
        }
        let mean = total / (drafts.len() - 1) as f64;
        if mean < AGREEMENT_FLOOR {
            scored.push((draft.seat_id.clone(), mean));
        }
    }
    // Furthest from the table first: if the cap bites, it should bite on the
    // seats that agree most.
    scored.sort_by(|left, right| {
        left.1
            .partial_cmp(&right.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored
        .into_iter()
        .take(MAX_DISSENTERS)
        .map(|(seat_id, _)| seat_id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(seat: &str, substance: &str, questions: &[&str]) -> DraftSummary {
        DraftSummary {
            seat_id: seat.to_string(),
            substance: substance.to_string(),
            questions: questions.iter().map(|q| q.to_string()).collect(),
        }
    }

    #[test]
    fn a_question_only_one_seat_raised_never_reaches_the_user() {
        let drafts = vec![
            draft("shape", "make the page faster", &["Which page is slow?"]),
            draft(
                "risk",
                "make the page faster",
                &["Do you have analytics set up?"],
            ),
            draft("ground", "make the page faster", &[]),
        ];
        assert!(
            intersect_questions(&drafts).is_empty(),
            "one seat asking is that seat's idiosyncrasy"
        );
    }

    #[test]
    fn the_same_question_asked_twice_in_different_words_reaches_the_user_once() {
        let drafts = vec![
            draft("shape", "x", &["Which page is slow, settings or notes?"]),
            draft("risk", "x", &["Which page is slow -- settings, or notes?"]),
            draft("ground", "x", &[]),
        ];
        let questions = intersect_questions(&drafts);
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].raised_by, 2);
    }

    #[test]
    fn the_clearest_phrasing_represents_its_cluster() {
        let drafts = vec![
            draft("shape", "x", &["Which page?"]),
            draft(
                "risk",
                "x",
                &["Could you tell us which page exactly you mean here?"],
            ),
        ];
        let questions = intersect_questions(&drafts);
        assert_eq!(questions[0].question, "Which page?");
    }

    #[test]
    fn at_most_three_questions_reach_the_user() {
        let shared = [
            "Which page is slow?",
            "What browser do you target?",
            "Is there a deadline for this?",
            "Should the mobile app change too?",
            "Do you want tests written?",
        ];
        let drafts = vec![
            draft("shape", "x", &shared),
            draft("risk", "x", &shared),
            draft("ground", "x", &shared),
        ];
        let questions = intersect_questions(&drafts);
        assert_eq!(questions.len(), MAX_QUESTIONS);
        assert!(questions.iter().all(|question| question.raised_by == 3));
        // Ids are positional and stable, so the answers come back to the right
        // question.
        assert_eq!(questions[0].id, "q1");
        assert_eq!(questions[2].id, "q3");
    }

    #[test]
    fn an_agreeing_council_costs_one_round() {
        let drafts = vec![
            draft(
                "shape",
                "cut settings page load below three hundred milliseconds",
                &[],
            ),
            draft(
                "risk",
                "cut settings page load below three hundred milliseconds",
                &[],
            ),
            draft(
                "ground",
                "cut settings page load below three hundred milliseconds",
                &[],
            ),
        ];
        assert!(dissenting_seats(&drafts).is_empty());
    }

    #[test]
    fn the_seat_holding_a_different_view_is_the_one_that_speaks_again() {
        let drafts = vec![
            draft(
                "shape",
                "cut settings page load below three hundred milliseconds",
                &[],
            ),
            draft(
                "risk",
                "cut settings page load below three hundred milliseconds",
                &[],
            ),
            draft(
                "ground",
                "rewrite the entire preferences subsystem in rust with a new schema",
                &[],
            ),
        ];
        assert_eq!(dissenting_seats(&drafts), vec!["ground".to_string()]);
    }

    #[test]
    fn total_disagreement_is_capped_rather_than_unbounded() {
        let drafts = vec![
            draft("a", "alpha beta gamma delta", &[]),
            draft("b", "epsilon zeta eta theta", &[]),
            draft("c", "iota kappa lambda mu", &[]),
            draft("d", "nu xi omicron pi", &[]),
            draft("e", "rho sigma tau upsilon", &[]),
        ];
        assert_eq!(dissenting_seats(&drafts).len(), MAX_DISSENTERS);
    }

    #[test]
    fn a_lone_seat_has_nobody_to_disagree_with() {
        assert!(dissenting_seats(&[draft("shape", "anything", &[])]).is_empty());
    }

    #[test]
    fn a_one_word_question_does_not_ride_in_on_another() {
        // "Tests?" is inside almost any sentence mentioning tests. If
        // containment applied to it, one seat's aside would be counted as two
        // seats raising an ambiguity.
        let drafts = vec![
            draft("shape", "x", &["Tests?"]),
            draft(
                "risk",
                "x",
                &["Should the tests cover the migration path as well?"],
            ),
        ];
        assert!(intersect_questions(&drafts).is_empty());
    }

    #[test]
    fn glue_words_do_not_make_two_sentences_look_alike() {
        let left = tokenize("the work must be done with the tests that are in the repository");
        let right = tokenize("the work must not be done with the tests that are in the folder");
        assert!(
            jaccard(&left, &right) < 0.9,
            "stopwords would otherwise drown the two words that differ"
        );
    }
}
