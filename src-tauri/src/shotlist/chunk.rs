//! Splitting a script into passes.
//!
//! Scripts are not transcripts: there are no turns to break on, only
//! paragraphs. So chunking is paragraph-aligned, which is also where a scene
//! is most likely to end - a break mid-sentence would make the model guess at
//! a beat it cannot see the end of.

/// How much script goes into one pass.
///
/// Smaller than the long-form budget on purpose: the answer here is structured
/// JSON with an entry per shot, and the output grows faster than the input.
pub const CHUNK_BUDGET_CHARS: usize = 8_000;

/// Ceiling on passes for one script. A feature-length screenplay is not what
/// this is for, and running away with it is real money, so it is refused by
/// name rather than silently truncated.
pub const MAX_CHUNKS: usize = 12;

/// Below this there is nothing to break down that the user could not do faster
/// by hand.
pub const MIN_SCRIPT_CHARS: usize = 120;

/// Paragraph-aligned chunks, in order. A single paragraph longer than the
/// budget is its own chunk rather than being cut: an over-long pass is
/// recoverable, half a sentence is not.
pub fn chunk_script(text: &str, budget_chars: usize) -> Vec<String> {
    let paragraphs: Vec<&str> = text
        .split("\n\n")
        .map(str::trim)
        .filter(|paragraph| !paragraph.is_empty())
        .collect();
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    for paragraph in paragraphs {
        if !current.is_empty() && current.chars().count() + paragraph.chars().count() > budget_chars
        {
            chunks.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(paragraph);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_break_on_paragraphs_and_never_mid_sentence() {
        let script = "One.\n\nTwo two two.\n\nThree.";
        assert_eq!(
            chunk_script(script, 10),
            vec!["One.", "Two two two.", "Three."]
        );
        // Comfortably under budget: one pass, not three.
        assert_eq!(chunk_script(script, 1000).len(), 1);
    }

    #[test]
    fn an_over_long_paragraph_is_its_own_chunk_rather_than_being_cut() {
        // An over-long pass is recoverable. Half a sentence is not: the model
        // would be guessing at the end of a beat it cannot see.
        let long = "x".repeat(50);
        let chunks = chunk_script(&format!("short\n\n{long}\n\nshort"), 10);
        assert_eq!(chunks, vec!["short".to_string(), long, "short".to_string()]);
    }

    #[test]
    fn blank_space_is_not_a_paragraph() {
        assert!(chunk_script("   \n\n\n\n  ", 100).is_empty());
        assert!(chunk_script("", 100).is_empty());
    }
}
