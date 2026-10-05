//! How each video family is written to, read from the same file the webview
//! reads (`src/lib/studio/direction/profiles.json`, ADR-0074): the composed
//! prompt and its AI rewrite never disagree about a family's budget, its
//! labels or how it takes time.

use serde::Deserialize;
use std::sync::LazyLock;

const PROFILES_JSON: &str = include_str!("../../../src/lib/studio/direction/profiles.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub family: String,
    #[serde(rename = "match")]
    pub stems: Vec<String>,
    pub budget_words: u32,
    pub labels: bool,
    /// `brackets`, `label` or `words`: see the JSON's note.
    pub timecodes: String,
}

#[derive(Deserialize)]
struct ProfilesFile {
    profiles: Vec<Profile>,
    default: Profile,
}

static PROFILES: LazyLock<ProfilesFile> = LazyLock::new(|| {
    serde_json::from_str(PROFILES_JSON).unwrap_or_else(|_| ProfilesFile {
        profiles: Vec::new(),
        default: Profile {
            family: "default".into(),
            stems: Vec::new(),
            budget_words: 80,
            labels: false,
            timecodes: "words".into(),
        },
    })
});

/// The profile of a model id: first stem match, longest stems first in the file.
pub fn profile(model_id: &str) -> &'static Profile {
    let id = model_id.to_ascii_lowercase();
    PROFILES
        .profiles
        .iter()
        .find(|profile| profile.stems.iter().any(|stem| id.contains(stem.as_str())))
        .unwrap_or(&PROFILES.default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_shared_profiles() {
        assert!(PROFILES.profiles.len() >= 8, "profiles.json did not parse");
        assert_eq!(
            profile("seedance-2-0-reference-to-video-basic").budget_words,
            60
        );
        assert!(!profile("seedance-2-0-reference-to-video-basic").labels);
        assert_eq!(
            profile("seedance-2-5-text-to-video-basic").family,
            "seedance-2-5"
        );
        assert_eq!(profile("kling-v3-pro-text-to-video").timecodes, "words");
        assert_eq!(profile("veo3.1-full-text-to-video").timecodes, "brackets");
        assert_eq!(profile("minimax-h3-text-to-video").family, "minimax-h3");
        assert_eq!(profile("mystery-video-9").family, "default");
    }
}
