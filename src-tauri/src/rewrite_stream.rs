//! One streamed rewrite, from the request to the text that comes back.
//!
//! Shared by the note editor's rewrites (`note_ai`) and Studio's
//! (`studio_ai`). Both follow ADR-0038: the model returns text, the text is a
//! proposal the person accepts or discards, and the run is transient - it
//! lives in this process, streams its deltas so a long rewrite is watchable,
//! and can be stopped from the screen that started it.
//!
//! What differs between the two is the prompt, the event channel and the error
//! codes, so those are the parameters. Everything that decides whether a reply
//! is safe to hand back - a broken stream is an error, an empty reply is an
//! error, a fence around the whole answer is stripped - is written once here.

use crate::domain::types::AppError;
use crate::june_api;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

/// Where a run reports, and the errors it reports with.
///
/// The errors are functions rather than a code prefix so each caller writes
/// its own `AppError::new` with a literal code and sentence: that is the
/// shape `scripts/i18n/rust-messages.mjs` collects for the French catalog, and
/// the frontend matches on the codes.
#[derive(Clone, Copy)]
pub struct Channel {
    /// The event the phases and deltas are emitted on.
    pub event: &'static str,
    pub already_running: fn() -> AppError,
    pub cancelled: fn() -> AppError,
    pub empty_reply: fn() -> AppError,
    /// The upstream answered with a status outside 2xx.
    pub failed: fn(u16) -> AppError,
}

/// The chat completion a run asks for.
pub struct Completion<'a> {
    pub model: String,
    pub system: &'a str,
    pub user: &'a str,
    pub max_tokens: u32,
    pub temperature: f32,
}

/// The rewrites running in this process right now, each with the handle that
/// stops it.
///
/// A `Notify` rather than a flag the loop polls: a flag is only read between
/// chunks, so cancelling a stream that has stalled would do nothing until the
/// provider sent something - which is exactly when a person reaches for the
/// stop button. The run selects on it, so cancelling lands immediately, and
/// dropping the response closes the connection.
///
/// This is also the run registry, which is why a second rewrite under the same
/// id is refused rather than raced. Callers choose ids that cannot collide
/// across features (`note-rewrite-…`, `studio-rewrite-…`).
static RUNNING: std::sync::LazyLock<Mutex<HashMap<String, Arc<Notify>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn running() -> MutexGuard<'static, HashMap<String, Arc<Notify>>> {
    RUNNING.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// RAII claim over one request id. Whatever ends the run - success, failure,
/// cancellation - releases it, so the id can be used again.
struct RunClaim {
    request_id: String,
    stop: Arc<Notify>,
}

impl RunClaim {
    /// `None` when a rewrite is already running under this id.
    fn take(request_id: &str) -> Option<Self> {
        let stop = Arc::new(Notify::new());
        let mut running = running();
        if running.contains_key(request_id) {
            return None;
        }
        running.insert(request_id.to_string(), Arc::clone(&stop));
        Some(Self {
            request_id: request_id.to_string(),
            stop,
        })
    }
}

impl Drop for RunClaim {
    fn drop(&mut self) {
        running().remove(&self.request_id);
    }
}

/// Stop a run. A no-op for an id that is not running, which is what a second
/// tap on a stop button looks like.
pub fn cancel(request_id: &str) {
    if let Some(stop) = running().get(request_id) {
        // `notify_one` stores a permit, so a cancel that arrives between two
        // chunks is still waiting when the run next reaches the select.
        stop.notify_one();
    }
}

fn emit(app: &AppHandle, channel: Channel, request_id: &str, phase: &str, text: Option<&str>) {
    let _ = app.emit(
        channel.event,
        serde_json::json!({ "requestId": request_id, "phase": phase, "text": text }),
    );
}

/// Run one rewrite. Returns the whole reply; the deltas emitted on the way are
/// a preview, not the answer.
pub async fn run(
    app: &AppHandle,
    channel: Channel,
    request_id: &str,
    completion: Completion<'_>,
) -> Result<String, AppError> {
    let Some(claim) = RunClaim::take(request_id) else {
        return Err((channel.already_running)());
    };
    emit(app, channel, request_id, "started", None);
    let outcome = stream(app, channel, request_id, &completion, &claim).await;
    match &outcome {
        Ok(text) => emit(app, channel, request_id, "done", Some(text)),
        Err(error) => emit(app, channel, request_id, "failed", Some(&error.message)),
    }
    outcome
}

async fn stream(
    app: &AppHandle,
    channel: Channel,
    request_id: &str,
    completion: &Completion<'_>,
    claim: &RunClaim,
) -> Result<String, AppError> {
    let mut response = june_api::proxy_agent_chat_completions(serde_json::json!({
        "model": completion.model,
        "messages": [
            { "role": "system", "content": completion.system },
            { "role": "user", "content": completion.user }
        ],
        "temperature": completion.temperature,
        "max_tokens": completion.max_tokens,
        "stream": true
    }))
    .await?;

    if !(200..300).contains(&response.status) {
        return Err((channel.failed)(response.status));
    }

    // A route that ignored `stream` answers with ordinary JSON. Same fallback
    // agent_lite makes, for the same reason: some upstream rails do.
    if !response.content_type.contains("event-stream") {
        let body = response.collect_body().await?;
        return finish(channel, extract_whole(&body));
    }

    // A stream that breaks or stops before it says it is finished is an
    // error: a fragment must never replace the text it was rewriting.
    let read = crate::sse_lines::read_content(&mut response, |delta| {
        emit(app, channel, request_id, "delta", Some(delta));
    });
    tokio::select! {
        // Cancelling wins the race even mid-chunk. Returning here drops
        // `response`, which closes the connection, so the upstream stops
        // generating rather than finishing into a void.
        () = claim.stop.notified() => {
            Err((channel.cancelled)())
        }
        text = read => finish(channel, Some(text?)),
    }
}

fn extract_whole(body: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    june_api::extract_chat_completion_text(&value)
}

/// Trim the wrapper a model sometimes puts around an answer it was told not to
/// wrap, and refuse an empty one rather than replacing text with nothing.
fn finish(channel: Channel, text: Option<String>) -> Result<String, AppError> {
    let text = text
        .map(|text| strip_wrapping_fence(text.trim()))
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err((channel.empty_reply)());
    }
    Ok(text)
}

/// A fence around the *whole* reply is the model wrapping its answer, not
/// content: a passage that is genuinely one code block keeps its fence because
/// the opening line then carries a language or the body contains a blank line
/// the naive check would not survive. Only the unmistakable case is stripped.
pub fn strip_wrapping_fence(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() < 3 {
        return text.to_string();
    }
    let first = lines[0].trim();
    let last = lines[lines.len() - 1].trim();
    let opens_bare_markdown = first == "```"
        || first.eq_ignore_ascii_case("```markdown")
        || first.eq_ignore_ascii_case("```md");
    if !opens_bare_markdown || last != "```" {
        return text.to_string();
    }
    // A fence inside the body means the reply really is a document containing
    // code, and the outer pair is still the wrapper - but a second bare fence
    // would make the strip ambiguous, so leave it alone.
    if lines[1..lines.len() - 1]
        .iter()
        .any(|line| line.trim().starts_with("```"))
    {
        return text.to_string();
    }
    lines[1..lines.len() - 1].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHANNEL: Channel = Channel {
        event: "test://rewrite",
        already_running: || AppError::new("test_rewrite_already_running", "Running."),
        cancelled: || AppError::new("test_rewrite_cancelled", "Stopped."),
        empty_reply: || AppError::new("test_rewrite_empty_reply", "Empty."),
        failed: |_| AppError::new("test_rewrite_failed", "Failed."),
    };

    #[test]
    fn strips_a_fence_the_model_wrapped_the_whole_answer_in() {
        assert_eq!(
            strip_wrapping_fence("```markdown\n# Title\n\nBody\n```"),
            "# Title\n\nBody"
        );
        assert_eq!(
            strip_wrapping_fence("```\n- one\n- two\n```"),
            "- one\n- two"
        );
    }

    #[test]
    fn keeps_a_fence_that_is_the_content() {
        let code = "```rust\nfn main() {}\n```";
        assert_eq!(strip_wrapping_fence(code), code);
    }

    #[test]
    fn an_empty_reply_is_an_error_named_after_the_channel() {
        let error = finish(CHANNEL, Some("  \n".into())).unwrap_err();
        assert_eq!(error.code, "test_rewrite_empty_reply");
        assert!(finish(CHANNEL, None).is_err());
    }

    #[test]
    fn a_second_claim_on_a_running_id_is_refused_until_the_first_ends() {
        let first = RunClaim::take("rewrite-stream-test").expect("first claim");
        assert!(RunClaim::take("rewrite-stream-test").is_none());
        drop(first);
        assert!(RunClaim::take("rewrite-stream-test").is_some());
    }
}
