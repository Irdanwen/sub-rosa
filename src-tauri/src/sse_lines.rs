//! Reading a streamed chat completion: splitting it into lines as its chunks
//! arrive, and knowing whether it finished.
//!
//! Every reader of a streamed chat completion used to decode each network
//! chunk on its own and then look for newlines in the text. A chunk boundary
//! can fall inside a multi-byte character, and decoding half a character turns
//! it into a replacement character for good, so an accented word could arrive
//! mangled. Splitting on the `\n` byte first and decoding whole lines is exact:
//! that byte never occurs inside a UTF-8 sequence.
//!
//! A stream can also stop early: the upstream breaks, the phone locks. A reply
//! read up to that point looks like a short answer, so every reader checks the
//! stream said it was over (a `finish_reason`, or `[DONE]`) before trusting
//! what it read.

use crate::domain::types::AppError;

/// Collects the chunks of an SSE body and hands back its complete lines.
#[derive(Debug, Default)]
pub struct SseLines {
    pending: Vec<u8>,
    /// Longest partial line to keep, if any. A reader that only wants small
    /// frames (the usage tap) sets it so one enormous line cannot grow the
    /// buffer without bound; an over-long line is dropped whole.
    max_line_bytes: Option<usize>,
    /// True while discarding the rest of an over-long line.
    skipping: bool,
}

impl SseLines {
    /// A splitter that drops any line longer than `max_line_bytes` instead of
    /// buffering it.
    #[must_use]
    pub fn bounded(max_line_bytes: usize) -> Self {
        Self {
            max_line_bytes: Some(max_line_bytes),
            ..Self::default()
        }
    }

    /// Appends a chunk and returns every line it completed, without the
    /// newline. A trailing partial line waits for the next chunk.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut lines = Vec::new();
        let mut rest = chunk;
        while let Some(newline) = rest.iter().position(|&byte| byte == b'\n') {
            let (line, tail) = rest.split_at(newline);
            rest = &tail[1..];
            if self.skipping {
                self.skipping = false;
                continue;
            }
            if self.pending.is_empty() {
                lines.push(String::from_utf8_lossy(line).into_owned());
            } else {
                self.pending.extend_from_slice(line);
                let whole = std::mem::take(&mut self.pending);
                lines.push(String::from_utf8_lossy(&whole).into_owned());
            }
        }
        if !self.skipping {
            self.pending.extend_from_slice(rest);
            if self
                .max_line_bytes
                .is_some_and(|max| self.pending.len() > max)
            {
                self.pending = Vec::new();
                self.skipping = true;
            }
        }
        lines
    }

    /// The final line, when the stream ended without a newline after it.
    pub fn finish(&mut self) -> Option<String> {
        if self.skipping || self.pending.is_empty() {
            return None;
        }
        let rest = std::mem::take(&mut self.pending);
        Some(String::from_utf8_lossy(&rest).into_owned())
    }
}

/// The JSON payload of one `data:` line. `None` for blank lines, comments,
/// other fields, the `[DONE]` sentinel and anything that is not JSON.
#[must_use]
pub fn data_frame(line: &str) -> Option<serde_json::Value> {
    let data = line.trim().strip_prefix("data:")?.trim();
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    serde_json::from_str(data).ok()
}

/// Where a reader gets the chunks of a streamed body from: the sidecar's
/// response in the app, a script in tests.
pub(crate) trait ChunkSource {
    /// The next chunk, `None` once the body has ended, an error if it broke.
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, AppError>;
}

impl ChunkSource for crate::june_api::AgentChatCompletionsResponse {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, AppError> {
        self.chunk().await
    }
}

/// The frames of a streamed chat completion, and whether it said it was over.
#[derive(Debug, Default)]
pub struct CompletionFrames {
    lines: SseLines,
    finished: bool,
}

impl CompletionFrames {
    /// Appends a chunk and returns the JSON frames it completed.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<serde_json::Value> {
        let lines = self.lines.push(chunk);
        lines.iter().filter_map(|line| self.frame(line)).collect()
    }

    /// The last frame, when the stream ended without a newline after it.
    pub fn finish(&mut self) -> Option<serde_json::Value> {
        let line = self.lines.finish()?;
        self.frame(&line)
    }

    /// True once a choice carried a `finish_reason` or `[DONE]` arrived. A
    /// stream that ends before either was cut short, whatever it held.
    #[must_use]
    pub fn is_finished(&self) -> bool {
        self.finished
    }

    fn frame(&mut self, line: &str) -> Option<serde_json::Value> {
        if line.trim().strip_prefix("data:").map(str::trim) == Some("[DONE]") {
            self.finished = true;
            return None;
        }
        let frame = data_frame(line)?;
        let finishes = frame
            .get("choices")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|choices| {
                choices.iter().any(|choice| {
                    choice
                        .get("finish_reason")
                        .is_some_and(|reason| !reason.is_null())
                })
            });
        self.finished |= finishes;
        Some(frame)
    }
}

/// The error for a stream that ended before it said it was over. What arrived
/// is a fragment, never a shorter answer.
#[must_use]
pub fn cut_off_reply() -> AppError {
    AppError::new(
        "reply_cut_off",
        "The reply stopped before it was finished. Try again.",
    )
}

/// Reads a streamed completion's text to its end, handing each chunk's new
/// text to `on_delta` as it arrives. Fails if the body broke or ended before
/// the completion said it was finished.
pub(crate) async fn read_content(
    source: &mut impl ChunkSource,
    mut on_delta: impl FnMut(&str),
) -> Result<String, AppError> {
    let mut frames = CompletionFrames::default();
    let mut collected = String::new();
    while let Some(chunk) = source.next_chunk().await? {
        let before = collected.len();
        for frame in frames.push(&chunk) {
            push_content(&mut collected, &frame);
        }
        if collected.len() > before {
            on_delta(&collected[before..]);
        }
    }
    if let Some(frame) = frames.finish() {
        let before = collected.len();
        push_content(&mut collected, &frame);
        if collected.len() > before {
            on_delta(&collected[before..]);
        }
    }
    if !frames.is_finished() {
        return Err(cut_off_reply());
    }
    Ok(collected)
}

fn push_content(collected: &mut String, frame: &serde_json::Value) {
    if let Some(delta) = frame
        .pointer("/choices/0/delta/content")
        .and_then(serde_json::Value::as_str)
    {
        collected.push_str(delta);
    }
}

/// A body played from a script, for tests.
#[cfg(test)]
pub(crate) struct ScriptedChunks(pub std::collections::VecDeque<Result<Vec<u8>, AppError>>);

#[cfg(test)]
impl ScriptedChunks {
    pub(crate) fn of(chunks: &[&str]) -> Self {
        Self(
            chunks
                .iter()
                .map(|chunk| Ok(chunk.as_bytes().to_vec()))
                .collect(),
        )
    }

    /// The same chunks, then a read error.
    pub(crate) fn broken(chunks: &[&str]) -> Self {
        let mut script = Self::of(chunks);
        script.0.push_back(Err(AppError::new(
            "june_request_failed",
            "connection reset",
        )));
        script
    }
}

#[cfg(test)]
impl ChunkSource for ScriptedChunks {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, AppError> {
        self.0.pop_front().transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::{data_frame, read_content, CompletionFrames, ScriptedChunks, SseLines};

    const HI: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n";

    #[tokio::test]
    async fn a_finished_stream_reads_whole_including_a_last_frame_without_newline() {
        let mut deltas = Vec::new();
        let text = read_content(
            &mut ScriptedChunks::of(&[
                HI,
                "data: {\"choices\":[{\"delta\":{\"content\":\" there\"},\"finish_reason\":\"stop\"}]}",
            ]),
            |delta| deltas.push(delta.to_string()),
        )
        .await
        .expect("a finished stream");
        assert_eq!(text, "hi there");
        assert_eq!(deltas, ["hi", " there"]);
    }

    #[tokio::test]
    async fn a_stream_that_ends_without_finishing_is_cut_off_not_short() {
        let error = read_content(&mut ScriptedChunks::of(&[HI]), |_| {})
            .await
            .expect_err("no finish_reason and no [DONE]");
        assert_eq!(error.code, "reply_cut_off");
    }

    #[tokio::test]
    async fn a_broken_stream_is_an_error() {
        let error = read_content(&mut ScriptedChunks::broken(&[HI]), |_| {})
            .await
            .expect_err("the body broke");
        assert_eq!(error.code, "june_request_failed");
    }

    #[test]
    fn done_or_a_finish_reason_ends_a_stream() {
        let mut frames = CompletionFrames::default();
        frames.push(HI.as_bytes());
        assert!(!frames.is_finished());
        frames.push(b"data: [DONE]\n\n");
        assert!(frames.is_finished());

        let mut frames = CompletionFrames::default();
        frames.push(b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":null}]}\n\n");
        assert!(!frames.is_finished(), "a null finish_reason is not an end");
        frames.push(b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n");
        assert!(frames.is_finished());
    }

    #[test]
    fn a_character_cut_between_two_chunks_stays_whole() {
        let line = "data: {\"choices\":[{\"delta\":{\"content\":\"café\"}}]}\n".as_bytes();
        // "é" is two bytes; cut between them.
        let cut = line
            .windows(2)
            .position(|pair| pair == "é".as_bytes())
            .expect("é")
            + 1;
        let mut lines = SseLines::default();
        assert!(lines.push(&line[..cut]).is_empty());
        let complete = lines.push(&line[cut..]);
        assert_eq!(complete.len(), 1);
        let frame = data_frame(&complete[0]).expect("frame");
        assert_eq!(frame["choices"][0]["delta"]["content"], "café");
    }

    #[test]
    fn splits_several_lines_and_keeps_the_tail() {
        let mut lines = SseLines::default();
        assert_eq!(
            lines.push(b"data: 1\r\n\r\ndata: 2\n\nda"),
            ["data: 1\r", "\r", "data: 2", ""]
        );
        assert_eq!(lines.push(b"ta: 3"), Vec::<String>::new());
        assert_eq!(lines.finish().as_deref(), Some("data: 3"));
    }

    #[test]
    fn a_bounded_splitter_drops_an_over_long_line_and_recovers() {
        let mut lines = SseLines::bounded(8);
        assert!(lines.push(b"data: 0123456789").is_empty());
        assert!(lines.push(b"abcdef").is_empty());
        assert_eq!(lines.push(b"xyz\ndata: ok\n"), ["data: ok"]);
        assert_eq!(lines.finish(), None);
    }

    #[test]
    fn data_frame_skips_what_is_not_a_json_payload() {
        assert!(data_frame("data: [DONE]").is_none());
        assert!(data_frame(": keep-alive").is_none());
        assert!(data_frame("").is_none());
        assert!(data_frame("data: not json").is_none());
        assert_eq!(data_frame("data:{\"a\":1}").expect("frame")["a"], 1);
    }
}
