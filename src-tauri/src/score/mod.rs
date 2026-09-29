//! A film's music, read out of its script: where cues play and what they
//! sound like (ADR-0067).
//!
//! The same rule as `studio_ai` (ADR-0038): this proposes, the person
//! accepts, and nothing here writes to the project. The run is one short
//! completion, transient for the same reason a rewrite is: resurrecting a
//! proposal onto a shot list edited since would be a silent corruption.
//!
//! The model is handed numbered shots and answers in shot numbers. It never
//! answers in seconds: the app resolves each shot's length from the model it
//! renders with, so a cue's duration is the sum of its shots, computed where
//! the durations are known (the ADR-0027 rule, "the app owns the clock").

pub mod prompts;

use crate::domain::types::AppError;
use crate::june_api;
use serde::{Deserialize, Serialize};

/// Mirrors the rewrite's ceiling: a longer script is cut, not refused, since
/// the shot list below carries the whole film anyway.
const MAX_SCRIPT_CHARS: usize = 24_000;
const MAX_SHOTS: usize = 200;
const MAX_CUES: usize = 12;
const MAX_FIELD_CHARS: usize = 600;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreShot {
    pub title: String,
    #[serde(default)]
    pub action: String,
    /// The seconds the app resolved for the shot, for the model's sense of
    /// pace. It answers in shot numbers regardless.
    #[serde(default)]
    pub seconds: f32,
    #[serde(default)]
    pub dialogue: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreRequest {
    #[serde(default)]
    pub script: String,
    pub shots: Vec<ScoreShot>,
    /// One piece under the whole film, or a cue sheet.
    #[serde(default)]
    pub single: bool,
    /// Whether the chosen music model sings words.
    #[serde(default)]
    pub lyrics: bool,
    /// The project's text model; the app's when absent.
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedCue {
    pub title: String,
    /// Zero-based, inclusive, already clamped to the shot list.
    pub from: usize,
    pub to: usize,
    pub mood: String,
    pub intensity: String,
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreProposal {
    pub identity: String,
    pub cues: Vec<ProposedCue>,
    pub prompt_version: &'static str,
}

fn clip(value: &str, limit: usize) -> String {
    value.trim().chars().take(limit).collect()
}

fn clock(seconds: f32) -> String {
    let total = seconds.max(0.0).round() as u32;
    format!("{}:{:02}", total / 60, total % 60)
}

pub fn user_message(request: &ScoreRequest) -> String {
    let mut start = 0.0_f32;
    let shots: Vec<String> = request
        .shots
        .iter()
        .take(MAX_SHOTS)
        .enumerate()
        .map(|(index, shot)| {
            let line = format!(
                "{}. {} (at {}, {} s{}): {}",
                index + 1,
                clip(&shot.title, 120),
                clock(start),
                shot.seconds.max(0.0).round(),
                if shot.dialogue { ", dialogue" } else { "" },
                clip(&shot.action, 300)
            );
            start += shot.seconds.max(0.0);
            line
        })
        .collect();
    format!(
        "{}\n\n<script>\n{}\n</script>\n\nShot list ({} shots, {} in all):\n{}",
        prompts::task(request.single, request.lyrics),
        clip(&request.script, MAX_SCRIPT_CHARS),
        shots.len(),
        clock(start),
        shots.join("\n")
    )
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct RawCue {
    title: String,
    from: serde_json::Value,
    to: serde_json::Value,
    mood: String,
    intensity: String,
    prompt: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct RawScore {
    identity: String,
    cues: Vec<RawCue>,
}

/// A shot number as the model wrote it: 3, 3.0 or "3".
fn shot_number(value: &serde_json::Value) -> Option<i64> {
    match value {
        serde_json::Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|value| value.round() as i64)),
        serde_json::Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

/// Parse the reply and make it true to the shot list: numbers become indices
/// clamped to the film, cues follow the film's order and never overlap, and a
/// single score covers the whole film whatever the model said.
pub fn parse(raw: &str, shots: usize, single: bool) -> Result<ScoreProposal, AppError> {
    let start = raw.find('{');
    let end = raw.rfind('}');
    let body = match (start, end) {
        (Some(start), Some(end)) if end > start => &raw[start..=end],
        _ => return Err(AppError::new(
            "score_invalid_response",
            "This model did not return a usable score. Choose another text model and try again.",
        )),
    };
    let parsed: RawScore = serde_json::from_str(body).map_err(|_| {
        AppError::new(
            "score_invalid_response",
            "This model did not return a usable score. Choose another text model and try again.",
        )
    })?;
    let last = shots.saturating_sub(1);
    let mut cues: Vec<ProposedCue> = parsed
        .cues
        .into_iter()
        .filter(|cue| !cue.prompt.trim().is_empty())
        .filter_map(|cue| {
            let from = shot_number(&cue.from)?;
            let to = shot_number(&cue.to).unwrap_or(from);
            let index = |number: i64| (number.max(1) as usize - 1).min(last);
            let (from, to) = (index(from.min(to)), index(from.max(to)));
            let intensity = match cue.intensity.trim().to_ascii_lowercase().as_str() {
                "low" | "high" => cue.intensity.trim().to_ascii_lowercase(),
                _ => "medium".to_string(),
            };
            Some(ProposedCue {
                title: clip(&cue.title, 80),
                from,
                to,
                mood: clip(&cue.mood, 80),
                intensity,
                prompt: clip(&cue.prompt, MAX_FIELD_CHARS),
            })
        })
        .collect();
    cues.sort_by_key(|cue| (cue.from, cue.to));
    // Overlaps are resolved in favour of the earlier cue: a later one starts
    // after it ends, or goes when nothing is left of it.
    let mut placed: Vec<ProposedCue> = Vec::new();
    for mut cue in cues {
        if let Some(previous) = placed.last() {
            if cue.from <= previous.to {
                cue.from = previous.to + 1;
            }
        }
        if cue.from <= cue.to && cue.from <= last {
            placed.push(cue);
        }
    }
    placed.truncate(MAX_CUES);
    if single {
        placed.truncate(1);
        if let Some(cue) = placed.first_mut() {
            cue.from = 0;
            cue.to = last;
        }
    }
    if placed.is_empty() {
        return Err(AppError::new(
            "score_no_cues",
            "This model placed no music in the film. Try another text model or revise the script.",
        ));
    }
    Ok(ScoreProposal {
        identity: clip(&parsed.identity, MAX_FIELD_CHARS),
        cues: placed,
        prompt_version: prompts::SCORE_PROMPT_VERSION,
    })
}

async fn completion(model: &str, user: &str) -> Result<String, AppError> {
    let response = june_api::proxy_agent_chat_completions(serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": prompts::SYSTEM },
            { "role": "user", "content": user }
        ],
        // Some room to choose, not to wander: the cues must still follow
        // the shot list they were handed.
        "temperature": 0.4,
        "max_tokens": 4000
    }))
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(AppError::new(
            "score_failed",
            format!("The model returned status {}.", response.status),
        ));
    }
    let body = response.collect_body().await?;
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|error| AppError::new("score_failed", error.to_string()))?;
    june_api::extract_chat_completion_text(&value)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| AppError::new("score_failed", "The model returned no text."))
}

/// Propose the film's music. Nothing is saved: the person accepts it.
#[tauri::command]
pub async fn score_propose(request: ScoreRequest) -> Result<ScoreProposal, AppError> {
    if request.shots.is_empty() {
        return Err(AppError::new(
            "score_no_shots",
            "Break your script into shots before composing its music.",
        ));
    }
    let model = request
        .model_id
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string)
        .unwrap_or_else(crate::providers::generation_model);
    let reply = completion(&model, &user_message(&request)).await?;
    parse(&reply, request.shots.len().min(MAX_SHOTS), request.single)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shot(title: &str, seconds: f32) -> ScoreShot {
        ScoreShot {
            title: title.into(),
            action: "Henri walks.".into(),
            seconds,
            dialogue: false,
        }
    }

    #[test]
    fn the_shot_list_is_numbered_and_timed_by_the_app() {
        let request = ScoreRequest {
            script: "Scene 1. The hall, night.".into(),
            shots: vec![shot("The hall", 5.0), shot("The corridor", 8.0)],
            single: false,
            lyrics: false,
            model_id: None,
        };
        let user = user_message(&request);
        assert!(user.contains("1. The hall (at 0:00, 5 s): Henri walks."));
        assert!(user.contains("2. The corridor (at 0:05, 8 s)"));
        assert!(user.contains("2 shots, 0:13 in all"));
        assert!(user.contains("never ask for vocals"));
        assert!(user.contains("cue sheet"));
    }

    #[test]
    fn numbers_become_clamped_ordered_indices_without_overlap() {
        let reply = r#"Here you go: {"identity": "Solo cello, slow.", "cues": [
            {"title": "Late", "from": "4", "to": 9, "mood": "tense", "intensity": "HIGH", "prompt": "Pulsing strings."},
            {"title": "Ouverture", "from": 1, "to": 3.0, "mood": "calm", "intensity": "soft", "prompt": "A lone cello."},
            {"title": "Overlap", "from": 2, "to": 3, "prompt": "Swallowed."},
            {"title": "Empty", "from": 5, "to": 5, "prompt": "  "}
        ]}"#;
        let proposal = parse(reply, 6, false).unwrap();
        assert_eq!(proposal.identity, "Solo cello, slow.");
        let spans: Vec<(usize, usize)> =
            proposal.cues.iter().map(|cue| (cue.from, cue.to)).collect();
        assert_eq!(spans, vec![(0, 2), (3, 5)]);
        assert_eq!(proposal.cues[0].intensity, "medium");
        assert_eq!(proposal.cues[1].intensity, "high");
    }

    #[test]
    fn a_single_score_covers_the_whole_film() {
        let reply = r#"{"identity": "Piano.", "cues": [{"title": "Score", "from": 2, "to": 3, "prompt": "Gentle piano."}, {"title": "Two", "from": 4, "to": 5, "prompt": "More."}]}"#;
        let proposal = parse(reply, 8, true).unwrap();
        assert_eq!(proposal.cues.len(), 1);
        assert_eq!((proposal.cues[0].from, proposal.cues[0].to), (0, 7));
    }

    #[test]
    fn a_reply_without_music_is_refused() {
        assert_eq!(
            parse("no json here", 3, false).unwrap_err().code,
            "score_invalid_response"
        );
        assert_eq!(
            parse(r#"{"identity": "x", "cues": []}"#, 3, false)
                .unwrap_err()
                .code,
            "score_no_cues"
        );
    }
}
