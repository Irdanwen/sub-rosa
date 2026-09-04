# ADR 0041: Dictation is a latency budget, not a pipeline

- Status: accepted
- Date: 2026-09-03

## Context

`docs/index.md` has carried "Dictation ADR: the low-latency request shape and
charge timing" as a gap since June, and `src-tauri/src/dictation.rs` grew to
5 800 lines of decisions with no page that states them. This records what the
code already does, so that the next change to it is made against a reason
and not against a habit. CONTEXT.md defines the term: dictation is the
push-to-talk mode where a short phrase becomes cleaned text in the foreground
app within a few hundred milliseconds; it is distinct from note transcription.

## Decision

**Dictation is designed from the user's wait backwards.** Every stage has a
budget, every budget has a reason, and when a budget is exceeded the fallback
is the raw transcript rather than nothing.

- **Two requests, not one.** The audio goes to `/v1/audio/transcriptions`
  (the fast path) and the text then goes through a cleanup completion that
  punctuates, drops fillers and applies the spoken formatting words
  ("comma", "new paragraph", "quote"). The transcript is what the user said;
  the cleanup is what they meant to type. Splitting them means a cleanup
  that fails or times out still pastes the transcript.
- **The cleanup budget scales with the text.** A flat budget silently
  degraded long dictations (JUN-212: the call timed out, cleanup was skipped,
  unpunctuated text was pasted). The budget is a base of 15 s plus 5 ms per
  input byte, capped at 60 s overall and 30 s per request, the latter because
  June API's cleanup billing hold expires at 30 s and a response that arrives
  after its hold could paste text whose charge never settles.
- **Long dictations are cleaned in chunks of about 800 bytes.** Measured
  against the production prompt: the cleanup model punctuates 800-byte
  passages of filler-heavy speech reliably and at 2 KB and beyond echoes the
  input back unpunctuated. A chunk under 300 bytes may legitimately be one
  sentence, so a cleaned result without sentence punctuation there is not
  taken as the echo failure and is not retried.
- **The charge follows the request.** The transcription is metered when the
  audio is sent; the cleanup is metered when its completion returns. There is
  no hold across the two: a dictation whose cleanup is abandoned costs the
  transcription only.
- **The foreground app is reached through a helper, not the webview.** On
  macOS `june-dictation-helper` (Swift) owns the global shortcut, the
  microphone level, the paste into the active app and the accessibility
  permission; the shell talks to it over stdin/stdout and shows the HUD.
  Windows has no helper yet, and the settings say so through the capability
  map (`diagnostics::capabilities`). On iPhone, `dictation_mobile.rs` runs the
  same two requests without a helper and hands the text to the share sheet
  or the note.
- **The app context shapes the cleanup.** When the paste target is a known
  kind of app (email is the only one recognised today), a slug goes with the
  cleanup request so the text is laid out for that surface.
- **Everything is logged as an event line**, capped by
  `app_paths::open_capped_log`, because dictation failures are timing
  failures and the only way to see one is the sequence of timestamps.

## Alternatives considered

- **One request that transcribes and cleans.** Simpler, but a single failure
  loses the transcript, and the fast path's latency would be set by the
  slowest model.
- **Streaming ASR.** ADR 0002 keeps the live preview a companion of note
  transcription; dictation phrases are seconds long, and a stream would not
  return the first token sooner than the whole request does.
- **Cleanup in the webview.** The helper is where the paste happens and the
  shell is where the budgets are enforced; a third place would have to be
  kept in step with both.

## Consequences

- A change to any budget constant in `dictation.rs` is a change to this ADR,
  or an addendum.
- The chunk sizes are tied to the production cleanup prompt; a prompt change
  re-measures them.
- The Windows helper remains the largest single gap in the platform map and
  is tracked in `docs/roadmap.md`.
