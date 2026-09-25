//! Relaying a streamed agent chat completion as it arrives (ADR-0063).
//!
//! The upstream's SSE bytes go to the client untouched, chunk by chunk. On the
//! way through, a line scanner watches for the `usage` object the upstream puts
//! in its final frame, so the turn can still be metered once the stream is
//! over. The scanner never holds more than one partial line.

use crate::venice::token_usage_from_value;
use bytes::Bytes;
use futures_core::Stream;
use june_domain::{AgentChatStream, TokenUsage};
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::sync::oneshot;

/// The longest partial line the scanner keeps while waiting for its newline.
/// A usage frame is a few hundred bytes; a line longer than this is a content
/// or tool-call frame, which the scanner has no use for, so it is skipped
/// rather than accumulated.
const MAX_PENDING_LINE_BYTES: usize = 256 * 1024;

/// Finds the last non-null `usage` object in an SSE stream fed to it in
/// arbitrary chunks. A line may be cut anywhere between two chunks, including
/// inside a multi-byte character: lines are split on the `\n` byte, which never
/// occurs inside a UTF-8 sequence, and only complete lines are parsed.
#[derive(Debug, Default)]
pub(crate) struct SseUsageScanner {
    pending: Vec<u8>,
    /// True while discarding the rest of an over-long line.
    skipping: bool,
    usage: Option<TokenUsage>,
}

impl SseUsageScanner {
    pub(crate) fn feed(&mut self, chunk: &[u8]) {
        let mut rest = chunk;
        while let Some(newline) = rest.iter().position(|&byte| byte == b'\n') {
            let (line, tail) = rest.split_at(newline);
            rest = &tail[1..];
            if self.skipping {
                self.skipping = false;
                continue;
            }
            if self.pending.is_empty() {
                self.scan_line(line);
            } else {
                self.pending.extend_from_slice(line);
                let line = std::mem::take(&mut self.pending);
                self.scan_line(&line);
            }
        }
        if self.skipping {
            return;
        }
        self.pending.extend_from_slice(rest);
        if self.pending.len() > MAX_PENDING_LINE_BYTES {
            self.pending = Vec::new();
            self.skipping = true;
        }
    }

    /// The usage seen so far, after scanning a final line the stream ended
    /// without terminating.
    pub(crate) fn finish(&mut self) -> Option<TokenUsage> {
        if !self.skipping && !self.pending.is_empty() {
            let line = std::mem::take(&mut self.pending);
            self.scan_line(&line);
        }
        self.usage
    }

    fn scan_line(&mut self, line: &[u8]) {
        let Some(data) = line.trim_ascii().strip_prefix(b"data:") else {
            return;
        };
        // Only the billing frame is worth parsing; every other frame is a
        // delta, and there are thousands of them per turn.
        if !data.windows(7).any(|window| window == b"\"usage\"") {
            return;
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(data.trim_ascii()) else {
            return;
        };
        // `usage: null` rides on every delta frame of some upstreams; keep the
        // last real one.
        if let Some(usage) = value.get("usage").and_then(token_usage_from_value) {
            self.usage = Some(usage);
        }
    }
}

/// Wraps an upstream SSE response into a streamed completion whose usage
/// resolves when the relay ends, however it ends.
pub(crate) fn relay_sse(
    response: reqwest::Response,
    content_type: String,
    provider: &str,
    model: &str,
) -> AgentChatStream {
    let (report, usage) = oneshot::channel();
    let relay = MeteredRelay {
        upstream: Box::pin(response.bytes_stream()),
        scanner: SseUsageScanner::default(),
        report: Some(report),
        model: model.to_string(),
    };
    AgentChatStream {
        body: Box::pin(relay),
        content_type,
        provider: provider.to_string(),
        // The relay reports on every exit path, drop included, so a closed
        // channel cannot happen in practice; default to zero rather than hang.
        usage: Box::pin(async move { usage.await.unwrap_or_default() }),
    }
}

type UpstreamBytes = Pin<Box<dyn Stream<Item = reqwest::Result<Bytes>> + Send>>;

/// The upstream byte stream, relayed item for item, with the usage scanner in
/// the path. It reports the usage exactly once: when the upstream ends, when a
/// read fails, or when the client stops listening and the relay is dropped.
struct MeteredRelay {
    upstream: UpstreamBytes,
    scanner: SseUsageScanner,
    report: Option<oneshot::Sender<TokenUsage>>,
    model: String,
}

impl MeteredRelay {
    fn report(&mut self) {
        let Some(report) = self.report.take() else {
            return;
        };
        let usage = self.scanner.finish().unwrap_or_else(|| {
            tracing::warn!(
                model = %self.model,
                "venice: streamed agent chat carried no usage frame, metering as zero"
            );
            TokenUsage::default()
        });
        // The receiver is gone only if nobody is settling this turn.
        let _ = report.send(usage);
    }
}

impl Stream for MeteredRelay {
    type Item = Bytes;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Bytes>> {
        if self.report.is_none() {
            return Poll::Ready(None);
        }
        match self.upstream.as_mut().poll_next(context) {
            Poll::Ready(Some(Ok(chunk))) => {
                self.scanner.feed(&chunk);
                Poll::Ready(Some(chunk))
            }
            Poll::Ready(Some(Err(error))) => {
                // Not replayed: the generation already ran (and billed)
                // upstream. End the stream where it broke and settle on what
                // was seen.
                tracing::error!(%error, model = %self.model, "venice: agent chat stream read failed");
                self.report();
                Poll::Ready(None)
            }
            Poll::Ready(None) => {
                self.report();
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for MeteredRelay {
    fn drop(&mut self) {
        if self.report.is_some() {
            // The client left before the end. Settle on the usage seen so far
            // (usually none: the billing frame comes last) rather than keep
            // reading a generation nobody will see.
            tracing::info!(
                model = %self.model,
                "venice: agent chat stream dropped before its end, settling on the usage seen"
            );
            self.report();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SseUsageScanner;
    use june_domain::TokenUsage;
    use pretty_assertions::assert_eq;

    fn scan(chunks: &[&[u8]]) -> Option<TokenUsage> {
        let mut scanner = SseUsageScanner::default();
        for chunk in chunks {
            scanner.feed(chunk);
        }
        scanner.finish()
    }

    #[test]
    fn reads_a_usage_frame_cut_between_two_chunks() {
        let frame = b"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":4,\"prompt_tokens_details\":{\"cached_tokens\":8}}}\n\ndata: [DONE]\n\n";
        for cut in 1..frame.len() {
            let (head, tail) = frame.split_at(cut);
            let usage = scan(&[head, tail]).expect("usage survives the cut");
            assert_eq!(usage.prompt_tokens, 12, "cut at {cut}");
            assert_eq!(usage.completion_tokens, 4, "cut at {cut}");
            assert_eq!(usage.cached_tokens, 8, "cut at {cut}");
        }
    }

    #[test]
    fn keeps_the_last_non_null_usage() {
        let usage = scan(&[
            b"data: {\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\r\n\r\n",
            b"data: {\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":3}}\n\n",
            b"data: {\"choices\":[{\"delta\":{}}],\"usage\":null}\n\n",
            b"data: [DONE]\n\n",
        ])
        .expect("usage");
        assert_eq!((usage.prompt_tokens, usage.completion_tokens), (9, 3));
    }

    #[test]
    fn reads_a_final_frame_without_a_trailing_newline() {
        let usage = scan(&[b"data: {\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":5}}"])
            .expect("usage");
        assert_eq!(usage.completion_tokens, 5);
    }

    #[test]
    fn a_stream_without_usage_reads_as_none() {
        assert_eq!(
            scan(&[b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n"]),
            None
        );
    }

    #[test]
    fn an_over_long_line_is_skipped_without_losing_the_next_frame() {
        let mut long = b"data: {\"choices\":[{\"delta\":{\"content\":\"".to_vec();
        long.extend(std::iter::repeat_n(
            b'x',
            super::MAX_PENDING_LINE_BYTES + 10,
        ));
        let mut scanner = SseUsageScanner::default();
        for piece in long.chunks(4096) {
            scanner.feed(piece);
        }
        assert!(scanner.pending.len() <= super::MAX_PENDING_LINE_BYTES);
        scanner
            .feed(b"\"}}]}\n\ndata: {\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n");
        let usage = scanner.finish().expect("usage after the skipped line");
        assert_eq!(usage.prompt_tokens, 3);
    }
}
