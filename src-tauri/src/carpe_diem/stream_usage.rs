//! Metering a streamed completion from its own frames (ADR-0063).
//!
//! A buffered turn arrives with its metering in `x-june-*` headers. A streamed
//! one cannot: the sidecar answers before the usage exists. The upstream still
//! puts `usage` in its last SSE frame, so the proxy reads it there as the body
//! passes through, one line at a time, without holding the body.

use super::cache_stats::TurnUsage;
use crate::sse_lines::{data_frame, SseLines};

/// The longest SSE line the tap keeps. A usage frame is a few hundred bytes;
/// anything longer is a content or tool-call frame it has no use for.
const MAX_LINE_BYTES: usize = 64 * 1024;

/// Watches a streamed body for its usage frame. Earlier frames may carry
/// `usage: null`, so the last real one wins.
#[derive(Debug)]
pub(crate) struct StreamUsageTap {
    lines: SseLines,
    usage: Option<TurnUsage>,
}

impl StreamUsageTap {
    fn new() -> Self {
        Self {
            lines: SseLines::bounded(MAX_LINE_BYTES),
            usage: None,
        }
    }

    pub(crate) fn feed(&mut self, chunk: &[u8]) {
        for line in self.lines.push(chunk) {
            self.scan(&line);
        }
    }

    /// Counts the usage found in the prompt-cache ledger, once the body has
    /// been read to its end. A turn abandoned halfway is never recorded: its
    /// billing frame, which comes last, was not seen.
    pub(crate) fn record(self) {
        if let Some(usage) = self.finish() {
            super::cache_stats::record(usage);
        }
    }

    /// The usage found, once the body has been read to its end.
    fn finish(mut self) -> Option<TurnUsage> {
        if let Some(line) = self.lines.finish() {
            self.scan(&line);
        }
        self.usage
    }

    fn scan(&mut self, line: &str) {
        // Thousands of delta frames go past per turn; only the billing frame
        // is worth parsing.
        if !line.contains("\"usage\"") {
            return;
        }
        if let Some(usage) = data_frame(line)
            .as_ref()
            .and_then(|frame| frame.get("usage"))
            .and_then(turn_usage_from_value)
        {
            self.usage = Some(usage);
        }
    }
}

/// Where a turn's metering comes from. The sidecar's headers win whenever it
/// sent them; only a successful streamed turn without them is read from its
/// body.
pub(crate) fn usage_tap_for(
    status: u16,
    header_usage: TurnUsage,
    content_type: &str,
) -> Option<StreamUsageTap> {
    ((200..300).contains(&status)
        && !header_usage.is_measured()
        && content_type.contains("event-stream"))
    .then(StreamUsageTap::new)
}

/// Reads an upstream `usage` object the way the sidecar does: the two token
/// totals are required, the cache split and the operator's micro-USDC numbers
/// default to zero.
fn turn_usage_from_value(usage: &serde_json::Value) -> Option<TurnUsage> {
    let field = |value: Option<&serde_json::Value>, key: &str| {
        value
            .and_then(|value| value.get(key))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
    };
    let details = usage.get("prompt_tokens_details");
    Some(TurnUsage {
        prompt_tokens: usage.get("prompt_tokens")?.as_u64()?,
        completion_tokens: usage.get("completion_tokens")?.as_u64()?,
        cached_tokens: field(details, "cached_tokens"),
        cache_creation_tokens: field(details, "cache_creation_input_tokens"),
        cache_saved_usdc_micro: field(Some(usage), "carpe_cache_saved_usdc_micro"),
        cost_usdc_micro: field(Some(usage), "carpe_cost_usdc_micro"),
    })
}

#[cfg(test)]
mod tests {
    use super::{usage_tap_for, TurnUsage};

    /// A streamed turn carries no metering headers; its usage is read from the
    /// final SSE frame as the body passes through, even when that frame is cut
    /// between two chunks.
    #[test]
    fn a_streamed_turn_without_headers_is_metered_from_its_last_frame() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}],\"usage\":null}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":8000,\"completion_tokens\":20,",
            "\"prompt_tokens_details\":{\"cached_tokens\":7500},\"carpe_cost_usdc_micro\":9100}}\n\n",
            "data: [DONE]\n\n"
        )
        .as_bytes();
        for cut in 1..body.len() {
            let mut tap = usage_tap_for(200, TurnUsage::default(), "text/event-stream")
                .expect("a streamed turn");
            tap.feed(&body[..cut]);
            tap.feed(&body[cut..]);

            let usage = tap.finish().expect("usage");
            assert_eq!(usage.prompt_tokens, 8_000, "cut at {cut}");
            assert_eq!(usage.completion_tokens, 20, "cut at {cut}");
            assert_eq!(usage.cached_tokens, 7_500, "cut at {cut}");
            assert_eq!(usage.cost_usdc_micro, 9_100, "cut at {cut}");
        }
    }

    /// When the sidecar did meter the turn in headers, those numbers are the
    /// ones counted and the body is never scanned: a turn is counted once.
    #[test]
    fn metering_headers_take_precedence_over_the_stream() {
        let from_headers = TurnUsage {
            prompt_tokens: 10,
            completion_tokens: 2,
            ..TurnUsage::default()
        };

        assert!(usage_tap_for(200, from_headers, "text/event-stream").is_none());
        // A buffered JSON answer without headers has no stream to read either.
        assert!(usage_tap_for(200, TurnUsage::default(), "application/json").is_none());
        // Nor does an error.
        assert!(usage_tap_for(502, TurnUsage::default(), "text/event-stream").is_none());
    }

    #[test]
    fn a_stream_without_a_usage_frame_is_unmeasured() {
        let mut tap = usage_tap_for(200, TurnUsage::default(), "text/event-stream").expect("tap");
        tap.feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n");
        assert_eq!(tap.finish(), None);
    }
}
