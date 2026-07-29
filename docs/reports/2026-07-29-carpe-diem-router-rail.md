# Bug report — `/api/operator/router` diverges from `/api/operator/v1` on chat completions

**Date:** 2026-07-29
**Reporter:** Sub Rosa (Carpe Diem desktop + iOS client), account key `cdm_360bc…`
**Severity:** High — makes the `/router` rail unusable for streaming agent clients on a
subset of models, with no client-side signal about which subset.

---

## Summary

Three defects, all on `/router/chat/completions`, all absent from `/v1/chat/completions`:

| # | Defect | Impact | Reproducibility |
|---|---|---|---|
| **R1** | A request carrying `stream_options` is rejected with **400** whenever routing resolves to an external market. The rail appears to drop `stream: true` from the forwarded body but keeps `stream_options`, so the market's validator rejects a body that was valid when we sent it. | Every streamed turn fails for the affected models. `stream_options: {include_usage: true}` is what an OpenAI-compatible client sends to get a usage frame — it is not exotic. | 10/10 on `llama-3.3-70b`, 8/10 on `zai-org-glm-5-2`, 0/10 on `claude-opus-5`. Model- and time-dependent. |
| **R2** | The 400 from R1 is **surfaced to the client instead of falling back to Carpe**, contradicting the documented guarantee. `X-Carpe-Route-Market` reports `none`. | A pricing decision becomes a user-visible failure. Because the market pick varies over time, the same model works and then does not. | Always, whenever R1 fires. |
| **R3** | `/router` **never returns SSE**, for any model, even though the docs state streaming behaves identically to `/v1`. It answers `Content-Type: application/json` with a buffered completion. | No progressive rendering; time-to-first-byte equals the full generation (22.6 s vs 3.7 s measured). Naive streaming clients see an empty stream with no `finish_reason`. | 8/8 models tested. |

R1+R2 also do not appear in your own telemetry: `GET /stats/router` reported
`byMarket.none: 0` over the 24 h window in which these failures occurred, so the
failed routes are not counted.

---

## What the documentation promises

From `/docs/api`, the `/router` page:

> "Chat completions and Messages accept `"stream": true` and return SSE streams with
> identical behavior to `/v1` equivalents. The router transparently handles streaming
> across markets."

> "Request body: Unchanged from `/v1` or OpenAI spec."

> "A request never fails because an external market does — it falls back to Carpe
> transparently, and you're never double-charged."

All three statements are contradicted by the measurements below.

---

## R1 — `stream_options` rejected with 400

### Reproduction

```bash
curl -sS -X POST https://carpe-diem.xyz/api/operator/router/chat/completions \
  -H "Authorization: Bearer $CDM_KEY" -H "Content-Type: application/json" \
  -d '{"model":"llama-3.3-70b",
       "messages":[{"role":"user","content":"Say OK."}],
       "max_tokens":16,
       "stream":true,
       "stream_options":{"include_usage":true}}'
```

**`/router` → HTTP 400** (10/10 attempts):

```json
{"error":"{\"error\":\"[{'type': 'value_error', 'loc': ('body',), 'msg': 'Value error,
Stream options can only be defined when stream is true.', 'input': {'model':
'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'prompt': '<|begin_of_text|><|start_header_id|>
system<|end_header_id|>\\n\\nThe assistant is a helpful AI …","code":"UPSTREAM_ERROR"}
```

**`/v1`, byte-identical body → HTTP 200** (10/10 attempts), real SSE stream with a usage
frame.

### What the echoed body shows

The error echoes the request the router actually sent upstream, and it is not the request
we sent:

- `model` was rewritten from `llama-3.3-70b` to `meta-llama/Llama-3.3-70B-Instruct-Turbo`;
- `messages` was flattened into a single templated `prompt` string
  (`<|begin_of_text|><|start_header_id|>…`), i.e. forwarded to a **text-completion**
  endpoint rather than a chat endpoint;
- `stream` is absent from the echoed body while **`stream_options` is still present** —
  which is precisely the combination the upstream validator rejects.

So the rail strips `stream` (reasonably, if the market cannot stream) but does not strip
its dependent field. The resulting body is invalid by OpenAI's own rule, and the rejection
is attributed to the caller.

Three different upstreams word the same rejection three ways, which is how we know more
than one market is affected:

```
"Value error, Stream options can only be defined when stream is true."
"1 validation error: … 'Stream options can only be defined when `stream=True`.'"
"stream_options is only valid when stream is enabled"
```

### `stream_options` is the sole trigger

Same model (`llama-3.3-70b`), same prompt, n=10 per cell, single session:

| Body | `/router` | `/v1` | Market header on `/router` |
|---|---|---|---|
| `stream: true` + `stream_options` | **0/10 OK** (400 ×10) | 10/10 OK | `none` ×10 |
| `stream: true` only | 10/10 OK | 10/10 OK | `carpe` ×10 |
| no `stream` | 10/10 OK | 10/10 OK | `carpe` ×10 |
| no `stream` + `tools` (forced call) | 10/10 OK | 10/10 OK | `carpe` ×10 |

Removing that one field takes the rail from 0 % to 100 %.

Note the routing header in the failing row: with `stream_options` present the request is
attributed to **`none`**, never to a market. With it absent the same model is consistently
served by `carpe`. Whatever the internal cause, the presence of the field changes the route
and then fails on it.

### Model dependence — why it reads as flaky

Same body (`stream: true` + `stream_options`), n=10 per model, same minute:

| Model | `/v1` | `/router` | Markets seen on `/router` |
|---|---|---|---|
| `llama-3.3-70b` | 10/10 | **0/10** | `none` ×10 |
| `zai-org-glm-5-2` | 10/10 | **2/10** | `none` ×8, `carpe` ×2 |
| `claude-opus-5` | 10/10 | 10/10 | `carpe` ×10 |
| `openai-gpt-56-terra` | 10/10 | 10/10 | `carpe` ×10 |

The failure rate tracks how often arbitration picks an external market for that model,
which changes with price. From a client's seat this is an intermittent provider error that
comes and goes by model and by hour — the hardest possible failure to diagnose.

---

## R2 — no fallback to Carpe on a market-side 400

The docs guarantee: *"A request never fails because an external market does — it falls back
to Carpe transparently."*

Observed: the 400 is returned to the client verbatim, wrapped as `UPSTREAM_ERROR`, with
`X-Carpe-Route-Market: none` and no `X-Carpe-Route-Fallback` header. The fallback path
demonstrably exists — successful responses carry `X-Carpe-Route-Fallback: surplus-to-carpe`
— but it does not cover this case.

This is the defect we would most like fixed, independently of R1: **a 4xx produced by the
router's own body transformation is not the caller's error**, and Carpe can serve the
request. Even after R1 is fixed, a fallback that only covers 5xx will keep turning future
market-side validation differences into user-visible failures.

`forceMarket: "carpe"` does not help — it appears to be allowlist-gated and had no effect
on this account (400 with `forceMarket: "carpe"` too).

---

## R3 — `/router` never streams

Requested `stream: true` on both rails, 8 models
(`llama-3.3-70b`, `claude-opus-5`, `zai-org-glm-5-2`, `openai-gpt-56-terra`, `kimi-k3`,
`qwen3-235b`, `mistral-31-24b`, `gemini-3-6-flash`):

- `/v1` → `Content-Type: text/event-stream`, **8/8**;
- `/router` → `Content-Type: application/json; charset=utf-8`, **0/8** — including when
  the request is served by `market=carpe`, i.e. by the same backend that streams fine
  under `/v1`.

Latency cost, identical prompt, `max_tokens: 3000`:

| Rail | Time to first byte | Total | Content-Type |
|---|---|---|---|
| `/v1` | **3.7 s** | 35.9 s | `text/event-stream` |
| `/router` | **22.6 s** | 22.8 s | `application/json` |

For a chat UI that is the difference between a reply that writes itself and 23 s of
nothing. A client that trusts the documented behaviour and parses the response as SSE gets
an empty stream with no `finish_reason`.

We are not asking for streaming across external markets, which may genuinely not support
it. Two acceptable outcomes:

1. stream from Carpe when the request asks for it (the `carpe`-served path already has the
   SSE upstream), and only skip arbitration for streamed requests; or
2. document that `/router` never streams, so clients stop expecting it.

What is not workable is the current state, where the docs promise SSE and the rail returns
buffered JSON.

---

## Environment and method

- All measurements on 2026-07-29 between 11:20 and 14:20 UTC, from a single client, one
  account, both rails alternating within the same script run so market conditions are
  shared.
- The harness sends byte-identical bodies to `https://carpe-diem.xyz/api/operator/v1` and
  `…/router`, and records status, `Content-Type`, `X-Carpe-Route-*`, latency, and message
  shape.
- Reproduced end to end through the product's own backend (a local Rust proxy) as well as
  by raw `curl`, with the same result: 3 of 4 turns failing on `/router`, 0 of 4 on `/v1`.

## Not defects (verified alike on both rails)

Checked because we route them through the same rail and wanted to rule them out:

- `POST /embeddings` (`text-embedding-bge-m3`): same model, 1024 dims, cosine between a
  `/v1` vector and a `/router` vector = 0.999999. No drift.
- `POST /audio/transcriptions` (`nvidia/parakeet-tdt-0.6b-v3`): identical transcript, both
  served `x-carpe-route: tee`.
- Parameter acceptance: `temperature`, `top_p`, `seed`, `stop`, `presence/frequency_penalty`,
  `user`, `max_completion_tokens`, `reasoning_effort`, `tools`, `tool_choice` (`auto`,
  named), `parallel_tool_calls`, `venice_parameters`, content-array messages, `developer`
  role, assistant prefill — all behave the same on both rails. `stream_options` is the only
  parameter that diverges.
- Tool calling on the `carpe`-served `/router` path returns well-formed `tool_calls` with
  `finish_reason: "tool_calls"`, same as `/v1`.

## What we ask for

1. **R1** — strip `stream_options` alongside `stream` when forwarding to a market that
   cannot stream (or forward both and let the market stream). Highest impact, likely a
   one-line fix in the body transform.
2. **R2** — extend the Carpe fallback to cover 4xx that the router's own transformation
   caused, and count those routes in `/stats/router` rather than reporting `byMarket.none: 0`.
3. **R3** — either stream from Carpe on `stream: true`, or correct the documentation.

Happy to re-run the harness against a fix, or to share the raw per-request logs.
