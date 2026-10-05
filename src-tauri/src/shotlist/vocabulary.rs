//! The prompt bible's vocabulary, read from the same file the webview reads.
//!
//! The reader is asked for ids, never for free camera prose, and an id the
//! vocabulary does not have is dropped rather than guessed at: the composer
//! (`src/lib/studio/prompt/compose.ts`) writes nothing for it, which is a
//! worse shot than a known id and a better one than an invented phrase.

use std::collections::HashMap;
use std::sync::LazyLock;

const VOCABULARY_JSON: &str = include_str!("../../../src/lib/studio/direction/vocabulary.json");

/// The categories the reader fills in, in the order the prompt lists them.
pub const READER_CATEGORIES: [&str; 12] = [
    "shotSizes",
    "lenses",
    "depths",
    "angles",
    "movements",
    "amplitudes",
    "speeds",
    "transitions",
    "tones",
    "paces",
    "genres",
    "moods",
];

static IDS: LazyLock<HashMap<String, Vec<String>>> = LazyLock::new(|| {
    let value: serde_json::Value = serde_json::from_str(VOCABULARY_JSON).unwrap_or_default();
    let mut ids = HashMap::new();
    if let Some(object) = value.as_object() {
        for (category, entries) in object {
            let Some(entries) = entries.as_array() else {
                continue;
            };
            let list: Vec<String> = entries
                .iter()
                .filter_map(|entry| entry.get("id")?.as_str().map(str::to_string))
                .collect();
            if !list.is_empty() {
                ids.insert(category.clone(), list);
            }
        }
    }
    ids
});

/// Every id of a category, in the file's order.
pub fn ids(category: &str) -> &'static [String] {
    IDS.get(category).map(Vec::as_slice).unwrap_or(&[])
}

/// The id, trimmed and lowercased, when the vocabulary has it.
pub fn known(category: &str, raw: Option<&str>) -> Option<String> {
    let value = raw?.trim().to_ascii_lowercase();
    ids(category).contains(&value).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_shared_vocabulary() {
        for category in READER_CATEGORIES {
            assert!(!ids(category).is_empty(), "{category} is empty");
        }
        assert_eq!(
            known("shotSizes", Some(" Close-Up ")),
            Some("close-up".into())
        );
        assert_eq!(known("shotSizes", Some("very tight")), None);
        assert_eq!(known("lenses", None), None);
    }
}
