# ADR-0114: A refused render is queued again, and a settling one is heard, not polled

Date: 2026-10-17. Status: accepted. Builds on
[ADR-0018](0018-ios-background-work-is-durable-rows.md) and
[ADR-0021](0021-workflow-runs-are-durable-rows-stitched-by-the-webview.md).
First of the workflow engine decisions taken while bringing the Studio's
workflows level with ComfyUI (plan of 2026-10-17); the scheduler, partial
runs and failure isolation will be recorded as an addendum when they land.

## Context

A workflow hands every long render (video, music, a heavy image, queued
speech) to a `media_jobs` row that Rust submits, polls and files. Three
weaknesses showed up when the engine was compared with ComfyUI's request
layer (`comfy_api_nodes/util/client.py`):

- **A rate limit killed the node.** The native queue command classified 402
  and 429 as definite, uncharged refusals, but threw a plain message. The
  engine's outage patience (402/503, `transient.ts`) never recognised it, and
  even if it had, retrying reused the job id written before the submission:
  the unique id is the submission claim, so the second attempt got the
  refused row back and sent nothing.
- **Bursts were unbounded.** A production of twelve shots fired twelve paid
  POSTs at the same instant, across however many runs were alive in the
  webview. That is how a provider's rate limit is met.
- **Waiting polled.** Each waiting node read the whole `media_jobs` table
  every three seconds; eight renders meant eight full reads every three
  seconds, while Rust already emits an event on every row change.

ComfyUI answers these with an idempotency key on every POST, a separate 429
budget honouring `Retry-After`, and a WebSocket progress stream. Carpe Diem
does not accept an idempotency key today.

## Decision

1. **A definite 429 or 402 at submission is queued again, under a new job
   id.** Nothing was charged (that is what "definite" means in
   `definite_queue_rejection`), so a new submission cannot pay twice. The
   native command now returns the refusal with `details: { status,
   retryAfterMs }` and records it without a system notification (the caller
   is in the foreground and is about to retry). The webview waits the
   provider's own `Retry-After` (capped at 150 s per attempt) or the outage
   patience's next step, within the same budget (`transientWaitMs`, ten
   minutes by default), then dismisses the refused row and submits again
   with its pointer written first. A 5xx at submission stays *uncertain* and
   is never retried, exactly as before: the paid request may have been
   accepted.
2. **Paid submissions pass through one module-wide gate of two slots.**
   Only the POST holds a slot; renders still run in parallel once queued, so
   a production is no slower, only less bursty. Module-wide, because several
   runs (a canvas run, a production, a resumed run) share one webview.
3. **A render is heard settling.** The wait listens for the row event, reads
   the rows once when it starts listening (the job may have settled
   already), again when the app comes back to the foreground (iOS freezes
   the webview and events do not queue, ADR-0018), and on a thirty-second
   safety timer in case an event was missed.

## Consequences

- A rate-limited production finishes instead of failing at the first
  refusal; the node shows its wait like any other render.
- The table is read a handful of times per render instead of every three
  seconds per render.
- The refused row stays until its replacement is being queued, so a run
  cancelled during the wait resumes onto a definite failure rather than a
  pointer to nothing.
- Without an idempotency key from the provider, an uncertain submission
  still cannot be retried safely. The request is recorded in
  `docs/carpe-diem-parity-requests.md`; when it lands, uncertain
  submissions can be retried under the same key.

## Alternatives rejected

- **Retrying the same job id.** The id is the submission claim; reusing it
  returns the refused row, by design.
- **Capping concurrent renders.** It would slow every production that the
  provider is happy to run in parallel, to protect against a limit that a
  rate-limit retry already handles.
- **Sizing the gate from `/api_keys/rate_limits`.** The response's shape for
  queue limits is not documented; a fixed, small gate plus honouring
  `Retry-After` is honest without it.
