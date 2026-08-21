---
status: accepted
date: 2026-08-21
---

# Prompt-cache telemetry crosses the sidecar as response headers

## Context

Carpe Diem serves part of every warm prompt from its own prompt cache and bills
that part at a lower rate. It reports this on the chat-completions rail inside
the `usage` object: `prompt_tokens_details.cached_tokens` (the OpenAI-canonical
split), plus `carpe_cache_saved_usdc_micro` and `carpe_cost_usdc_micro` (what
the operator says the turn saved and cost). Those fields are present on the
buffered JSON body and in the final SSE billing frame alike, and the `/router`
rebuild copies the whole `usage` object, so they already reach the app intact.

Nothing read them. Three separate layers dropped the information:

- `TokenUsage` in the domain had two fields, so the sidecar metered the prompt
  as one undifferentiated total and priced all of it at the full input rate.
- The API handler returned status, content type and body, so the upstream's own
  `X-Carpe-*` headers stopped at the provider.
- On the desktop, the usage panel asks the Hermes gateway for `session.usage`.
  That is the runtime's own accounting. Hermes is a pinned upstream that knows
  nothing about the operator serving its tokens, so no amount of parsing on that
  side can ever surface a cache reading. On mobile, agent-lite read no usage at
  all.

So the app could neither show the cache to the user nor price it correctly, and
the shell needed a source that was not the gateway.

The shell already has the right vantage point. Every completion on both shells
goes through `proxy_agent_chat_completions`: the desktop agent reaches it via
the in-process provider proxy Hermes talks to, and agent-lite, memory
extraction, session titles and the Studio briefs call it directly. One
observation point covers all of them.

The difficulty is what that point is allowed to touch. It forwards the body to
Hermes as a stream, deliberately, so the first token is visible before the
generation finishes. Reading the cache numbers out of the body would mean
buffering or teeing a stream whose whole purpose is not to be buffered.

## Decision

**The sidecar republishes each turn's metering as `x-june-*` response headers,
and the shell reads the cache from there, never from the body.**

- `TokenUsage` carries the cache split and the operator's own micro-USDC
  numbers, read leniently in both provider parsing paths (`token_usage_from_value`
  and the typed `ChatCompletionUsage`). Missing fields default to zero; a
  malformed one degrades to "not reported" and never fails a 200 that has
  already been billed upstream.
- `POST /v1/chat/completions` emits six additive headers:
  `x-june-prompt-tokens`, `x-june-completion-tokens`, `x-june-cached-tokens`,
  `x-june-cache-creation-tokens`, `x-june-cache-saved-usdc-micro` and
  `x-june-cost-usdc-micro`. Every field is emitted including the zeros: a hit
  rate needs its misses, and an absent header is ambiguous between "no cache"
  and "not reported".
- `carpe_diem::cache_stats` keeps an in-memory aggregate for the run of the app,
  fed from the one proxy, and exposes it as `carpe_diem_cache_stats` on both
  shells. The desktop usage panel renders it beside the gateway's numbers as a
  second source; the Carpe Diem settings card renders it on mobile.
- Pricing bills the cached share at the model's `cacheInputPrice` when the
  operator publishes one, and at the plain input rate when it does not.

## Consequences

The stream stays a stream. The shell learns what a turn cost without reading a
byte of the payload, which also means the mechanism works identically for a
buffered `/router` response and a streamed `/v1` one.

Two usage sources now appear in one panel, and they will not agree — the gateway
counts what the runtime thinks it sent, the ledger counts what the operator says
it served. That is not a bug to reconcile: they answer different questions, and
merging them into one number would lose both.

The ledger is not durable. It answers "is the cache working right now" and
resets on restart. Anything that needs history would need a table, a schema and
a retention policy, and would be a different feature (see ADR-0018 on what does
justify a durable row).

The headers are additive, so an older client that ignores them behaves exactly
as before. Nothing but Sub Rosa's own shell reads them.

## Alternatives considered

**Tee the response body and parse the usage frame in the shell.** The numbers
are already there, so no backend change would have been needed. Rejected: the
proxy's contract is to forward bytes as they arrive, and the usage frame is the
last one, so the shell would either buffer the whole generation or carry a
stateful scanner across chunks for telemetry. Headers cost one `HeaderMap` read.

**Add `cached_tokens` to the gateway parser's alias list.** This was the obvious
move and it does nothing: `SessionUsagePanel` is fed by Hermes, and Hermes never
sees an operator field. The alias would match a key that is never sent.

**Send a `prompt_cache_key` derived from the session.** The operator already
derives a cache key from the prompt prefix, and the app has no conversation
identifier at the proxy: Hermes' request body carries none, and a key built from
the sliding window would change on the very turns it is meant to keep warm. Set
against a speculative gain, the risk is concrete and documented — ADR-0015's
2026-07-29 addendum records `/router` returning 400 for `stream_options` once
arbitration lands on an external market, which is the same class of failure for
the same class of field. Not sent. If a conversation id ever reaches the proxy,
this is worth reopening behind the same withdraw-and-replay guard that field has.

**Price the cache write premium.** `cache_creation_input_tokens` is captured but
not billed. Whether it is a subset of `prompt_tokens` or an addition to it is not
stated for this rail, so pricing it risks billing the same tokens twice, and most
models publish no write premium at all. The field is carried so the premium can
be added once the semantics are stated.

**Move the user-memory block to the end of the SOUL.** It sits ahead of roughly
90 % of the static sections, so a memory write invalidates most of the cacheable
prefix. Left alone: the SOUL is only rewritten at runtime spawn, so the
invalidation happens at the next start rather than on every turn, and the
placement is deliberate — the facts are meant to read as background context
rather than as tool instructions. `the_soul_is_byte_stable_across_runs_with_the_same_inputs`
now holds the invariant that actually matters. Reopen only if the ledger shows
hit rate collapsing after restarts.

## Addendum, 2026-08-21 — what the price table is actually for

A second pass over the billing path corrected two readings in this decision's
context. Both were verified against the code, not inferred.

**The inherited pricing path settles nothing here.** The desktop runs the
backend as a local sidecar with `JUNE__LOCAL_DEV__ENABLED=true`, which wires
`LocalDevOsAccountsClient`: `authorize` always allows, and `charge` always
returns a receipt of `Credits(0)`. The receipt does travel back in the HTTP
response, and no component under `src/` reads `credits_charged`. The number is
computed, serialized and dropped. What the user actually sees is the operator's
own balance (`GET /v1/credits`, polled by `useCarpeDiemCredits`), and the
authoritative per-request cost is the operator's `X-Carpe-Cost-Usdc-Micro`.

So the table's two LIVE roles are neither of them a bill, and both are now named
where someone will read them (`PricingTable`, `require_priced_model`):

1. **A model allowlist.** `require_priced_model` runs before every upstream
   call and refuses an unlisted model `model_not_priced`. A catalogue model with
   no published rate is *unusable in the app*, not merely unbilled — which is
   why `cache_input_credits_per_million_tokens` had to be `Option` all the way
   down, and why a test holds that a missing cache rate never costs a model its
   place.
2. **The price line in the model picker.** `/v1/models` renders these rates into
   the string the picker shows. That makes it the one real reader of the cache
   rate, so the rate is now on that line: `$1.40 input / $5.50 output per 1M
   tokens ($0.26 cached input)`, with sub-cent rates kept legible so a cheap
   model does not appear to cache for free.

**The post-completion pricing guard is defense in depth, not a bug fix.** The
first reading held that a `NotPriced` could fail a turn the model had already
answered and billed. That is wrong: `ensure_model_kind` runs in every service
and `require_priced_model` runs in the API layer, both before dispatch, so by
the time work has settled the model is proven priced and only a `u64` overflow
remains. `price_settled_work` stays — it is fifteen lines, it is the same rule
`complete_raw_once` already follows for a 200 it cannot fully parse, and it
keeps the ordering a choice rather than a load-bearing accident. Its
documentation now says so plainly rather than implying a live failure.

**Rejected: deleting `price_token_usage` from the call path.** Tempting once the
result is known to be unread, and it would stop the name from misleading. But
`june-api` is tracked against upstream June, where that path does settle real
money, and the metering flow (authorize, charge, receipt, `log_settled`) is one
coherent upstream mechanism; removing the amount from the middle of it buys a
fork divergence on every future sync in exchange for no user-visible change. The
cheaper fix for a misleading name is to say what the thing does, which is what
the type docs now do.

## Related

- ADR-0015 — normalizing `/router` responses, and the `stream_options` addendum
  this decision leans on.
- ADR-0008 — the direct-call pattern this deliberately does not use: cache
  telemetry rides the sidecar the completion already went through.
