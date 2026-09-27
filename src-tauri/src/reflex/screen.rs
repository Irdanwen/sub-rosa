//! A relevance screen: which of these candidates actually bear on this?
//!
//! Every search in the app ends the same way: a lexical list and a semantic
//! list, fused by rank, cut at a fixed length. The cut does not know whether
//! the eighth passage says anything about the question; it knows the passage
//! came eighth. A screen asks, once per candidate and all in one call, and
//! keeps what the answer says bears on it, best first.
//!
//! Three outcomes, and the caller reads them differently:
//!
//! - **Judged**: the kept candidates, reordered by the probability that they
//!   are relevant.
//! - **Nothing relevant**: every candidate was judged clearly beside the
//!   point. An answer over the notes can say so without paying a model to
//!   say it (and without a model inventing something from near misses).
//! - **Unjudged**: no reflex this time (off, no key, provider down). The
//!   candidates come back in the order they arrived, cut as before, so the
//!   screen is never worse than its absence.
//!
//! The model is known to be confidently wrong when the answer is not in what
//! it was given, which is why the question is always "does this passage bear
//! on the question": decidable from the text in front of it.
//!
//! The thresholds come from the first live measurements (2026-09-27, twenty
//! French passages, three questions, 60 judgements, about one second a
//! call): passages that answered scored 0.63 to 0.97, passages beside the
//! point never above 0.28, and a question nothing answered peaked at 0.20.
//! Constants until there is a calibration to replace them.

use super::question::{Batch, Question};

/// At or above: kept.
pub const KEEP_AT: f64 = 0.3;
/// Every candidate below: nothing relevant. Between the two with nothing
/// kept, the few best go through and the answering model decides.
pub const NOTHING_BELOW: f64 = 0.25;
const UNSURE_KEEP: usize = 3;
/// Characters of a candidate shown to the model.
const CANDIDATE_CHARS: usize = 1_500;
/// Questions per call.
const MAX_CANDIDATES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Judged,
    NothingRelevant,
    Unjudged,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Screened<T> {
    pub kept: Vec<T>,
    /// Candidates that were sent to be screened and not kept, in the order
    /// they arrived. Whatever left the machine is somebody's to see.
    pub examined: Vec<T>,
    pub outcome: Outcome,
}

/// Screens `candidates` (best first) against `state`, keeping at most `keep`.
///
/// `instructions` is the yes/no question, in English, about one candidate;
/// the candidate's text is appended to it.
pub async fn screen<T>(
    state: &str,
    instructions: &str,
    candidates: Vec<T>,
    text: impl Fn(&T) -> String,
    keep: usize,
) -> Screened<T> {
    if candidates.is_empty() {
        return Screened {
            kept: Vec::new(),
            examined: Vec::new(),
            outcome: Outcome::Unjudged,
        };
    }
    let mut asked = candidates.len().min(MAX_CANDIDATES);
    let batch = loop {
        let batch = build_batch(state, instructions, &candidates[..asked], &text);
        // The lowest-ranked candidates go first when the batch is too large.
        if batch.fits() || asked <= 1 {
            break batch;
        }
        asked = (asked * 3) / 4;
    };
    let (probabilities, sent) = match super::client::decide(&batch).await {
        Ok(answers) => (
            (0..asked)
                .map(|i| answers.get(&id(i)).and_then(|a| a.yes()))
                .collect::<Vec<_>>(),
            true,
        ),
        Err(error) => {
            let sent = !matches!(
                error.code.as_str(),
                "reflex_off" | "reflex_too_large" | "reflex_paused" | "reflex_no_key"
            );
            if sent {
                eprintln!("reflex screen failed: {}", error.message);
            }
            (Vec::new(), sent)
        }
    };
    select(candidates, &probabilities, asked, sent, keep)
}

fn id(i: usize) -> String {
    format!("c{i}")
}

fn build_batch<T>(
    state: &str,
    instructions: &str,
    candidates: &[T],
    text: &impl Fn(&T) -> String,
) -> Batch {
    candidates
        .iter()
        .enumerate()
        .fold(Batch::new(state), |batch, (i, candidate)| {
            let body: String = text(candidate).chars().take(CANDIDATE_CHARS).collect();
            batch.ask(
                id(i),
                Question::noul(format!("{instructions}\n\nCandidate:\n{body}")),
            )
        })
}

/// The pure half of a screen. `probabilities[i]` is the answer for
/// `candidates[i]` among the first `asked`; an empty slice means no answer at
/// all. `sent` says whether the asked candidates left the machine.
fn select<T>(
    candidates: Vec<T>,
    probabilities: &[Option<f64>],
    asked: usize,
    sent: bool,
    keep: usize,
) -> Screened<T> {
    if probabilities.is_empty() || probabilities.iter().all(Option::is_none) {
        let mut kept = candidates;
        let rest = kept.split_off(kept.len().min(keep));
        let examined = if sent {
            rest.into_iter().take(asked.saturating_sub(keep)).collect()
        } else {
            Vec::new()
        };
        return Screened {
            kept,
            examined,
            outcome: Outcome::Unjudged,
        };
    }
    // A candidate the answer skipped counts as borderline, not as rejected.
    let scored: Vec<(usize, f64)> = (0..asked)
        .map(|i| {
            (
                i,
                probabilities.get(i).copied().flatten().unwrap_or(KEEP_AT),
            )
        })
        .collect();
    let best = scored.iter().map(|(_, p)| *p).fold(0.0_f64, f64::max);
    let mut ranked = scored.clone();
    // Stable: equal probabilities keep the fused order.
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let (chosen, outcome): (Vec<usize>, Outcome) = if best < NOTHING_BELOW {
        (Vec::new(), Outcome::NothingRelevant)
    } else {
        let confident: Vec<usize> = ranked
            .iter()
            .filter(|(_, p)| *p >= KEEP_AT)
            .map(|(i, _)| *i)
            .take(keep)
            .collect();
        if confident.is_empty() {
            (
                ranked
                    .iter()
                    .map(|(i, _)| *i)
                    .take(keep.min(UNSURE_KEEP))
                    .collect(),
                Outcome::Judged,
            )
        } else {
            (confident, Outcome::Judged)
        }
    };
    let mut slots: Vec<Option<T>> = candidates.into_iter().map(Some).collect();
    let kept: Vec<T> = chosen.iter().filter_map(|&i| slots[i].take()).collect();
    let examined: Vec<T> = slots.into_iter().take(asked).flatten().collect();
    Screened {
        kept,
        examined,
        outcome,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(items: &[&'static str]) -> Vec<&'static str> {
        items.to_vec()
    }

    #[test]
    fn relevant_candidates_are_kept_best_first_and_the_rest_is_examined() {
        let candidates = names(&["a", "b", "c", "d"]);
        let p = [Some(0.2), Some(0.9), Some(0.5), Some(0.05)];
        let screened = select(candidates, &p, 4, true, 8);
        assert_eq!(screened.outcome, Outcome::Judged);
        assert_eq!(screened.kept, vec!["b", "c"]);
        assert_eq!(screened.examined, vec!["a", "d"]);
    }

    #[test]
    fn nothing_relevant_when_every_candidate_is_clearly_beside_the_point() {
        let screened = select(names(&["a", "b"]), &[Some(0.02), Some(0.08)], 2, true, 8);
        assert_eq!(screened.outcome, Outcome::NothingRelevant);
        assert!(screened.kept.is_empty());
        assert_eq!(screened.examined, vec!["a", "b"]);
    }

    #[test]
    fn unsure_answers_let_the_few_best_through() {
        let p = [Some(0.26), Some(0.29), Some(0.27), Some(0.28), Some(0.11)];
        let screened = select(names(&["a", "b", "c", "d", "e"]), &p, 5, true, 8);
        assert_eq!(screened.outcome, Outcome::Judged);
        assert_eq!(screened.kept, vec!["b", "d", "c"]);
    }

    #[test]
    fn the_measured_unanswerable_question_is_nothing_relevant() {
        // Its best passage scored 0.20 live; every answer scored 0.63 or more.
        let p = [Some(0.2), Some(0.03), Some(0.03), Some(0.02)];
        let screened = select(names(&["a", "b", "c", "d"]), &p, 4, true, 8);
        assert_eq!(screened.outcome, Outcome::NothingRelevant);
    }

    #[test]
    fn without_a_reflex_the_order_and_the_cut_are_the_old_ones() {
        let screened = select(names(&["a", "b", "c"]), &[], 3, false, 2);
        assert_eq!(screened.outcome, Outcome::Unjudged);
        assert_eq!(screened.kept, vec!["a", "b"]);
        assert!(screened.examined.is_empty(), "nothing left the machine");
        let failed = select(names(&["a", "b", "c"]), &[], 3, true, 2);
        assert_eq!(failed.examined, vec!["c"], "a failed call still sent them");
    }

    #[test]
    fn candidates_beyond_the_asked_ones_are_neither_kept_nor_examined() {
        let screened = select(names(&["a", "b", "c"]), &[Some(0.9), Some(0.1)], 2, true, 8);
        assert_eq!(screened.kept, vec!["a"]);
        assert_eq!(screened.examined, vec!["b"]);
    }

    #[test]
    fn at_most_keep_are_kept() {
        let p = [Some(0.9), Some(0.8), Some(0.7)];
        let screened = select(names(&["a", "b", "c"]), &p, 3, true, 2);
        assert_eq!(screened.kept, vec!["a", "b"]);
        assert_eq!(screened.examined, vec!["c"]);
    }
}
