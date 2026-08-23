//! Reading published captions into timed turns.
//!
//! When a source already publishes captions, taking them is free, instant and
//! better than paying to transcribe audio somebody has already transcribed
//! (ADR-0028). And because a caption cue carries its own start and end, the
//! result drops straight into the turn model — which means chapters are
//! timestamped for a recording nobody paid a single transcription credit for.
//!
//! WebVTT and SubRip differ in three details and agree on everything else, so
//! one parser reads both: `-->` between two clocks, a blank line between cues,
//! and the text in between.

use crate::domain::types::AppError;

/// One caption, as a turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cue {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// Parse a WebVTT or SubRip document into cues, in order.
///
/// Auto-generated captions are messy in ways worth handling here rather than
/// downstream: rolling duplicates, inline timing tags, speaker markup, and
/// cue settings appended to the timing line.
pub fn parse_cues(document: &str) -> Result<Vec<Cue>, AppError> {
    let mut cues: Vec<Cue> = Vec::new();
    let mut pending: Option<(i64, i64)> = None;
    let mut buffer: Vec<String> = Vec::new();

    let flush = |cues: &mut Vec<Cue>, bounds: Option<(i64, i64)>, buffer: &mut Vec<String>| {
        let Some((start_ms, end_ms)) = bounds else {
            buffer.clear();
            return;
        };
        let text = clean_text(&buffer.join(" "));
        buffer.clear();
        // Only degenerate cues are dropped: empty ones, and ones that cover
        // no time at all. There was a minimum duration here, and it was the
        // wrong tool — the rolling-repeat collapse below already removes the
        // duplicates it was aimed at, by text, while a duration threshold
        // silently loses a real one-word answer.
        if text.is_empty() || end_ms <= start_ms {
            return;
        }
        // Rolling captions repeat the previous line with one word added. Keep
        // the longer of the two rather than stuttering through the transcript.
        if let Some(last) = cues.last_mut() {
            if text.starts_with(last.text.as_str()) && last.end_ms >= start_ms {
                last.text = text;
                last.end_ms = end_ms.max(last.end_ms);
                return;
            }
            if last.text == text {
                last.end_ms = end_ms.max(last.end_ms);
                return;
            }
        }
        cues.push(Cue {
            start_ms,
            end_ms,
            text,
        });
    };

    for line in document.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            flush(&mut cues, pending.take(), &mut buffer);
            continue;
        }
        if let Some(bounds) = parse_timing(trimmed) {
            // A timing line always starts a new cue, even without a blank line
            // before it, which auto-captions sometimes omit.
            flush(&mut cues, pending.take(), &mut buffer);
            pending = Some(bounds);
            continue;
        }
        // Headers, cue identifiers and NOTE blocks before any timing line.
        if pending.is_none() {
            continue;
        }
        buffer.push(trimmed.to_string());
    }
    flush(&mut cues, pending.take(), &mut buffer);

    if cues.is_empty() {
        return Err(AppError::new(
            "captions_empty",
            "Those captions had nothing readable in them.",
        ));
    }
    Ok(cues)
}

/// `00:01:02.500 --> 00:01:05.000 align:start position:0%` and the SubRip
/// comma form, with or without an hour.
fn parse_timing(line: &str) -> Option<(i64, i64)> {
    let (start, rest) = line.split_once("-->")?;
    // Cue settings follow the end time, separated by whitespace.
    let end = rest.split_whitespace().next()?;
    let start_ms = parse_clock(start.trim())?;
    let end_ms = parse_clock(end)?;
    if end_ms < start_ms {
        return None;
    }
    Some((start_ms, end_ms))
}

fn parse_clock(value: &str) -> Option<i64> {
    let value = value.trim().replace(',', ".");
    let (clock, fraction) = match value.split_once('.') {
        Some((clock, fraction)) => (clock, fraction),
        None => (value.as_str(), "0"),
    };
    let parts: Vec<&str> = clock.split(':').collect();
    let (hours, minutes, seconds) = match parts.as_slice() {
        [hours, minutes, seconds] => (
            hours.parse::<i64>().ok()?,
            minutes.parse::<i64>().ok()?,
            seconds.parse::<i64>().ok()?,
        ),
        [minutes, seconds] => (
            0,
            minutes.parse::<i64>().ok()?,
            seconds.parse::<i64>().ok()?,
        ),
        _ => return None,
    };
    if !(0..60).contains(&minutes) || !(0..60).contains(&seconds) || hours < 0 {
        return None;
    }
    // Three digits is milliseconds, two is centiseconds; anything else is
    // padded or truncated to milliseconds.
    let millis: i64 = format!("{fraction:0<3}")
        .chars()
        .take(3)
        .collect::<String>()
        .parse()
        .unwrap_or(0);
    Some(((hours * 60 + minutes) * 60 + seconds) * 1000 + millis)
}

/// Strip the markup captions carry: inline timing tags, speaker tags, and the
/// HTML entities that survive them.
fn clean_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_tag = false;
    for character in raw.chars() {
        match character {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(character),
            _ => {}
        }
    }
    let out = out
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The joined text of every cue, for the note generator.
pub fn joined_text(cues: &[Cue]) -> String {
    cues.iter()
        .map(|cue| cue.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const VTT: &str = "WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:04.500
Welcome to the show.

2
00:00:04.500 --> 00:00:09.000 align:start position:0%
Today we are talking about <c.colorE5E5E5>pricing</c>.

00:01:02.250 --> 00:01:05.000
And then it got interesting.
";

    #[test]
    fn reads_cues_with_their_own_times() {
        let cues = parse_cues(VTT).unwrap();

        assert_eq!(cues.len(), 3);
        assert_eq!(cues[0].start_ms, 1_000);
        assert_eq!(cues[0].end_ms, 4_500);
        assert_eq!(cues[0].text, "Welcome to the show.");
        assert_eq!(cues[2].start_ms, 62_250);
    }

    #[test]
    fn strips_the_markup_captions_carry() {
        let cues = parse_cues(VTT).unwrap();
        assert_eq!(cues[1].text, "Today we are talking about pricing.");
    }

    #[test]
    fn reads_subrip_as_well_as_webvtt() {
        let srt = "1\n00:00:01,000 --> 00:00:03,000\nFirst line.\n\n2\n00:00:03,000 --> 00:00:06,000\nSecond line.\n";

        let cues = parse_cues(srt).unwrap();

        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].end_ms, 3_000);
        assert_eq!(cues[1].text, "Second line.");
    }

    #[test]
    fn collapses_the_rolling_repeats_auto_captions_produce() {
        // This is what YouTube's automatic captions actually look like: each
        // cue repeats the last one with a word added.
        let rolling = "WEBVTT

00:00:00.000 --> 00:00:01.000
so the

00:00:01.000 --> 00:00:02.000
so the thing

00:00:02.000 --> 00:00:03.000
so the thing is

00:00:03.500 --> 00:00:05.000
a completely new sentence
";

        let cues = parse_cues(rolling).unwrap();

        assert_eq!(
            cues.iter().map(|cue| cue.text.as_str()).collect::<Vec<_>>(),
            vec!["so the thing is", "a completely new sentence"]
        );
        // The collapsed cue keeps the whole span it covered.
        assert_eq!(cues[0].start_ms, 0);
        assert_eq!(cues[0].end_ms, 3_000);
    }

    #[test]
    fn a_cue_with_no_text_is_dropped_rather_than_persisted_empty() {
        let cues = parse_cues("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n\n\n00:00:02.000 --> 00:00:04.000\nReal text.\n").unwrap();

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Real text.");
    }

    #[test]
    fn timings_without_an_hour_still_parse() {
        let cues = parse_cues("WEBVTT\n\n01:02.500 --> 01:05.000\nShort form.\n").unwrap();
        assert_eq!(cues[0].start_ms, 62_500);
    }

    #[test]
    fn a_short_cue_with_real_words_is_kept() {
        // There used to be a minimum duration here. A one-word answer is
        // short and is still content: only a cue covering no time at all is
        // dropped.
        let short = "WEBVTT\n\n00:00:01.000 --> 00:00:01.050\nYes.\n\n00:00:02.000 --> 00:00:02.030\nExactly.\n";

        let cues = parse_cues(short).unwrap();

        assert_eq!(
            cues.iter().map(|cue| cue.text.as_str()).collect::<Vec<_>>(),
            vec!["Yes.", "Exactly."]
        );
    }

    #[test]
    fn a_cue_covering_no_time_at_all_is_dropped() {
        let degenerate = "WEBVTT\n\n00:00:01.000 --> 00:00:01.000\nZero length.\n\n00:00:02.000 --> 00:00:04.000\nReal.\n";

        let cues = parse_cues(degenerate).unwrap();

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Real.");
    }

    #[test]
    fn a_document_with_no_cues_says_so() {
        assert_eq!(parse_cues("WEBVTT\n\n").unwrap_err().code, "captions_empty");
        assert_eq!(
            parse_cues("<html>not captions</html>").unwrap_err().code,
            "captions_empty"
        );
    }

    #[test]
    fn a_backwards_timing_line_is_not_treated_as_one() {
        // A malformed cue must not swallow the ones after it.
        let cues = parse_cues(
            "WEBVTT\n\n00:00:09.000 --> 00:00:01.000\nBackwards.\n\n00:00:10.000 --> 00:00:12.000\nFine.\n",
        )
        .unwrap();

        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Fine.");
    }

    #[test]
    fn the_joined_text_is_what_the_note_generator_reads() {
        let cues = parse_cues(VTT).unwrap();
        let joined = joined_text(&cues);
        assert!(joined.starts_with("Welcome to the show."));
        assert!(joined.ends_with("And then it got interesting."));
    }
}
