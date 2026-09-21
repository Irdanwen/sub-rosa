//! The Studio and native proposals consume the same measured input rules.
//! Published video fields override fallbacks, including explicit empty lists.
use crate::domain::types::AppError;
use serde_json::{json, Value};
use std::sync::OnceLock;

fn rules() -> Result<&'static Value, AppError> {
    static RULES: OnceLock<Result<Value, String>> = OnceLock::new();
    RULES
        .get_or_init(|| {
            serde_json::from_str(include_str!(
                "../../../src/lib/studio/model-input-rules.json"
            ))
            .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|error| {
            AppError::new(
                "assistant_media_rules",
                format!("The bundled model input rules are invalid: {error}"),
            )
        })
}

pub fn prompt_video(id: &str) -> bool {
    let id = id.to_lowercase();
    ![
        "image-to-video",
        "reference-to-video",
        "video-to-video",
        "video-upscale",
        "upscale-video",
    ]
    .iter()
    .any(|kind| id.contains(kind))
}

pub fn requirements(kind: &str, id: &str, published: Option<&Value>) -> Result<Value, AppError> {
    let id = id.to_lowercase();
    let family = if kind == "video" { "video" } else { "music" };
    let fallback = rules()?[family].as_array().and_then(|rows| {
        rows.iter()
            .find(|row| row["match"].as_str().is_some_and(|name| id.contains(name)))
    });
    if kind != "video" {
        return Ok(fallback
            .map(|row| row["caps"].clone())
            .unwrap_or_else(|| json!({"lyrics":"optional","instrumental":true})));
    }
    let mut result = json!({});
    for (field, stored) in [
        ("duration", "durations"),
        ("aspect_ratio", "aspectRatios"),
        ("resolution", "resolutions"),
    ] {
        let wire = if stored == "aspectRatios" {
            "aspect_ratios"
        } else {
            stored
        };
        if let Some(choices) = published
            .and_then(|p| p.get(wire))
            .or_else(|| fallback.and_then(|p| p.get(stored)))
        {
            result[field] = choices.clone();
        }
    }
    Ok(result)
}

pub fn prepare(
    kind: &str,
    id: &str,
    published: Option<&Value>,
    params: &mut Value,
) -> Result<(), AppError> {
    if kind == "video" {
        let fields = requirements(kind, id, published)?;
        for field in ["duration", "aspect_ratio", "resolution"] {
            if let Some(options) = fields[field].as_array() {
                if let Some(selected) = params.get(field) {
                    if !options.contains(selected) {
                        return Err(AppError::new(
                            "assistant_video_settings",
                            "Choose video settings supported by this model.",
                        ));
                    }
                } else if let Some(first) = options.first() {
                    params[field] = first.clone();
                }
            }
        }
    } else if kind == "music" {
        let caps = requirements(kind, id, published)?;
        let lyrics = params["lyrics_prompt"].as_str().unwrap_or("").trim();
        if (caps["lyrics"] == "required" && lyrics.is_empty())
            || (caps["lyrics"] == "none" && params.get("lyrics_prompt").is_some())
            || (caps["instrumental"] == false && params.get("force_instrumental").is_some())
        {
            return Err(AppError::new("assistant_music_settings", "Check this model's lyrics and instrumental requirements before preparing the generation."));
        }
        if let Some(range) = caps.get("durationSeconds") {
            if let Some(duration) = params["duration_seconds"].as_f64() {
                if duration < range["min"].as_f64().unwrap_or(1.0)
                    || duration > range["max"].as_f64().unwrap_or(300.0)
                {
                    return Err(AppError::new(
                        "assistant_music_duration",
                        "Choose a duration supported by this music model.",
                    ));
                }
            } else {
                params["duration_seconds"] = range["min"].clone();
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_seedance_constraints_get_the_shared_studio_defaults() {
        let mut p = json!({});
        prepare("video", "seedance-2-0-fast-text-to-video", None, &mut p).unwrap();
        assert_eq!(
            p,
            json!({"duration":"4s","aspect_ratio":"21:9","resolution":"480p"})
        );
        let mut p = json!({"resolution":"4k"});
        assert!(prepare("video", "seedance-2-0-fast", None, &mut p).is_err());
        assert!(!prompt_video("seedance-2-0-reference-to-video"));
    }
    #[test]
    fn published_empty_options_are_not_filled_by_fallbacks() {
        let published = json!({"aspect_ratios":[],"durations":["7s"]});
        let mut p = json!({});
        prepare("video", "seedance", Some(&published), &mut p).unwrap();
        assert!(p.get("aspect_ratio").is_none());
        assert_eq!(p["duration"], "7s");
        p["aspect_ratio"] = json!("16:9");
        assert!(prepare("video", "seedance", Some(&published), &mut p).is_err());
    }
    #[test]
    fn music_requirements_reject_invalid_requests_before_a_proposal_exists() {
        assert!(prepare("music", "minimax-music-1-5", None, &mut json!({})).is_err());
        assert!(prepare(
            "music",
            "minimax-music-1-5",
            None,
            &mut json!({"lyrics_prompt":"A verse"})
        )
        .is_ok());
        assert!(prepare(
            "music",
            "elevenlabs-music",
            None,
            &mut json!({"lyrics_prompt":"A verse"})
        )
        .is_err());
        assert!(prepare(
            "music",
            "stable-audio-25",
            None,
            &mut json!({"duration_seconds":300})
        )
        .is_err());
    }
}
