---
status: accepted
date: 2026-07-22
---

# june-api normalizes the Carpe Diem `/router` rail into the Venice/OpenAI contract

## Context

Sub Rosa's sidecar (`june-api`, the Venice proxy) can be pointed at either of
Carpe Diem's two rails via `carpe-diem.json` `base_url` (the "V1/Router endpoint
choice" shipped in v1.26.0):

- **`/api/operator/v1`** — Venice-shaped. `message.content` is `""` for reasoning
  models; honors `stream: true` with a real `text/event-stream`.
- **`/api/operator/router`** — the best-price rail, OpenRouter-shaped.

`june-api` was written against Venice's `/v1` semantics. On the `/router` rail it
broke inference two different ways, both intermittently (the desktop brain
defaults to a **reasoning** model, `kimi-k3`):

1. **`content: null`.** For reasoning models whose visible answer is empty (the
   text lives in `reasoning`), `/router` returns `message.content: null`.
   `usage_from_chat_body` bound the whole typed `ChatCompletionResponse` (whose
   `content` was a required `String`) just to read the usage frame, so a valid
   HTTP 200 collapsed into a fatal `upstream_provider_failed` (502). Reproduced:
   direct `/router` curl = 8/8 OK, but through the sidecar = 4/8 (the failures
   are the turns where `content` came back null).

2. **`stream: true` is ignored.** `/router` answers a streaming request with a
   single buffered `application/json` `chat.completion` (not SSE). The sidecar
   relayed that `application/json` body to a client that had asked for a stream
   (both the desktop Hermes agent and mobile agent-lite do), which surfaced as
   *"Provider returned an empty stream with no finish_reason"*.

Both are the same root cause: assuming Venice `/v1` response semantics on a rail
that does not share them. Non-reasoning models (e.g. `llama-3.3-70b`) always
return string content and were unaffected, which is why the failure looked
model-specific and flaky.

## Decision

Make the agent-chat proxy (`VeniceChat::complete_raw_once`) **rail-agnostic** by
normalizing the upstream response to the contract the caller expects, instead of
requiring Venice's shape:

1. **A successful upstream 200 never becomes a client-facing error.** The
   generation already ran (and billed) upstream. Usage is now read off a lenient
   `serde_json::Value` (`usage` is a top-level sibling of `choices`), decoupled
   from the message shape; if it is genuinely unreadable we log and meter as
   zero rather than fail the delivered generation. `ChatCompletionMessage.content`
   also became `Option<String>` so the note-generation path (`complete_once`)
   tolerates null too.

2. **Synthesize SSE when the client asked to stream but the upstream did not.**
   If `stream: true` and the upstream body is not `text/event-stream`, rebuild it
   into the `/v1`-shaped SSE frames (a content/reasoning chunk preserving
   `reasoning_content`, a finish chunk, an optional usage frame, `[DONE]`). The
   guard is content-type driven, so `/v1` SSE and non-streaming clients pass
   through untouched, and the path is forward-compatible if `/router` later gains
   real streaming.

## Consequences

- **`/router` works end-to-end.** Validated against the live rail: `kimi-k3`
  non-stream 8/8 200 (was ~50% 502) and `stream: true` 8/8 valid SSE with
  `finish_reason` + `[DONE]` (was "empty stream"); reconstructed `content` and
  `reasoning_content` are faithful.
- **Buffered, not token-by-token.** `june-api` already buffers the full upstream
  body before returning (true for `/v1` SSE today), so synthesizing a buffered
  SSE introduces no latency regression. Real incremental streaming would require
  rearchitecting the proxy and is out of scope (followup).
- **Metering.** The only behavior change is that an unreadable usage frame on a
  200 meters as zero instead of failing the request. This is inert in the
  fork's local mode (no billing) and strictly better for the user; it does not
  touch the `/v1` client contract, so the hosted-June backward-compatibility
  boundary holds. Both shells benefit (desktop and iOS `june-embed` share this
  code).
- **`n > 1`** completions project only `choices[0]` in the synthesized stream —
  the agents request a single completion.

## Alternatives considered

- **Pin the app to `/v1`.** Restores chat but forfeits the best-price routing the
  `/router` rail exists to provide. Rejected: the goal was to make `/router` work.
- **Switch the desktop default model off reasoning models.** Sidesteps the null
  content but is a product regression and leaves the streaming mismatch unfixed.
- **True streaming passthrough.** Correct long-term but a larger rearchitecture;
  deferred, and unnecessary for correctness since the proxy already buffers.

Supersedes nothing; complements [ADR-0012](0012-upstream-rate-limit-distinct-from-provider-failure.md)
(there the upstream genuinely 5xx'd and a backed-off retry was right; here the
upstream returns 200 and the sidecar was manufacturing the 502).

## Addendum (2026-07-23): synthesized SSE must also carry tool calls

The v1.26.1 synthesis rebuilt `content`, `reasoning_content`, and
`reasoning_details` but dropped `message.tool_calls`. A tool-call turn on
`/router` (buffered JSON with `finish_reason: "tool_calls"` and an empty
`content`) therefore reached the agent as an empty delta; Hermes retried,
exhausted its fallbacks, and surfaced "No reply: the model returned empty
content after retries". Because the agent opens most turns with a tool call
(skill loading, web fetch), this broke chat outright for tool-capable reasoning
models (observed with `openai-gpt-56-terra`, whose reasoning is additionally
encrypted, leaving no visible fallback text at all).

Fix: the delta projection (`assistant_delta_from_message`) now forwards
`tool_calls`, backfilling the per-entry `index` (required by the streaming
delta shape) from the array position when the buffered message omits it.
Validated against the live `/router` rail: a `stream: true` + `tools` request
through the sidecar now yields a tool-call delta chunk, `finish_reason:
"tool_calls"`, a usage frame, and `[DONE]`.

## Addendum (2026-07-29): withhold `stream_options` from the `/router` rail

The two fixes above made a `/router` turn *parse*. A third failure mode kept it
from being *sent*: the sidecar injects `stream_options: {include_usage: true}`
on every streamed chat completion (to obtain the usage frame for metering), and
`/router` rejects that field with a hard **400** whenever arbitration resolves to
an external market. The rail drops `stream: true` from the body it forwards but
keeps `stream_options`, so the market's validator rejects a request that was
valid OpenAI when we sent it. `retry::is_retryable_status` correctly classes 400
as deterministic, so the sidecar did not replay it — the turn died as a `502
upstream_provider_failed`, and the user saw "the model provider could not answer".

Measured on the live rail, n=10 per cell, identical bodies:
`llama-3.3-70b` 0/10 on `/router` vs 10/10 on `/v1`; `zai-org-glm-5-2` 2/10 vs
10/10; `claude-opus-5` and `openai-gpt-56-terra` 10/10 on both. Every failure
carried `X-Carpe-Route-Market: none`, every success `carpe`. Removing the single
field took `llama-3.3-70b` from 0/10 to 10/10. The rate therefore tracks how
often price arbitration picks an external market for a given model, which is why
it presented as intermittent, model-dependent "provider errors" rather than an
outright outage. Carpe Diem's documented guarantee that "a request never fails
because an external market does" does not hold for this 4xx: there is no
fallback to Carpe, and the failed routes are not counted in `/stats/router`.

**Decision.** The sidecar sends `stream_options` only when it has reason to
believe the upstream will actually stream:

1. **Seeded from the rail.** `UpstreamConfig::is_router_rail()` (a sibling of the
   existing `catalog_base_url()` rail derivation) initializes a per-`VeniceChat`
   `stream_options_supported` flag to `false` on a `/router` base. The field buys
   nothing there anyway — the rail never returns SSE (0/8 models tested), so
   there is no usage frame to include, and metering reads usage off the buffered
   body via `token_usage_from_value` exactly as before.
   **Withholding means stripping, not merely not injecting.** Hermes sets
   `stream_options: {include_usage: true}` on every streamed turn of its own
   accord (`chat_completion_helpers.py`; it omits it only for native Gemini
   bases), and the sidecar forwards the client body, so skipping our injection
   alone would still have shipped the client's copy and kept failing. When the
   flag is clear, the field is removed from the outgoing body whoever wrote it.
2. **Self-healing for everything else, decided by evidence rather than by
   wording.** On any 400, if the outgoing body still carries `stream_options`,
   the field is withdrawn and the turn replayed once — no attempt and no backoff
   spent, since nothing was transient, and bounded by a per-call flag so it
   cannot loop. The persistent lesson is recorded **only if that replay
   succeeds**: becoming acceptable the moment the field disappeared is the proof
   that the upstream refuses it.

   We deliberately do **not** parse the rejection text, which was the first
   design. These 400s echo the offending request back (Carpe Diem's include an
   `input` with the full body), so matching on the field name would also fire on
   an unrelated 400 — a bad model id, a context-length overflow — whose echo
   happens to contain it, and would then cost every later turn its usage frame
   for nothing. That failure would be silent: metering degrades to zero rather
   than erroring, and it bills for real on upstream June, whose base is always
   `/v1`. Trading a wasted round trip on an unrelated 400 (bounded: one, and only
   for streamed turns) for the impossibility of a false positive is the right way
   round.

Rejected alternatives: (a) *drop `stream_options` unconditionally* — `/v1`
streams for real, and without the field its SSE carries no usage frame, so
metering would break on the rail that works; (b) *treat the 400 as retryable* —
replaying an identical body against a deterministic rejection just burns the
attempt budget; (c) *pin the app to `/v1`* — already rejected in this ADR, and
the point is parity between rails, not retreat from one.

The flag lives on `VeniceChat`, which `serve()` builds once and shares as an
`Arc` for the process, so the lesson genuinely outlives a turn.

Validated end to end through the real sidecar against the live rail with the body
Hermes actually sends (`stream_options` included by the client): **36/36** turns
across both rails and `llama-3.3-70b`, `zai-org-glm-5-2`, `claude-opus-5` — the
first two were 0/10 and 2/10 on `/router` before. Tool calls and
`reasoning_content` intact, usage frame present in the synthesized stream, `/v1`
unchanged. The upstream defects are reported separately in
[`docs/reports/2026-07-29-carpe-diem-router-rail.md`](../reports/2026-07-29-carpe-diem-router-rail.md);
this addendum is the client-side compensation, which stands whether or not they
are fixed.
