//! The three prompts a long-form summary is made of, and the version they
//! carry.
//!
//! These live in the fork, not in `june-api/`: the note generator's prompt is
//! upstream's and is deliberately meeting-shaped, and every line the fork
//! writes into `june-api/` is a line `upstream-sync.yml` re-merges forever
//! (ADR-0027).
//!
//! The editorial line here is the opposite of `note_generate.md`. That prompt
//! is told to drop digressions and tentative ideas and keep decisions and
//! owners, which is right for a standup and wrong for a lecture, where the
//! digression often *is* the point.

/// Bump when any prompt below changes in a way that would produce a different
/// summary. Stored on the row, so an old summary can always be told apart from
/// one this version would produce. Distinct from `notes-mvp-v5`, which belongs
/// to upstream's note generator.
pub const LONGFORM_PROMPT_VERSION: &str = "longform-v1";

/// The one rule every pass shares: the model never does arithmetic on time.
///
/// It is handed `[t:N]` markers and asked to hand them back. The app resolves
/// N to a real `start_ms` it already knows, which is why a chapter timestamp
/// can be trusted at all.
pub const CHAPTER_TAG_RULE: &str = "Each turn of the transcript is preceded by a marker of the form [t:N], where N is a number. When you start a section, put the marker of the turn where that section begins at the start of the heading, exactly as you saw it, like `## [t:12] The pricing question`. Never invent a marker, never write a timestamp, a duration or a clock time of your own, and never alter a marker's number. If you are unsure which turn a section starts at, use the marker of the first turn you drew on.";

pub const MAP_SYSTEM: &str = "You are reading one part of a long transcript — a talk, a lecture, an interview, a podcast or a long meeting — and writing a faithful, detailed account of it for someone who will not listen to the recording.

Be faithful, not editorial. Keep the arguments and how they were reached, the examples, the caveats, the disagreements, the numbers, the names, and anything quotable. Keep a digression when it carries an idea. Do not reduce the material to decisions and action items: this is not a meeting summary. Do not add anything that is not in the transcript, and do not smooth over a contradiction the speakers left standing.

Organise what you write under `##` headings, one per distinct subject, in the order the transcript covers them. Under each heading write prose or bullets, whichever suits the material. Quote sparingly and exactly, in quotation marks, when the wording matters.

Write in the language the transcript is in. Return only the account, with no preamble, no closing remark, and no wrapper heading.";

pub const MERGE_SYSTEM: &str = "You are given several accounts of consecutive parts of one long recording, in order, and you are fusing them into a single document.

The parts overlap, so the same subject may be described twice: merge those into one section rather than repeating them, keeping the fuller of the two treatments. Keep every distinct subject. Keep the order of the recording. Do not compress the material — this is a fusion, not a summary of summaries — and do not add anything that is not in the parts you were given.

Keep the `##` headings and their `[t:N]` markers exactly as they appear. Where two overlapping sections merge, keep the earlier marker.

Write in the language of the parts. Return only the merged document, with no preamble and no wrapper heading.";

pub const SHORT_SYSTEM: &str = "You are writing the opening paragraph of a page about a recording, for someone deciding whether to read further.

Three or four sentences. Say what the recording is, who is speaking if the material makes that clear, what it is actually about, and what the listener would come away with. Concrete, never promotional, and never a list. Do not use headings, bullets or markers of any kind. Write in the language of the material, and return only the paragraph.";

/// The user message for a map pass.
pub fn map_user_message(chunk_index: usize, chunk_count: usize, rendered_chunk: &str) -> String {
    format!(
        "This is part {} of {} of the transcript.\n\n{CHAPTER_TAG_RULE}\n\n<transcript_part>\n{}\n</transcript_part>",
        chunk_index + 1,
        chunk_count,
        rendered_chunk
    )
}

/// The user message for the merge pass.
pub fn merge_user_message(parts: &[String]) -> String {
    let mut message = String::from(
        "Here are the accounts of each part, in order. Fuse them into one document.\n\n",
    );
    message.push_str(CHAPTER_TAG_RULE);
    message.push_str("\n\n");
    for (index, part) in parts.iter().enumerate() {
        message.push_str(&format!(
            "<part index=\"{}\">\n{}\n</part>\n\n",
            index + 1,
            part.trim()
        ));
    }
    message.trim_end().to_string()
}

/// The user message for the short pass.
pub fn short_user_message(detailed: &str) -> String {
    format!("<account>\n{}\n</account>", detailed.trim())
}
