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
