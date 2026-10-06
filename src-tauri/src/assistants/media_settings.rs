//! The Studio and native proposals consume the same measured input rules.
//! Published video fields override fallbacks, including explicit empty lists.
//! Music reads the model's published limits first and the measured table only
//! for a model that publishes nothing (ADR-0076), as `musicCapabilities` does
//! in `src/lib/studio/catalog.ts`.
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

/// A queue model that reads its prompt aloud: it publishes voices and takes
/// neither lyrics nor a length (ElevenLabs TTS v3/v4, Seed Audio). Mirrors
/// `speaksOnQueue` in `src/lib/studio/catalog.ts` (ADR-0076).
pub fn speaks_on_queue(model: &crate::carpe_diem::media::MediaModelDto) -> bool {
    if model.media_type != "music" || model.voices.is_empty() {
        return false;
    }
    let c = model.constraints.as_ref().cloned().unwrap_or(Value::Null);
    let takes_length = c["duration_options"]
        .as_array()
        .is_some_and(|o| !o.is_empty())
        || !c["min_duration"].is_null()
        || !c["max_duration"].is_null();
    !takes_length && c["supports_lyrics"] != true
}

/// What an audio model does - "speech", "music" or "effects" - read from what
/// it publishes, never from its catalog type alone (ADR-0076).
pub fn audio_role(model: &crate::carpe_diem::media::MediaModelDto) -> Option<&'static str> {
    match model.media_type.as_str() {
        "tts" => Some("speech"),
        "music" if speaks_on_queue(model) => Some("speech"),
        "music" => {
            let id = model.id.to_lowercase();
            let loops = model
                .constraints
                .as_ref()
                .is_some_and(|c| c["supports_loop"] == true);
            Some(
                if loops || id.contains("sound-effect") || id.contains("mmaudio") {
                    "effects"
                } else {
                    "music"
                },
            )
        }
        _ => None,
    }
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

/// Keys whose presence proves the catalog described a music model. Only then
/// is a missing length a statement that the model takes none.
const DESCRIBED_BY: [&str; 7] = [
    "supports_lyrics",
    "lyrics_required",
    "supports_force_instrumental",
    "supports_speed",
    "supported_formats",
    "prompt_character_limit",
    "min_prompt_length",
];

fn published_duration(c: &Value) -> Option<Value> {
    let mut options: Vec<f64> = c["duration_options"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_f64)
                .filter(|v| *v > 0.0)
                .collect()
        })
        .unwrap_or_default();
    options.sort_by(|a, b| a.total_cmp(b));
    let fallback = c["default_duration"].as_f64();
    if let (Some(first), Some(last)) = (options.first().copied(), options.last().copied()) {
        let gaps: Vec<f64> = options.windows(2).map(|pair| pair[1] - pair[0]).collect();
        let even = !gaps.is_empty() && gaps.iter().all(|gap| *gap == gaps[0]);
        let default = fallback.filter(|d| options.contains(d)).unwrap_or(first);
        return Some(json!({
            "min": first, "max": last, "step": if even { gaps[0] } else { 1.0 },
            "default": default, "options": options,
        }));
    }
    let (min, max) = (c["min_duration"].as_f64(), c["max_duration"].as_f64());
    if min.is_none() && max.is_none() {
        return fallback.map(|d| json!({"min": d, "max": d, "step": 1.0, "default": d}));
    }
    let low = min.unwrap_or(1.0);
    let high = max.or(fallback).unwrap_or(low).max(low);
    let default = fallback.map(|d| d.clamp(low, high)).unwrap_or(low);
    Some(json!({"min": low, "max": high, "step": 1.0, "default": default}))
}

fn published_music(published: Option<&Value>) -> Option<Value> {
    let c = published.filter(|c| DESCRIBED_BY.iter().any(|key| !c[*key].is_null()))?;
    let lyrics = if c["supports_lyrics"] == false {
        "none"
    } else if c["lyrics_required"] == true {
        "required"
    } else {
        "optional"
    };
    let mut caps = json!({
        "lyrics": lyrics,
        "instrumental": c["supports_force_instrumental"] == true,
        "lyricsOptimizer": c["supports_lyrics_optimizer"] == true,
        "loop": c["supports_loop"] == true,
    });
    if let Some(duration) = published_duration(c) {
        caps["durationSeconds"] = duration;
    }
    Some(caps)
}

pub fn requirements(kind: &str, id: &str, published: Option<&Value>) -> Result<Value, AppError> {
    if kind != "video" {
        if let Some(caps) = published_music(published) {
            return Ok(caps);
        }
    }
    let id = id.to_lowercase();
    let family = if kind == "video" { "video" } else { "music" };
    let fallback = rules()?[family].as_array().and_then(|rows| {
        rows.iter()
            .find(|row| row["match"].as_str().is_some_and(|name| id.contains(name)))
    });
    if kind != "video" {
        return Ok(fallback
            .map(|row| row["caps"].clone())
            .unwrap_or_else(|| json!({"lyrics":"optional","instrumental":false})));
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
    } else if kind == "speech" {
        // A `tts` model publishes nothing here and keeps the endpoint's own
        // 0.25 to 4 range; a speaking queue model states whether it takes a
        // speed at all, and within which bounds.
        if let (Some(c), Some(speed)) = (published, params.get("speed").and_then(Value::as_f64)) {
            let bounded = c["supports_speed"] == true
                && c["min_speed"].as_f64().map_or(true, |min| speed >= min)
                && c["max_speed"].as_f64().map_or(true, |max| speed <= max);
            if !c["supports_speed"].is_null() && !bounded {
                return Err(AppError::new(
                    "assistant_speech_settings",
                    "Choose a speed this voice model supports.",
                ));
            }
        }
    } else if kind == "music" {
        let caps = requirements(kind, id, published)?;
        let lyrics = params["lyrics_prompt"].as_str().unwrap_or("").trim();
        let instrumental = params["force_instrumental"] == true;
        let writes_lyrics = params["lyrics_optimizer"] == true;
        if (caps["lyrics"] == "required" && lyrics.is_empty() && !instrumental && !writes_lyrics)
            || (caps["lyrics"] == "none" && params.get("lyrics_prompt").is_some())
            || (caps["instrumental"] != true && params.get("force_instrumental").is_some())
            || (caps["lyricsOptimizer"] != true && params.get("lyrics_optimizer").is_some())
            || (caps["loop"] != true && params.get("loop").is_some())
        {
            return Err(AppError::new("assistant_music_settings", "Check this model's lyrics and instrumental requirements before preparing the generation."));
        }
        if let Some(range) = caps.get("durationSeconds") {
            if let Some(duration) = params["duration_seconds"].as_f64() {
                let min = range["min"].as_f64().unwrap_or(1.0);
                let step = range["step"].as_f64().unwrap_or(1.0);
                let listed = range["options"].as_array().map_or(true, |options| {
                    options
                        .iter()
                        .filter_map(Value::as_f64)
                        .any(|o| o == duration)
                });
                if duration < min
                    || duration > range["max"].as_f64().unwrap_or(300.0)
                    || step <= 0.0
                    || ((duration - min) / step).fract().abs() > 1e-9
                    || !listed
                {
                    return Err(AppError::new(
                        "assistant_music_duration",
                        "Choose a duration supported by this music model.",
                    ));
                }
            } else {
                params["duration_seconds"] = range
                    .get("default")
                    .cloned()
                    .unwrap_or_else(|| range["min"].clone());
            }
        } else if params.get("duration_seconds").is_some() {
            return Err(AppError::new(
                "assistant_music_duration",
                "This music model sets its own length.",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn music_duration_uses_the_models_discrete_increments() {
        for duration in [60, 90, 120, 210] {
            assert!(prepare(
                "music",
                "ace-step-15",
                None,
                &mut json!({"duration_seconds":duration})
            )
            .is_ok());
        }
        for duration in [59, 61, 89, 211] {
            assert!(prepare(
                "music",
                "ace-step-15",
                None,
                &mut json!({"duration_seconds":duration})
            )
            .is_err());
        }
    }
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
    fn model(
        id: &str,
        media_type: &str,
        voices: &[&str],
        c: Value,
    ) -> crate::carpe_diem::media::MediaModelDto {
        crate::carpe_diem::media::MediaModelDto {
            id: id.into(),
            media_type: media_type.into(),
            name: id.into(),
            tier: None,
            privacy: None,
            offline: false,
            voices: voices.iter().map(|v| v.to_string()).collect(),
            constraints: (!c.is_null()).then_some(c),
            model_sets: Vec::new(),
            traits: Vec::new(),
            supports_vision: false,
            pricing: None,
            cost_credits: None,
        }
    }

    #[test]
    fn an_audio_model_is_filed_by_what_it_does() {
        let v4 = model(
            "elevenlabs-tts-v4",
            "music",
            &["Aria"],
            json!({"supports_lyrics": false, "voices": ["Aria"]}),
        );
        let sfx = model(
            "elevenlabs-sound-effects-v2",
            "music",
            &[],
            json!({"supports_loop": true, "min_duration": 1, "max_duration": 22}),
        );
        let ace = model(
            "ace-step-15",
            "music",
            &[],
            json!({"supports_lyrics": true}),
        );
        let kokoro = model("tts-kokoro", "tts", &["af_sky"], Value::Null);
        assert_eq!(audio_role(&v4), Some("speech"));
        assert!(speaks_on_queue(&v4) && !speaks_on_queue(&kokoro));
        assert_eq!(audio_role(&sfx), Some("effects"));
        assert_eq!(audio_role(&ace), Some("music"));
        assert_eq!(audio_role(&kokoro), Some("speech"));
    }

    #[test]
    fn a_queued_voice_takes_only_its_published_speed() {
        let v2 = json!({"supports_speed": true, "min_speed": 0.7, "max_speed": 1.2});
        assert!(prepare(
            "speech",
            "elevenlabs-tts-multilingual-v2",
            Some(&v2),
            &mut json!({"speed": 1.1})
        )
        .is_ok());
        assert!(prepare(
            "speech",
            "elevenlabs-tts-multilingual-v2",
            Some(&v2),
            &mut json!({"speed": 2.0})
        )
        .is_err());
        let v4 = json!({"supports_speed": false});
        assert!(prepare(
            "speech",
            "elevenlabs-tts-v4",
            Some(&v4),
            &mut json!({"speed": 1.0})
        )
        .is_err());
        assert!(prepare("speech", "tts-kokoro", None, &mut json!({"speed": 3.0})).is_ok());
    }

    #[test]
    fn published_music_limits_win_over_the_measured_table() {
        // minimax-music-v26 as the operator publishes it (2026-10-06): lyrics
        // optional, instrumental accepted, no length.
        let v26 = json!({"supports_lyrics": true, "lyrics_required": false,
            "supports_force_instrumental": true, "prompt_character_limit": 300});
        assert!(prepare("music", "minimax-music-v26", Some(&v26), &mut json!({})).is_ok());
        assert!(prepare(
            "music",
            "minimax-music-v26",
            Some(&v26),
            &mut json!({"force_instrumental": true})
        )
        .is_ok());
        assert!(prepare(
            "music",
            "minimax-music-v26",
            Some(&v26),
            &mut json!({"duration_seconds": 30})
        )
        .is_err());
        // ace-step-15 refuses `force_instrumental` and takes a listed length,
        // defaulting to its own default rather than the minimum.
        let ace = json!({"supports_lyrics": true, "supports_force_instrumental": false,
            "duration_options": [60, 90, 120, 150, 180, 210], "default_duration": 90});
        assert!(prepare(
            "music",
            "ace-step-15",
            Some(&ace),
            &mut json!({"force_instrumental": true})
        )
        .is_err());
        let mut p = json!({});
        prepare("music", "ace-step-15", Some(&ace), &mut p).unwrap();
        assert_eq!(p["duration_seconds"], json!(90.0));
        // elevenlabs-music: a 3 to 600 second range, instrumental accepted.
        let eleven = json!({"supports_lyrics": false, "supports_force_instrumental": true,
            "min_duration": 3, "max_duration": 600, "default_duration": 60});
        let mut p = json!({"force_instrumental": true});
        prepare("music", "elevenlabs-music", Some(&eleven), &mut p).unwrap();
        assert_eq!(p["duration_seconds"], json!(60.0));
        assert!(prepare(
            "music",
            "elevenlabs-music",
            Some(&eleven),
            &mut json!({"duration_seconds": 601})
        )
        .is_err());
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
