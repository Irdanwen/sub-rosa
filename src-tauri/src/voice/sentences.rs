//! A streamed reply cut into sentences a voice can read, as they complete.
//!
//! The reply arrives as markdown that grows (and, on the phone, can retract
//! a few characters before a replay), so the splitter is fed the whole text
//! so far every time and keeps only a cursor: how much of it has already
//! been handed out as sentences, and whether that point sits inside a fenced
//! block. Everything after the cursor is read again on the next call, which
//! is what makes a retraction of unspoken text harmless.
//!
//! What it hands out is plain speech: headings, list markers, emphasis and
//! link targets are dropped, a fenced block (code, a `subrosa:*` card) is
//! named once in a few words instead of read, and a sentence too short to be
//! worth its own request waits for the next one. The first sentence of a
//! reply is what the person waits for, so the minimum is small; a run-on
//! with no full stop is cut at a comma or a space rather than held forever.

/// A sentence shorter than this waits for the next one ("Sure." alone is a
/// whole speech request for one word).
pub const MIN_SENTENCE_CHARS: usize = 24;
/// A run-on longer than this is cut at a comma or a space.
pub const MAX_SENTENCE_CHARS: usize = 280;

/// Where the splitter stands in the reply. `Default` is a fresh reply.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SentenceCursor {
    /// Characters of the reply already handed out (or skipped).
    consumed: usize,
    /// Whether `consumed` sits inside a fenced block.
    in_fence: bool,
}

/// One unit of speech, with what it replaces in the reply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Spoken {
    /// Prose, cleaned for a voice.
    Text(String),
    /// A fenced block was skipped here; the caller says it in its language.
    Fence(String),
}

/// Hands out the sentences of `reply` that are complete since the last call.
/// With `done`, the remainder is handed out too, whatever its length.
pub fn next_sentences(reply: &str, cursor: &mut SentenceCursor, done: bool) -> Vec<Spoken> {
    let chars: Vec<char> = reply.chars().collect();
    let mut out = Vec::new();
    if cursor.consumed > chars.len() {
        // The reply was retracted under what was already said: nothing to
        // take back, wait for it to grow past the cursor again.
        return out;
    }
    loop {
        let rest = &chars[cursor.consumed..];
        if rest.is_empty() {
            break;
        }
        if cursor.in_fence {
            match fence_close(rest) {
                Some(end) => {
                    cursor.consumed += end;
                    cursor.in_fence = false;
                    continue;
                }
                None => {
                    if done {
                        cursor.consumed = chars.len();
                    }
                    break;
                }
            }
        }
        match take_prose(rest, done) {
            Take::Sentence(len, text) => {
                cursor.consumed += len;
                if !text.is_empty() {
                    out.push(Spoken::Text(text));
                }
            }
            Take::Fence {
                before,
                before_len,
                info,
                marker_len,
            } => {
                if !before.is_empty() {
                    out.push(Spoken::Text(before));
                }
                out.push(Spoken::Fence(info));
                cursor.consumed += before_len + marker_len;
                cursor.in_fence = true;
            }
            Take::Wait => break,
        }
    }
    out
}

enum Take {
    /// Consumed this many characters; the cleaned sentence (maybe empty).
    Sentence(usize, String),
    /// Prose before a fence opening, then the fence's info string.
    Fence {
        before: String,
        before_len: usize,
        info: String,
        marker_len: usize,
    },
    Wait,
}

/// Reads prose from the start of `rest` up to the first point worth
/// speaking: a sentence end once the text is long enough, a paragraph break,
/// a fence, or a long run-on's comma.
fn take_prose(rest: &[char], done: bool) -> Take {
    let mut line_start = 0;
    let mut last_soft_break: Option<usize> = None;
    let mut last_space: Option<usize> = None;
    let mut index = 0;
    while index < rest.len() {
        if index == line_start {
            // A line that is (or may become) a fence opening.
            let trimmed = skip_indent(rest, index);
            if starts_with(rest, trimmed, "```") || starts_with(rest, trimmed, "~~~") {
                let Some(newline) = find_newline(rest, trimmed) else {
                    if done {
                        let before = clean(&collect(&rest[..index]));
                        let info = collect(&rest[trimmed + 3..]).trim().to_string();
                        return Take::Fence {
                            before,
                            before_len: index,
                            info,
                            marker_len: rest.len() - index,
                        };
                    }
                    return if index > 0 {
                        // Speak what came before; the fence waits.
                        Take::Sentence(index, clean(&collect(&rest[..index])))
                    } else {
                        Take::Wait
                    };
                };
                let info = collect(&rest[trimmed + 3..newline]).trim().to_string();
                return Take::Fence {
                    before: clean(&collect(&rest[..index])),
                    before_len: index,
                    info,
                    marker_len: newline + 1 - index,
                };
            }
            if trimmed < rest.len() && rest[trimmed] == '`' && trimmed + 3 > rest.len() && !done {
                // "`" or "``" at the end could still become a fence, or be
                // inline code that joins this sentence: wait for the next chunk.
                return Take::Wait;
            }
        }
        let character = rest[index];
        if character == '\n' {
            // A blank line, a heading or a list item ends a sentence: speech
            // pauses where the text breaks.
            let next_blank = rest.get(index + 1) == Some(&'\n');
            let next_block = rest
                .get(index + 1)
                .is_some_and(|next| matches!(next, '#' | '-' | '*' | '+' | '>' | '|'));
            let text = clean(&collect(&rest[..index]));
            if (next_blank || next_block || ends_sentence(&text)) && !text.is_empty() {
                return Take::Sentence(index + 1, text);
            }
            if text.is_empty() {
                return Take::Sentence(index + 1, String::new());
            }
            line_start = index + 1;
            last_space = Some(index);
            index += 1;
            continue;
        }
        if is_terminal(character) {
            let followed_by_space = rest.get(index + 1).is_some_and(|next| next.is_whitespace());
            if followed_by_space && !is_abbreviation(rest, index) {
                let text = clean(&collect(&rest[..=index]));
                if text.chars().count() >= MIN_SENTENCE_CHARS {
                    return Take::Sentence(index + 1, text);
                }
            }
        }
        if matches!(character, ',' | ';' | ':') {
            last_soft_break = Some(index);
        }
        if character == ' ' {
            last_space = Some(index);
        }
        if index + 1 >= MAX_SENTENCE_CHARS {
            if let Some(cut) = last_soft_break.or(last_space).filter(|cut| *cut > 0) {
                return Take::Sentence(cut + 1, clean(&collect(&rest[..=cut])));
            }
        }
        index += 1;
    }
    if done {
        return Take::Sentence(rest.len(), clean(&collect(rest)));
    }
    Take::Wait
}

fn skip_indent(rest: &[char], from: usize) -> usize {
    let mut index = from;
    while index < rest.len() && index - from < 4 && rest[index] == ' ' {
        index += 1;
    }
    index
}

fn starts_with(rest: &[char], at: usize, pattern: &str) -> bool {
    (at..)
        .zip(pattern.chars())
        .all(|(index, expected)| rest.get(index) == Some(&expected))
}

fn find_newline(rest: &[char], from: usize) -> Option<usize> {
    rest[from..]
        .iter()
        .position(|character| *character == '\n')
        .map(|offset| from + offset)
}

/// Where a fenced block ends: just past its closing line.
fn fence_close(rest: &[char]) -> Option<usize> {
    let mut line_start = 0;
    while line_start < rest.len() {
        let newline = find_newline(rest, line_start);
        let trimmed = skip_indent(rest, line_start);
        let line_end = newline.unwrap_or(rest.len());
        let marker = starts_with(rest, trimmed, "```") || starts_with(rest, trimmed, "~~~");
        if marker && collect(&rest[trimmed + 3..line_end]).trim().is_empty() {
            // The closing marker without its newline yet waits.
            return newline.map(|newline| newline + 1);
        }
        line_start = newline? + 1;
    }
    None
}

fn collect(chars: &[char]) -> String {
    chars.iter().collect()
}

fn is_terminal(character: char) -> bool {
    matches!(character, '.' | '!' | '?' | '…' | '。' | '！' | '？')
}

fn ends_sentence(text: &str) -> bool {
    text.chars()
        .last()
        .is_some_and(|last| is_terminal(last) || last == ':')
}

/// "e.g." and "Dr." end with a full stop but not a sentence.
fn is_abbreviation(rest: &[char], dot: usize) -> bool {
    if rest[dot] != '.' {
        return false;
    }
    let mut start = dot;
    while start > 0 && (rest[start - 1].is_alphabetic() || rest[start - 1] == '.') {
        start -= 1;
    }
    let word = collect(&rest[start..=dot]).to_lowercase();
    const ABBREVIATIONS: &[&str] = &[
        "e.g.", "i.e.", "etc.", "vs.", "mr.", "mrs.", "ms.", "dr.", "st.", "no.", "p.", "m.",
        "mme.", "env.", "cf.", "ex.",
    ];
    ABBREVIATIONS.contains(&word.as_str())
        // A single capital and a dot is an initial ("J. Smith").
        || (word.chars().count() == 2 && word.chars().next().is_some_and(char::is_alphabetic))
}

/// Markdown as a voice reads it: one line of plain words.
pub fn clean(markdown: &str) -> String {
    let mut lines = Vec::new();
    for raw in markdown.lines() {
        let mut line = raw.trim();
        if line.is_empty() || line.chars().all(|c| matches!(c, '-' | '*' | '_' | ' ')) {
            continue;
        }
        if line.starts_with('|') {
            // A separator row is never content; a table row reads cell by cell.
            if line.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')) {
                continue;
            }
            let cells: Vec<String> = line
                .trim_matches('|')
                .split('|')
                .map(|cell| inline(cell.trim()))
                .filter(|cell| !cell.is_empty())
                .collect();
            if !cells.is_empty() {
                lines.push(cells.join(", "));
            }
            continue;
        }
        line = line.trim_start_matches('#').trim_start();
        line = line.strip_prefix("> ").unwrap_or(line);
        line = line.strip_prefix('>').unwrap_or(line);
        if let Some(rest) = line
            .strip_prefix("- ")
            .or_else(|| line.strip_prefix("* "))
            .or_else(|| line.strip_prefix("+ "))
        {
            line = rest;
        } else if let Some((number, rest)) = line.split_once(". ").or_else(|| line.split_once(") "))
        {
            if !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()) {
                line = rest;
            }
        }
        let text = inline(line);
        if !text.is_empty() {
            lines.push(text);
        }
    }
    lines.join(" ").trim().to_string()
}

/// Strips the inline markup a voice cannot pronounce.
fn inline(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < chars.len() {
        let character = chars[index];
        // ![alt](url) disappears; [label](url) keeps its label.
        let image = character == '!' && chars.get(index + 1) == Some(&'[');
        if character == '[' || image {
            let open = if image { index + 1 } else { index };
            if let Some(close) = chars[open..].iter().position(|c| *c == ']') {
                let close = open + close;
                if chars.get(close + 1) == Some(&'(') {
                    if let Some(end) = chars[close + 1..].iter().position(|c| *c == ')') {
                        if !image {
                            out.extend(&chars[open + 1..close]);
                        }
                        index = close + 1 + end + 1;
                        continue;
                    }
                }
            }
        }
        if character == '<' {
            // An HTML tag (<br>, </sup>) is markup, not words.
            if let Some(end) = chars[index..].iter().position(|c| *c == '>') {
                let tag = &chars[index + 1..index + end];
                if tag
                    .first()
                    .is_some_and(|first| first.is_ascii_alphabetic() || *first == '/')
                {
                    out.push(' ');
                    index += end + 1;
                    continue;
                }
            }
        }
        if matches!(character, '*' | '`' | '~') {
            index += 1;
            continue;
        }
        if character == '_'
            && (index == 0
                || index + 1 == chars.len()
                || !chars[index - 1].is_alphanumeric()
                || !chars[index + 1].is_alphanumeric())
        {
            // `_emphasis_` goes; snake_case stays.
            index += 1;
            continue;
        }
        out.push(character);
        index += 1;
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(spoken: &[Spoken]) -> Vec<String> {
        spoken
            .iter()
            .map(|unit| match unit {
                Spoken::Text(text) => text.clone(),
                Spoken::Fence(info) => format!("<fence {info}>"),
            })
            .collect()
    }

    /// Feeds `reply` a few characters at a time, as a stream would.
    fn streamed(reply: &str, step: usize) -> Vec<String> {
        let mut cursor = SentenceCursor::default();
        let chars: Vec<char> = reply.chars().collect();
        let mut out = Vec::new();
        let mut end = 0;
        while end < chars.len() {
            end = (end + step).min(chars.len());
            let so_far: String = chars[..end].iter().collect();
            out.extend(texts(&next_sentences(&so_far, &mut cursor, false)));
        }
        out.extend(texts(&next_sentences(reply, &mut cursor, true)));
        out
    }

    #[test]
    fn a_sentence_is_handed_out_as_soon_as_it_completes() {
        let mut cursor = SentenceCursor::default();
        assert!(next_sentences("The weather in Geneva is", &mut cursor, false).is_empty());
        assert_eq!(
            texts(&next_sentences(
                "The weather in Geneva is mild today. Expect",
                &mut cursor,
                false
            )),
            vec!["The weather in Geneva is mild today."]
        );
        assert_eq!(
            texts(&next_sentences(
                "The weather in Geneva is mild today. Expect rain",
                &mut cursor,
                true
            )),
            vec!["Expect rain"]
        );
    }

    #[test]
    fn short_sentences_wait_for_the_next_one() {
        assert_eq!(
            streamed("Sure. Here is the plan for tomorrow morning. Bye.", 3),
            vec!["Sure. Here is the plan for tomorrow morning.", "Bye."]
        );
    }

    #[test]
    fn the_result_does_not_depend_on_how_the_stream_was_cut() {
        let reply = "First, the good news: it works. Second, the bad news is that it costs \
                     more than planned. Third? We wait!\n\nA new paragraph starts here.";
        let whole = streamed(reply, reply.len());
        for step in [1, 2, 5, 17] {
            assert_eq!(streamed(reply, step), whole, "step {step}");
        }
        assert_eq!(whole.len(), 4);
    }

    #[test]
    fn markdown_is_read_as_words() {
        assert_eq!(
            streamed(
                "## Your **three** options\n\n- Take the [train](https://sbb.ch) at `8:02`.\n- Drive, which takes _longer_ than you think.\n",
                4
            ),
            vec![
                "Your three options",
                "Take the train at 8:02.",
                "Drive, which takes longer than you think."
            ]
        );
    }

    #[test]
    fn a_fenced_block_is_named_once_and_skipped() {
        let reply = "Here is the script you asked for:\n```python\nprint('hi.')\nprint('there.')\n```\nRun it twice to be sure it works.";
        for step in [1, 3, 50] {
            assert_eq!(
                streamed(reply, step),
                vec![
                    "Here is the script you asked for:",
                    "<fence python>",
                    "Run it twice to be sure it works."
                ],
                "step {step}"
            );
        }
    }

    #[test]
    fn an_unclosed_fence_at_the_end_is_dropped() {
        let mut cursor = SentenceCursor::default();
        let reply = "Look at this card, it lists them all.\n```subrosa:places\n{\"places\": [";
        assert_eq!(
            texts(&next_sentences(reply, &mut cursor, true)),
            vec![
                "Look at this card, it lists them all.",
                "<fence subrosa:places>"
            ]
        );
    }

    #[test]
    fn abbreviations_and_decimals_do_not_end_a_sentence() {
        assert_eq!(
            streamed(
                "Bring fruit, e.g. apples, and pay 3.50 francs to Dr. Rossi tonight. Done.",
                2
            ),
            vec![
                "Bring fruit, e.g. apples, and pay 3.50 francs to Dr. Rossi tonight.",
                "Done."
            ]
        );
    }

    #[test]
    fn a_run_on_is_cut_at_a_comma() {
        let long = format!("{}, and then it keeps going", "word ".repeat(60));
        let out = streamed(&long, 7);
        assert!(out.len() >= 2, "{out:?}");
        assert!(out
            .iter()
            .all(|part| part.chars().count() <= MAX_SENTENCE_CHARS));
        assert_eq!(
            out.join(" ").split_whitespace().count(),
            long.split_whitespace().count()
        );
    }

    #[test]
    fn a_retraction_of_unspoken_text_is_harmless() {
        let mut cursor = SentenceCursor::default();
        assert_eq!(
            texts(&next_sentences(
                "This first sentence is long enough. And a draft that",
                &mut cursor,
                false
            ))
            .len(),
            1
        );
        // The stream takes back its tail and writes it again differently.
        assert!(next_sentences(
            "This first sentence is long enough. And a",
            &mut cursor,
            false
        )
        .is_empty());
        assert_eq!(
            texts(&next_sentences(
                "This first sentence is long enough. And a better ending.",
                &mut cursor,
                true
            )),
            vec!["And a better ending."]
        );
        // Shorter than what was already said: nothing, and no panic.
        assert!(next_sentences("This", &mut cursor, true).is_empty());
    }

    #[test]
    fn a_table_reads_cell_by_cell() {
        assert_eq!(
            clean("| City | Rain |\n| --- | --- |\n| Geneva | 3 mm |"),
            "City, Rain Geneva, 3 mm"
        );
        assert_eq!(clean("1. First step"), "First step");
        assert_eq!(clean("> quoted *line*"), "quoted line");
        assert_eq!(
            clean("keep snake_case and a<br>break"),
            "keep snake_case and a break"
        );
        assert_eq!(clean("![chart](x.png) Sales grew"), "Sales grew");
    }
}
