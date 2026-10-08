//! A new fact, set against what is already remembered (ADR-0065).
//!
//! Extraction used to add every candidate that did not match a stored memory
//! letter for letter. "Habite à Lyon" sat next to "Habite à Paris", and the
//! same preference said twice in other words was stored twice. A reflex now
//! reads each candidate next to its closest stored facts and answers two
//! questions in one call: is it new, the same, or a replacement, and which
//! stored fact does it concern. When both answers clear [`ACT_AT`], the app
//! acts on its own: a replacement rewrites the stored memory in place (so the
//! change syncs as an ordinary revision), a repeat is not stored, and the
//! journal records either with its undo. Anything less sure is added, as
//! before, because a duplicate costs less than a lost fact.

use std::collections::{BTreeMap, HashSet};

use crate::db::repositories::Repositories;
use crate::domain::types::MemoryDto;
use crate::reflex::question::{Answer, Batch, Question};

/// Both answers at or above this, and the app acts without asking. Higher
/// than the relevance screen's bar: this one changes what is remembered.
pub const ACT_AT: f64 = 0.8;
/// Stored facts shown next to each candidate.
const NEIGHBOURS: usize = 4;
/// Characters of a stored fact used as a choice label.
const LABEL_CHARS: usize = 160;
const NONE_LABEL: &str = "none of the stored facts";

#[derive(Debug, Clone)]
pub enum Verdict {
    Add,
    /// Already remembered as `existing`.
    Same {
        existing: MemoryDto,
        p: f64,
    },
    /// Replaces or corrects `existing`.
    Update {
        existing: MemoryDto,
        p: f64,
    },
}

/// The stored facts closest to each candidate: by meaning when vectors are
/// available, and by any shared word, enabled memories only.
pub async fn neighbours(repos: &Repositories, candidates: &[String]) -> Vec<Vec<MemoryDto>> {
    let vectors = super::recall::embed(candidates).await.unwrap_or_default();
    let stored = if vectors.len() == candidates.len() {
        repos.memories_with_embeddings().await.unwrap_or_default()
    } else {
        Vec::new()
    };
    let mut out = Vec::with_capacity(candidates.len());
    for (i, candidate) in candidates.iter().enumerate() {
        let mut found: Vec<MemoryDto> = Vec::new();
        if let Some(vector) = vectors.get(i) {
            let mut scored: Vec<(f32, &MemoryDto)> = stored
                .iter()
                .filter_map(|row| {
                    let embedding = super::recall::decode_embedding(row.embedding.as_deref()?);
                    Some((
                        super::recall::cosine_similarity(vector, &embedding)?,
                        &row.memory,
                    ))
                })
                .collect();
            scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            found.extend(
                scored
                    .into_iter()
                    .take(NEIGHBOURS)
                    .map(|(_, memory)| memory.clone()),
            );
        }
        if let Some(fts) = crate::ask::passages_match(&crate::ask::content_terms(candidate)) {
            for memory in repos
                .search_memories_fts(&fts, NEIGHBOURS as i64)
                .await
                .unwrap_or_default()
            {
                if !found.iter().any(|m| m.id == memory.id) {
                    found.push(memory);
                }
            }
        }
        found.truncate(NEIGHBOURS + 2);
        out.push(found);
    }
    out
}

fn label(memory: &MemoryDto) -> String {
    let text: String = memory.text.trim().chars().take(LABEL_CHARS).collect();
    text
}

/// One call for the whole pass: every neighbour listed in the state, two
/// questions per candidate that has any. The stored fact's own words are
/// its label, since the model follows an option's name more than its
/// description.
pub fn build_batch(candidates: &[String], neighbours: &[Vec<MemoryDto>]) -> Batch {
    let mut listed = HashSet::new();
    let mut state = String::from("Facts already remembered about the person:\n");
    for memory in neighbours.iter().flatten() {
        if listed.insert(memory.id.clone()) {
            state.push_str(&format!("- {}\n", memory.text.trim()));
        }
    }
    let mut batch = Batch::new(state);
    for (i, candidate) in candidates.iter().enumerate() {
        let Some(near) = neighbours.get(i).filter(|near| !near.is_empty()) else {
            continue;
        };
        batch = batch.ask(
            format!("op{i}"),
            Question::Choice {
                instructions: format!(
                    "A new fact about the person was just learned: \"{}\". Compared with the facts \
                     already remembered in the state, what is it?",
                    candidate.trim()
                ),
                options: vec![
                    (
                        "new".into(),
                        "It says something none of the remembered facts says.".into(),
                    ),
                    (
                        "same".into(),
                        "A remembered fact already says it, in the same or other words.".into(),
                    ),
                    (
                        "replacement".into(),
                        "It replaces, corrects or contradicts a remembered fact: something \
                         changed, or the remembered fact was wrong."
                            .into(),
                    ),
                ],
            },
        );
        let mut options: Vec<(String, String)> = Vec::new();
        for memory in near {
            let name = label(memory);
            if !options.iter().any(|(l, _)| *l == name) {
                options.push((name, "This remembered fact.".into()));
            }
        }
        options.push((
            NONE_LABEL.into(),
            "The new fact neither repeats nor replaces any remembered fact.".into(),
        ));
        batch = batch.ask(
            format!("to{i}"),
            Question::Choice {
                instructions: format!(
                    "The new fact is: \"{}\". Which remembered fact does it repeat, replace or \
                     correct?",
                    candidate.trim()
                ),
                options,
            },
        );
    }
    batch
}

fn chosen(answer: Option<&Answer>) -> Option<(&str, f64)> {
    match answer? {
        Answer::Choice {
            choice,
            probabilities,
            ..
        } => Some((
            choice.as_str(),
            probabilities.get(choice).copied().unwrap_or(0.0),
        )),
        _ => None,
    }
}

/// Reads the answers into one verdict per candidate. A stored memory is
/// touched once per pass at most: a second candidate aimed at it is added.
pub fn decide(
    candidates: &[String],
    neighbours: &[Vec<MemoryDto>],
    answers: &BTreeMap<String, Answer>,
) -> Vec<Verdict> {
    let mut touched = HashSet::new();
    (0..candidates.len())
        .map(|i| {
            let (Some((op, p_op)), Some((target, p_target))) = (
                chosen(answers.get(&format!("op{i}"))),
                chosen(answers.get(&format!("to{i}"))),
            ) else {
                return Verdict::Add;
            };
            if p_op < ACT_AT || p_target < ACT_AT || target == NONE_LABEL {
                return Verdict::Add;
            }
            let Some(existing) = neighbours
                .get(i)
                .and_then(|near| near.iter().find(|m| label(m) == target))
            else {
                return Verdict::Add;
            };
            if !touched.insert(existing.id.clone()) {
                return Verdict::Add;
            }
            let p = p_op.min(p_target);
            match op {
                "same" => Verdict::Same {
                    existing: existing.clone(),
                    p,
                },
                "replacement" => Verdict::Update {
                    existing: existing.clone(),
                    p,
                },
                _ => Verdict::Add,
            }
        })
        .collect()
}

/// A verdict per candidate; all `Add` when no reflex answers.
pub async fn judge(repos: &Repositories, candidates: &[String]) -> Vec<Verdict> {
    let adds = || vec![Verdict::Add; candidates.len()];
    if candidates.is_empty() || !crate::reflex::settings().enabled {
        return adds();
    }
    let near = neighbours(repos, candidates).await;
    let batch = build_batch(candidates, &near);
    if batch.is_empty() {
        return adds();
    }
    match crate::egress_ledger::scoped("memory", None, crate::reflex::client::decide(&batch)).await
    {
        Ok(answers) => decide(candidates, &near, &answers),
        Err(error) => {
            eprintln!("memory consolidation reflex failed: {}", error.message);
            adds()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::types::MemorySource;

    fn memory(id: &str, text: &str) -> MemoryDto {
        MemoryDto {
            id: id.into(),
            text: text.into(),
            source: MemorySource::Auto,
            importance: 3,
            disabled: false,
            has_embedding: true,
            created_at: String::new(),
            updated_at: String::new(),
            scope: None,
        }
    }

    fn choice(choice: &str, p: f64) -> Answer {
        Answer::Choice {
            choice: choice.into(),
            probabilities: BTreeMap::from([(choice.to_string(), p)]),
            confidence: p,
        }
    }

    #[test]
    fn the_batch_names_stored_facts_by_their_words_and_skips_lonely_candidates() {
        let candidates = vec!["Habite à Lyon.".to_string(), "Joue du piano.".to_string()];
        let near = vec![vec![memory("m1", "Habite à Paris.")], vec![]];
        let batch = build_batch(&candidates, &near);
        let body = batch.to_body("jev-latest").unwrap();
        assert!(body["state"]
            .as_str()
            .unwrap()
            .contains("- Habite à Paris."));
        let to0 = &body["questions"]["to0"]["criteria"];
        assert!(to0.get("Habite à Paris.").is_some());
        assert!(to0.get(NONE_LABEL).is_some());
        assert!(
            body["questions"].get("op1").is_none(),
            "nothing to compare with"
        );
        assert_eq!(
            body["questions"]["op0"]["criteria"]
                .as_object()
                .unwrap()
                .len(),
            3
        );
    }

    #[test]
    fn a_sure_replacement_updates_and_a_sure_repeat_is_left_out() {
        let candidates = vec![
            "Habite à Lyon.".to_string(),
            "Aime le café noir.".to_string(),
        ];
        let near = vec![
            vec![memory("m1", "Habite à Paris.")],
            vec![memory("m2", "Boit son café sans sucre ni lait.")],
        ];
        let answers = BTreeMap::from([
            ("op0".to_string(), choice("replacement", 0.97)),
            ("to0".to_string(), choice("Habite à Paris.", 0.95)),
            ("op1".to_string(), choice("same", 0.9)),
            (
                "to1".to_string(),
                choice("Boit son café sans sucre ni lait.", 0.88),
            ),
        ]);
        let verdicts = decide(&candidates, &near, &answers);
        assert!(matches!(&verdicts[0], Verdict::Update { existing, .. } if existing.id == "m1"));
        assert!(
            matches!(&verdicts[1], Verdict::Same { existing, p } if existing.id == "m2" && (*p - 0.88).abs() < 1e-9)
        );
    }

    #[test]
    fn anything_unsure_or_unanswered_is_added_as_before() {
        let candidates = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let near = vec![
            vec![memory("m1", "fact one")],
            vec![memory("m1", "fact one")],
            vec![memory("m3", "fact three")],
        ];
        let answers = BTreeMap::from([
            ("op0".to_string(), choice("replacement", 0.7)),
            ("to0".to_string(), choice("fact one", 0.99)),
            ("op1".to_string(), choice("replacement", 0.99)),
            ("to1".to_string(), choice(NONE_LABEL, 0.99)),
        ]);
        assert!(decide(&candidates, &near, &answers)
            .iter()
            .all(|verdict| matches!(verdict, Verdict::Add)));
    }

    #[test]
    fn one_stored_fact_is_touched_once_per_pass() {
        let candidates = vec!["Habite à Lyon.".to_string(), "Vit à Lyon.".to_string()];
        let near = vec![
            vec![memory("m1", "Habite à Paris.")],
            vec![memory("m1", "Habite à Paris.")],
        ];
        let answers = BTreeMap::from([
            ("op0".to_string(), choice("replacement", 0.95)),
            ("to0".to_string(), choice("Habite à Paris.", 0.95)),
            ("op1".to_string(), choice("replacement", 0.95)),
            ("to1".to_string(), choice("Habite à Paris.", 0.95)),
        ]);
        let verdicts = decide(&candidates, &near, &answers);
        assert!(matches!(verdicts[0], Verdict::Update { .. }));
        assert!(matches!(verdicts[1], Verdict::Add));
    }
}
