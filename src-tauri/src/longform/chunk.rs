//! Cutting a long transcript into chunks a model can read, on turn boundaries.
//!
//! The obvious implementation splits on character count. It is also the wrong
//! one: a cut lands mid-sentence, the two halves each lose the thought, and
//! the output carries no time information because the input carried none.
//!
//! A Sub Rosa transcript is not flat text. Every row knows its source, its
//! `start_ms`, its `end_ms` and its `turn_index` — so a chunk can end where a
//! speaker stopped, overlap the previous chunk by whole turns, and know
//! exactly which stretch of the recording it covers. That is what lets a
//! chapter carry a timestamp the app computed rather than one a model guessed
//! (ADR-0027).
//!
//! Where turn bounds are missing — an import transcribed as one continuous
//! source — the chunker degrades to paragraph boundaries and produces untimed
//! chunks, which yield an untimed summary rather than a wrong one.

/// Roughly four characters per token, so a 24k-character chunk is about 6k
/// tokens of transcript. Deliberately far below any model's context: the map
/// prompt, the overlap and the model's own reasoning all share that window,
/// and a chunk that is merely large produces a summary that is merely vague.
pub const CHUNK_BUDGET_CHARS: usize = 24_000;

/// Turns replayed at the start of the next chunk so a thought that straddles a
/// boundary is visible whole to at least one pass.
pub const OVERLAP_TURNS: usize = 2;

/// A transcript turn, as the chunker sees it. `index` is the position the
/// model is shown and the app resolves back to a time — never the database's
/// `turn_index`, which restarts per recording session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    pub index: usize,
    pub source: Option<String>,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub text: String,
}

/// A contiguous run of turns, with the stretch of recording it covers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub turns: Vec<Turn>,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
}

impl Chunk {
    pub fn first_index(&self) -> usize {
        self.turns.first().map(|turn| turn.index).unwrap_or(0)
    }

    pub fn last_index(&self) -> usize {
        self.turns.last().map(|turn| turn.index).unwrap_or(0)
    }

    /// The chunk as the model reads it: one labelled block per turn, tagged
    /// with the index a chapter heading may point back at.
    pub fn render(&self) -> String {
        let mut rendered = String::new();
        for turn in &self.turns {
            rendered.push_str(&format!("[t:{}]", turn.index));
            if let Some(source) = turn.source.as_deref().filter(|value| !value.is_empty()) {
                rendered.push_str(&format!(" ({source})"));
            }
            rendered.push('\n');
            rendered.push_str(turn.text.trim());
            rendered.push_str("\n\n");
        }
        rendered.trim_end().to_string()
    }
}

/// Build the ordered turn list from transcript rows.
///
/// Rows are ordered by start time when they have one, and by their existing
/// order otherwise. A row with no bounds and a long body is split on blank
/// lines so a single continuous transcript still chunks somewhere sensible.
pub fn turns_from_rows<'a>(rows: impl IntoIterator<Item = TranscriptRow<'a>>) -> Vec<Turn> {
    let mut rows: Vec<TranscriptRow<'a>> = rows
        .into_iter()
        .filter(|row| !row.text.trim().is_empty())
        .collect();
    // Stable so rows without a start time keep the order they arrived in.
    rows.sort_by_key(|row| {
        (
            row.start_ms.unwrap_or(i64::MAX),
            row.turn_index.unwrap_or(0),
        )
    });

    let mut turns = Vec::new();
    for row in rows {
        if row.start_ms.is_some() {
            push_turn(&mut turns, row.source, row.start_ms, row.end_ms, row.text);
            continue;
        }
        // One continuous, untimed transcript: paragraphs are the only
        // boundaries there are.
        for paragraph in split_paragraphs(row.text) {
            push_turn(&mut turns, row.source, None, None, paragraph);
        }
    }
    turns
}

/// A transcript row as it comes out of the database.
#[derive(Debug, Clone, Copy)]
pub struct TranscriptRow<'a> {
    pub text: &'a str,
    pub source: Option<&'a str>,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub turn_index: Option<i64>,
}

fn push_turn(
    turns: &mut Vec<Turn>,
    source: Option<&str>,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    text: &str,
) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    turns.push(Turn {
        index: turns.len(),
        source: source.map(str::to_string),
        start_ms,
        end_ms,
        text: text.to_string(),
    });
}

fn split_paragraphs(text: &str) -> Vec<&str> {
    let paragraphs: Vec<&str> = text
        .split("\n\n")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect();
    if paragraphs.len() > 1 {
        return paragraphs;
    }
    // No blank lines at all: single lines are the next best boundary, and a
    // transcript with neither stays whole.
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect();
    if lines.len() > 1 {
        lines
    } else {
        vec![text.trim()]
    }
}

/// Group turns into overlapping chunks that each fit `budget_chars`.
///
/// Guarantees, in order of how badly breaking them would hurt:
/// 1. Every turn appears in at least one chunk, in order.
/// 2. No chunk is empty, so a single turn larger than the budget becomes its
///    own oversized chunk instead of vanishing.
/// 3. Each chunk starts strictly later than the previous one started, so the
///    overlap can never stall the walk.
pub fn chunk_turns(turns: &[Turn], budget_chars: usize, overlap_turns: usize) -> Vec<Chunk> {
    let budget = budget_chars.max(1);
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut start = 0_usize;
    while start < turns.len() {
        let mut end = start;
        let mut size = 0_usize;
        while end < turns.len() {
            let turn_chars = turns[end].text.chars().count();
            // Always take at least one turn: a turn past the budget on its own
            // is still better handled than dropped.
            if end > start && size + turn_chars > budget {
                break;
            }
            size += turn_chars;
            end += 1;
        }
        let slice = &turns[start..end];
        chunks.push(Chunk {
            turns: slice.to_vec(),
            start_ms: slice.iter().filter_map(|turn| turn.start_ms).min(),
            end_ms: slice.iter().filter_map(|turn| turn.end_ms).max(),
        });
        if end >= turns.len() {
            break;
        }
        // Step back for the overlap, but never back to (or before) this
        // chunk's own start.
        let step_back = overlap_turns.min(end.saturating_sub(start).saturating_sub(1));
        start = (end - step_back).max(start + 1);
    }
    chunks
}

/// `hh:mm:ss` for a chapter heading, or `mm:ss` under an hour.
pub fn format_timestamp(ms: i64) -> String {
    let total_seconds = (ms.max(0) / 1_000) as u64;
    let (hours, minutes, seconds) = (
        total_seconds / 3_600,
        (total_seconds % 3_600) / 60,
        total_seconds % 60,
    );
    if hours > 0 {
        format!("{hours:02}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(index: usize, start_ms: Option<i64>, text: &str) -> Turn {
        Turn {
            index,
            source: Some("microphone".to_string()),
            start_ms,
            end_ms: start_ms.map(|value| value + 1_000),
            text: text.to_string(),
        }
    }

    fn turns_of(count: usize, chars: usize) -> Vec<Turn> {
        (0..count)
            .map(|index| turn(index, Some(index as i64 * 1_000), &"x".repeat(chars)))
            .collect()
    }

    #[test]
    fn chunks_never_cut_a_turn_in_half() {
        let turns = turns_of(10, 100);
        let chunks = chunk_turns(&turns, 250, 0);

        for chunk in &chunks {
            for chunk_turn in &chunk.turns {
                // Every turn is present whole, exactly as it was.
                assert!(turns.contains(chunk_turn));
            }
        }
        // 250 chars of budget holds two 100-char turns, not three.
        assert!(chunks.iter().all(|chunk| chunk.turns.len() <= 2));
    }

    #[test]
    fn every_turn_appears_in_order_and_none_is_lost() {
        let turns = turns_of(37, 300);
        let chunks = chunk_turns(&turns, 1_000, OVERLAP_TURNS);

        let mut seen: Vec<usize> = chunks
            .iter()
            .flat_map(|chunk| chunk.turns.iter().map(|turn| turn.index))
            .collect();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen, (0..37).collect::<Vec<_>>());
        // Chunks are ordered and strictly advancing.
        for pair in chunks.windows(2) {
            assert!(pair[1].first_index() > pair[0].first_index());
        }
    }

    #[test]
    fn consecutive_chunks_overlap_so_a_straddling_thought_is_seen_whole() {
        let turns = turns_of(12, 300);
        let chunks = chunk_turns(&turns, 900, 2);

        assert!(chunks.len() > 1);
        for pair in chunks.windows(2) {
            let previous_tail = pair[0].last_index();
            assert!(
                pair[1].first_index() <= previous_tail,
                "chunk starting at {} does not overlap the one ending at {previous_tail}",
                pair[1].first_index()
            );
        }
    }

    #[test]
    fn a_turn_larger_than_the_budget_becomes_its_own_chunk_rather_than_vanishing() {
        let turns = vec![
            turn(0, Some(0), &"a".repeat(50)),
            turn(1, Some(1_000), &"b".repeat(5_000)),
            turn(2, Some(2_000), &"c".repeat(50)),
        ];

        let chunks = chunk_turns(&turns, 200, 0);

        let indices: Vec<usize> = chunks
            .iter()
            .flat_map(|chunk| chunk.turns.iter().map(|turn| turn.index))
            .collect();
        assert!(indices.contains(&1), "the oversized turn was dropped");
        assert!(chunks.iter().all(|chunk| !chunk.turns.is_empty()));
    }

    #[test]
    fn overlap_can_never_stall_the_walk() {
        // Overlap larger than any chunk: without the guard this loops forever.
        let turns = turns_of(20, 300);
        let chunks = chunk_turns(&turns, 600, 50);

        assert!(!chunks.is_empty());
        assert_eq!(chunks.last().unwrap().last_index(), 19);
        for pair in chunks.windows(2) {
            assert!(pair[1].first_index() > pair[0].first_index());
        }
    }

    #[test]
    fn a_chunk_knows_the_stretch_of_recording_it_covers() {
        let turns = turns_of(6, 300);
        let chunks = chunk_turns(&turns, 900, 0);

        let first = &chunks[0];
        assert_eq!(first.start_ms, Some(0));
        assert_eq!(first.end_ms, Some(3_000));
    }

    #[test]
    fn an_untimed_transcript_chunks_on_paragraphs_instead() {
        let text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
        let turns = turns_from_rows([TranscriptRow {
            text,
            source: None,
            start_ms: None,
            end_ms: None,
            turn_index: None,
        }]);

        assert_eq!(turns.len(), 3);
        assert!(turns.iter().all(|turn| turn.start_ms.is_none()));
        assert_eq!(turns[1].text, "Second paragraph.");
    }

    #[test]
    fn rows_are_ordered_by_time_and_renumbered_from_zero() {
        let turns = turns_from_rows([
            TranscriptRow {
                text: "later",
                source: Some("system"),
                start_ms: Some(5_000),
                end_ms: Some(6_000),
                turn_index: Some(1),
            },
            TranscriptRow {
                text: "earlier",
                source: Some("microphone"),
                start_ms: Some(1_000),
                end_ms: Some(2_000),
                turn_index: Some(0),
            },
        ]);

        assert_eq!(turns[0].text, "earlier");
        assert_eq!(turns[0].index, 0);
        assert_eq!(turns[1].text, "later");
        assert_eq!(turns[1].index, 1);
    }

    #[test]
    fn the_rendered_chunk_carries_the_index_a_chapter_points_back_at() {
        let chunk = Chunk {
            turns: vec![turn(4, Some(240_000), "We should ship it.")],
            start_ms: Some(240_000),
            end_ms: Some(241_000),
        };

        let rendered = chunk.render();

        assert!(rendered.starts_with("[t:4] (microphone)"));
        assert!(rendered.contains("We should ship it."));
    }

    #[test]
    fn timestamps_drop_the_hour_when_there_is_not_one() {
        assert_eq!(format_timestamp(0), "00:00");
        assert_eq!(format_timestamp(62_000), "01:02");
        assert_eq!(format_timestamp(3_723_000), "01:02:03");
        assert_eq!(format_timestamp(-5), "00:00");
    }
}
