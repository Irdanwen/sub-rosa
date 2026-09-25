//! Splitting a server-sent event stream into lines as its chunks arrive.
//!
//! Every reader of a streamed chat completion used to decode each network
//! chunk on its own and then look for newlines in the text. A chunk boundary
//! can fall inside a multi-byte character, and decoding half a character turns
//! it into a replacement character for good, so an accented word could arrive
//! mangled. Splitting on the `\n` byte first and decoding whole lines is exact:
//! that byte never occurs inside a UTF-8 sequence.

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

#[cfg(test)]
mod tests {
    use super::{data_frame, SseLines};

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
