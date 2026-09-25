---
status: accepted
date: 2026-09-25
---

# The sidecar relays a streamed agent chat as it is generated

## Context

Every chat completion on both shells takes the same path: the caller (the
desktop's Hermes runtime through the shell's provider proxy, agent-lite,
ask, note rewrites, memory extraction, titles) calls
`proxy_agent_chat_completions` in `src-tauri/src/june_api.rs`, which posts to
the sidecar's `/v1/chat/completions`, which posts to Carpe Diem.

The shell already forwarded the sidecar's body to Hermes chunk by chunk. The
sidecar did not: `VeniceChat::complete_raw_once` read the whole upstream body
with `response.bytes().await`, `AgentChatService::complete` priced and charged
it, and only then did the handler answer. A client that asked for
`stream: true` and got a real `text/event-stream` from `/v1` therefore saw its
first token when the model wrote its last one.

That cost compounds. An agent turn is a chain of completions: most open with a
tool call (loading a skill, fetching a page), and every tool result starts
another completion. Time to first visible token was the full generation time of
each step, multiplied by the number of steps, with nothing on screen in between.
ADR-0015 had noted the buffering and deferred true streaming as a larger change;
ADR-0023 had built the metering headers on top of it.

## Decision

**When the client asks for a stream and the upstream answers 2xx with
`text/event-stream`, the sidecar relays the upstream bytes as they arrive and
settles the turn when the stream ends.** Everything else is unchanged.

- **Domain.** `AgentChatCompleter::complete` returns `AgentChatResponse`:
  `Buffered(AgentChatCompletion)` (the existing struct, untouched) or
  `Streamed(AgentChatStream)`. A stream is a body (`Stream<Item = Bytes>`, which
  always ends cleanly) plus a `usage` future that resolves once the body has
  ended or been dropped.
- **Provider.** `june-api/crates/providers/src/agent_chat_stream.rs` wraps the
  upstream `bytes_stream()` in a relay that passes every chunk through untouched
  and feeds a line scanner. The scanner splits on the `\n` byte, tolerates a
  frame cut anywhere between two chunks, keeps at most one partial line (256 KiB,
  longer lines are skipped), parses only lines that mention `"usage"`, and keeps
  the last non-null `usage` object read the lenient way
  (`token_usage_from_value`). The relay reports that usage exactly once: at the
  end of the stream, on a read error, or when it is dropped.
- **Retries are untouched.** Transient statuses, backoff and the replay without
  `stream_options` (ADR-0015 addenda) are all decided on the status line, before
  a byte of the body is read. Once relaying has begun nothing is replayed: a read
  error mid-stream is logged and the stream ends where it broke, because the
  generation has already run, and been billed, upstream.
- **Service.** Authorization still runs before the upstream call. A streamed
  turn is handed back at once and a task awaits its usage, prices it with
  `price_settled_work`, clamps it to the cap and charges it with the same
  idempotency key as before.
- **Handler.** `Body::from_stream` with the upstream's content type and no
  `x-june-*` headers, which cannot exist before the usage does. The buffered
  path keeps its six headers exactly as ADR-0023 defined them.
- **Shell.** When a 2xx answer has no metering headers and is
  `text/event-stream`, `carpe_diem::stream_usage` taps the body as it passes
  through (the same line-at-a-time rule, bounded to one 64 KiB line) and records
  the last usage in the prompt-cache ledger once the body has been read to its
  end. Headers win whenever they are present.

The `/router` rail never streams (ADR-0015): its buffered JSON is still read
whole and rebuilt into SSE, and still carries the headers. A client that did not
ask for a stream is still answered from a buffered body.

## Why

Time to first token is what a person waits through, and on an agent turn it was
the sum of every step's full generation time. Relaying the stream makes it the
upstream's own first-token latency, per step. Nothing else in the path needed the
whole body: the only reason to wait was to know the usage before answering, and
the usage is only needed to settle, which can happen after.

## Alternatives considered

- **Stay buffered so the metering headers stay.** The headers are the reason
  ADR-0023 could meter without touching the body, and keeping them means keeping
  the full-generation wait on every step. The shell can read the same numbers
  from the final frame of a stream it is already forwarding, line by line,
  without buffering it. Rejected: the headers were a convenience of the buffered
  design, not a requirement.
- **Trailers.** HTTP trailers could carry the usage after a streamed body, but
  the shell's HTTP client does not expose them to a streaming reader, and nothing
  else in the path speaks them. Rejected as more machinery for the same numbers.
- **Keep reading after the client leaves, to learn the true usage.** It would
  bill accurately for an abandoned turn, at the price of paying for a generation
  nobody will see. Rejected; see below.

## Consequences

- **Metering happens at the end of the stream.** An abandoned stream is charged
  on the usage seen before the client left, which is usually none because the
  billing frame comes last. That under-charges a turn the upstream may have
  partly billed, and it is the right way round. In this distribution the charge
  is a no-op anyway (`LocalDevOsAccountsClient`), so the settlement is
  bookkeeping; it lives exactly as long as the stream, which is why it is a task
  and not a durable row (ADR-0018 protects work a person would lose, and there is
  none here).
- **The streamed path carries no `x-june-*` headers.** The shell reads the usage
  from the stream instead. The shell and the sidecar ship together, so no client
  in the wild depends on the headers being present on a stream; a client that
  ignores them, as every non-Sub Rosa client does, sees no change.
- **The generation is bounded by the upstream client's timeout, not the
  handler's.** The router's `TimeoutLayer` now covers the time to the response
  head. The body is still bounded by the upstream HTTP client's total timeout
  (`request_timeout_secs`, 600 s), exactly as it was when the body was read
  whole; hitting it ends the relayed stream early.
- **Stream readers must be byte-safe.** Chunks now split wherever the network
  puts them, including inside a multi-byte character. The shell's readers
  (agent-lite, ask, note rewrites) split lines on bytes with
  `src-tauri/src/sse_lines.rs` and decode whole lines only.
- Both shells get this: the desktop sidecar binary and the in-process
  `june-embed` on iOS and Android share the code.

Complements [ADR-0015](0015-normalize-carpe-diem-router-responses.md), whose
"true streaming passthrough" follow-up this is, and narrows
[ADR-0023](0023-cache-telemetry-crosses-the-sidecar-as-headers.md): the metering
headers now describe buffered turns only.
