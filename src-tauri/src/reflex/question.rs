//! The wire shape of a reflex: typed questions over one state, typed answers.
//!
//! The provider documents only the yes/no kind; the other two were settled
//! against the live endpoint (2026-09-25) and the tests below freeze what it
//! accepted, because the error it gives for the wrong one names the field and
//! nothing else:
//!
//! - `noul` takes `instructions` and answers a probability in `[0, 1]`.
//! - `choice` takes `criteria` as an **object** `{label: description}` and
//!   answers the label, a distribution over labels, and a confidence.
//! - `score` takes `criteria` as an **array** of ordered level names and
//!   answers a continuous score over their indices, a legend, a distribution
//!   and a confidence.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use crate::domain::types::AppError;

/// Characters counted as one token when sizing a batch. Deliberately low (the
/// usual estimate is four): the notes are mostly French, which tokenizes
/// longer, and a batch the provider refuses costs a round trip for nothing.
pub const CHARS_PER_TOKEN: usize = 3;
/// The state plus the longest question, as the provider bounds it.
pub const MAX_STATE_TOKENS: usize = 32_000;
/// The state plus every question.
pub const MAX_TOTAL_TOKENS: usize = 64_000;

#[derive(Debug, Clone, PartialEq)]
pub enum Question {
    /// Yes or no, answered as the probability of yes.
    Noul { instructions: String },
    /// One label out of a set. Labels are words that mean what they say:
    /// the model follows an option's name more than its description.
    Choice {
        instructions: String,
        options: Vec<(String, String)>,
    },
    /// A position on an ordered scale, lowest level first.
    Score {
        instructions: String,
        levels: Vec<String>,
    },
}

impl Question {
    pub fn noul(instructions: impl Into<String>) -> Self {
        Self::Noul {
            instructions: instructions.into(),
        }
    }

    fn instructions(&self) -> &str {
        match self {
            Self::Noul { instructions }
            | Self::Choice { instructions, .. }
            | Self::Score { instructions, .. } => instructions,
        }
    }

    fn to_json(&self) -> Value {
        match self {
            Self::Noul { instructions } => json!({ "type": "noul", "instructions": instructions }),
            Self::Choice {
                instructions,
                options,
            } => {
                let criteria: Map<String, Value> = options
                    .iter()
                    .map(|(label, description)| (label.clone(), Value::String(description.clone())))
                    .collect();
                json!({ "type": "choice", "instructions": instructions, "criteria": criteria })
            }
            Self::Score {
                instructions,
                levels,
            } => json!({ "type": "score", "instructions": instructions, "criteria": levels }),
        }
    }

    fn chars(&self) -> usize {
        let criteria = match self {
            Self::Noul { .. } => 0,
            Self::Choice { options, .. } => options.iter().map(|(l, d)| l.len() + d.len()).sum(),
            Self::Score { levels, .. } => levels.iter().map(String::len).sum(),
        };
        self.instructions().len() + criteria
    }

    /// Refuses the shapes the provider rejects, and the one it accepts but
    /// answers badly: a label that is a number or a single letter, whose name
    /// carries no meaning for the model to follow.
    fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Noul { .. } => Ok(()),
            Self::Choice { options, .. } => {
                if options.len() < 2 || options.len() > 255 {
                    return Err("a choice needs 2 to 255 options");
                }
                if options.iter().any(|(label, _)| !meaningful_label(label)) {
                    return Err("choice labels must be words");
                }
                Ok(())
            }
            Self::Score { levels, .. } => {
                if levels.len() < 2 || levels.len() > 10 {
                    return Err("a score needs 2 to 10 levels");
                }
                if levels.iter().any(|level| !meaningful_label(level)) {
                    return Err("score levels must be words");
                }
                Ok(())
            }
        }
    }
}

fn meaningful_label(label: &str) -> bool {
    let label = label.trim();
    label.chars().filter(|c| c.is_alphabetic()).count() >= 2
}

/// Questions asked of one state in a single call, keyed by an id the caller
/// reads the answers back with.
#[derive(Debug, Clone, PartialEq)]
pub struct Batch {
    pub state: String,
    pub questions: Vec<(String, Question)>,
}

impl Batch {
    pub fn new(state: impl Into<String>) -> Self {
        Self {
            state: state.into(),
            questions: Vec::new(),
        }
    }

    pub fn ask(mut self, id: impl Into<String>, question: Question) -> Self {
        self.questions.push((id.into(), question));
        self
    }

    pub fn is_empty(&self) -> bool {
        self.questions.is_empty()
    }

    /// Whether the provider will take this batch as it is.
    pub fn fits(&self) -> bool {
        let state = self.state.len();
        let longest = self
            .questions
            .iter()
            .map(|(_, q)| q.chars())
            .max()
            .unwrap_or(0);
        let total: usize = self.questions.iter().map(|(_, q)| q.chars()).sum();
        (state + longest) / CHARS_PER_TOKEN <= MAX_STATE_TOKENS
            && (state + total) / CHARS_PER_TOKEN <= MAX_TOTAL_TOKENS
    }

    pub fn to_body(&self, model: &str) -> Result<Value, AppError> {
        let mut questions = Map::new();
        for (id, question) in &self.questions {
            question.validate().map_err(|reason| {
                AppError::new("reflex_invalid_question", format!("{id}: {reason}"))
            })?;
            questions.insert(id.clone(), question.to_json());
        }
        Ok(json!({ "model": model, "state": self.state, "questions": questions }))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    Noul {
        p: f64,
    },
    Choice {
        choice: String,
        probabilities: BTreeMap<String, f64>,
        confidence: f64,
    },
    Score {
        score: f64,
        probabilities: BTreeMap<String, f64>,
        confidence: f64,
    },
}

impl Answer {
    /// The probability of yes, for a yes/no answer.
    pub fn yes(&self) -> Option<f64> {
        match self {
            Self::Noul { p } => Some(*p),
            _ => None,
        }
    }
}

/// The answers of a response, by question id. An answer the response does not
/// carry, or carries in a shape this build does not know, is simply absent:
/// the caller treats a missing answer as "the reflex had nothing to say".
pub fn parse_answers(value: &Value) -> BTreeMap<String, Answer> {
    let Some(answers) = value.get("answers").and_then(Value::as_object) else {
        return BTreeMap::new();
    };
    answers
        .iter()
        .filter_map(|(id, answer)| parse_answer(answer).map(|a| (id.clone(), a)))
        .collect()
}

fn parse_answer(answer: &Value) -> Option<Answer> {
    let probabilities = || -> BTreeMap<String, f64> {
        answer
            .get("probabilities")
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .filter_map(|(k, v)| v.as_f64().map(|p| (k.clone(), p)))
                    .collect()
            })
            .unwrap_or_default()
    };
    let confidence = answer
        .get("confidence")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    match answer.get("type").and_then(Value::as_str)? {
        "noul" => {
            let p = answer.get("noul").and_then(Value::as_f64)?;
            p.is_finite().then(|| Answer::Noul {
                p: p.clamp(0.0, 1.0),
            })
        }
        "choice" => Some(Answer::Choice {
            choice: answer.get("choice").and_then(Value::as_str)?.to_string(),
            probabilities: probabilities(),
            confidence,
        }),
        "score" => Some(Answer::Score {
            score: answer.get("score").and_then(Value::as_f64)?,
            probabilities: probabilities(),
            confidence,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_uses_the_shapes_the_live_endpoint_accepted() {
        let batch = Batch::new("Note: we froze hiring until March.")
            .ask("rel", Question::noul("Does the note answer the question?"))
            .ask(
                "lvl",
                Question::Score {
                    instructions: "How relevant is the note?".into(),
                    levels: vec![
                        "irrelevant".into(),
                        "related".into(),
                        "direct answer".into(),
                    ],
                },
            )
            .ask(
                "act",
                Question::Choice {
                    instructions: "Which memory operation fits?".into(),
                    options: vec![
                        ("ADD".into(), "a new fact".into()),
                        ("UPDATE".into(), "replaces the stored fact".into()),
                    ],
                },
            );
        let body = batch.to_body("jev-latest").unwrap();
        assert_eq!(body["model"], "jev-latest");
        assert_eq!(body["questions"]["rel"]["type"], "noul");
        assert!(body["questions"]["rel"].get("criteria").is_none());
        assert!(body["questions"]["lvl"]["criteria"].is_array());
        assert!(body["questions"]["act"]["criteria"].is_object());
        assert_eq!(
            body["questions"]["act"]["criteria"]["UPDATE"],
            "replaces the stored fact"
        );
    }

    #[test]
    fn labels_without_meaning_are_refused_before_they_are_sent() {
        let numeric = Batch::new("s").ask(
            "q",
            Question::Choice {
                instructions: "pick".into(),
                options: vec![("0".into(), "no".into()), ("1".into(), "yes".into())],
            },
        );
        assert!(numeric.to_body("m").is_err());
        let single = Batch::new("s").ask(
            "q",
            Question::Score {
                instructions: "rate".into(),
                levels: vec!["low".into()],
            },
        );
        assert!(single.to_body("m").is_err());
    }

    #[test]
    fn the_live_response_parses_into_typed_answers() {
        // Verbatim from the 2026-09-25 call.
        let value: Value = serde_json::from_str(
            r#"{"model":"jev-latest","answers":{"rel":{"type":"noul","noul":0.93},"lvl":{"type":"score","score":1.98,"legend":{"0":"irrelevant","1":"related but does not answer","2":"directly answers"},"probabilities":{"0":0.01,"1":0,"2":0.99},"confidence":0.97},"act":{"type":"choice","choice":"UPDATE","probabilities":{"UPDATE":0.98,"DELETE":0,"NOOP":0,"ADD":0.02},"confidence":0.97}},"usage":{"input_tokens":488,"output_tokens":75}}"#,
        )
        .unwrap();
        let answers = parse_answers(&value);
        assert_eq!(answers["rel"].yes(), Some(0.93));
        match &answers["act"] {
            Answer::Choice {
                choice,
                probabilities,
                confidence,
            } => {
                assert_eq!(choice, "UPDATE");
                assert_eq!(probabilities["ADD"], 0.02);
                assert_eq!(*confidence, 0.97);
            }
            other => panic!("expected a choice, got {other:?}"),
        }
        match &answers["lvl"] {
            Answer::Score { score, .. } => assert!((score - 1.98).abs() < 1e-9),
            other => panic!("expected a score, got {other:?}"),
        }
    }

    #[test]
    fn an_unknown_or_malformed_answer_is_absent_not_an_error() {
        let value = json!({ "answers": {
            "a": { "type": "noul" },
            "b": { "type": "someday", "x": 1 },
            "c": { "type": "noul", "noul": 1.7 }
        }});
        let answers = parse_answers(&value);
        assert!(!answers.contains_key("a"));
        assert!(!answers.contains_key("b"));
        assert_eq!(answers["c"].yes(), Some(1.0));
        assert!(parse_answers(&json!({ "error": "nope" })).is_empty());
    }

    #[test]
    fn a_batch_knows_when_it_is_too_large() {
        let small = Batch::new("short").ask("q", Question::noul("yes?"));
        assert!(small.fits());
        let huge_state = "x".repeat((MAX_STATE_TOKENS + 1) * CHARS_PER_TOKEN);
        assert!(!Batch::new(huge_state)
            .ask("q", Question::noul("yes?"))
            .fits());
    }
}
