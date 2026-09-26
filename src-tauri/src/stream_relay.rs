//! Forwarding a streamed completion to the local agent runtime as it arrives.
//!
//! The provider proxy writes its response head before the first chunk, so an
//! upstream failure halfway through can no longer become an error status. It
//! delimits the body by closing the connection (`Connection: close`, no
//! length), which means a bare close reads as a reply that simply ended.

use crate::sse_lines::ChunkSource;
use tokio::io::{AsyncWrite, AsyncWriteExt};

/// Copies the body from `source` to `sink` chunk by chunk until it ends. If
/// the body breaks, an SSE body gets one last `data:` frame carrying an
/// `error` object; an OpenAI-compatible client raises on it rather than
/// keeping the short answer as a finished one.
pub(crate) async fn relay_body(
    sink: &mut (impl AsyncWrite + Unpin),
    source: &mut impl ChunkSource,
    sse: bool,
) -> std::io::Result<()> {
    loop {
        match source.next_chunk().await {
            Ok(Some(chunk)) => sink.write_all(&chunk).await?,
            Ok(None) => return Ok(()),
            Err(error) => {
                eprintln!(
                    "June provider proxy upstream stream failed: {}",
                    error.message
                );
                if sse {
                    sink.write_all(&error_frame(&error.message)).await?;
                }
                return Ok(());
            }
        }
    }
}

fn error_frame(detail: &str) -> Vec<u8> {
    let frame = serde_json::json!({
        "error": {
            "message": format!("The model's reply was cut off: {detail}"),
            "type": "upstream_stream_interrupted",
        }
    });
    format!("data: {frame}\n\n").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::relay_body;
    use crate::sse_lines::{data_frame, ScriptedChunks};

    const HI: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n";

    #[tokio::test]
    async fn a_broken_stream_ends_on_an_error_frame() {
        let mut sink = Vec::new();
        relay_body(&mut sink, &mut ScriptedChunks::broken(&[HI]), true)
            .await
            .expect("relayed");
        let written = String::from_utf8(sink).expect("utf8");
        let tail = written
            .strip_prefix(HI)
            .expect("the delta is relayed first");
        let frame = data_frame(tail.trim_end()).expect("one last frame");
        assert_eq!(frame["error"]["type"], "upstream_stream_interrupted");
        assert!(tail.ends_with("\n\n"), "the frame is complete: {tail:?}");
    }

    #[tokio::test]
    async fn a_finished_stream_is_relayed_untouched() {
        let body = [HI, "data: [DONE]\n\n"];
        let mut sink = Vec::new();
        relay_body(&mut sink, &mut ScriptedChunks::of(&body), true)
            .await
            .expect("relayed");
        assert_eq!(String::from_utf8(sink).expect("utf8"), body.concat());
    }

    /// A buffered JSON body that broke gets nothing appended: an SSE frame
    /// would not make it any more readable.
    #[tokio::test]
    async fn a_broken_json_body_gets_no_frame() {
        let mut sink = Vec::new();
        relay_body(&mut sink, &mut ScriptedChunks::broken(&["{\"id\":"]), false)
            .await
            .expect("relayed");
        assert_eq!(sink, b"{\"id\":");
    }
}
