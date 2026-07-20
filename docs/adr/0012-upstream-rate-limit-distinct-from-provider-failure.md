---
status: accepted
date: 2026-07-17
---

# Upstream rate limits are a distinct, retryable error, not a generic provider failure

## Addendum — 2026-07-20 (accepted; backed-off retries on the agent-chat path + a provider-failed notice)

Recurring user pain on hot Kimi models: chat turns kept dying on provider
errors. Reading the gateway's own API documentation closed the diagnosis — it
explicitly classifies **429, 502 and 503 as transient** ("retry with
exponential backoff, e.g. 1s → 2s → 4s, a few attempts"), yet the agent-chat
upstream call (`VeniceChat::complete_raw`) was the **only** upstream path with
no retry at all: the cleaner and the transcribers already had the bounded
`UPSTREAM_ATTEMPTS` replay, so every one-off Venice flap on the chat path
surfaced straight to the user. Two decisions:

1. **Retry the agent-chat upstream call with exponential backoff.**
   `complete_raw` now makes up to `AGENT_CHAT_ATTEMPTS = 3` attempts with
   `AGENT_CHAT_BACKOFF` doubling from 1s (so 1s, then 2s — the gateway's own
   recommendation; the 300ms `UPSTREAM_RETRY_BACKOFF` used elsewhere lands
   inside the same flap), on retryable statuses (408/429/5xx) and retryable
   transport errors. A body-read failure after a 200 is deliberately **not**
   replayed: that generation already ran (and billed) upstream. Replays cannot
   double-charge June metering either — it settles only after success. Worst
   case adds ~3s to a turn against a 600s request budget. Both shells benefit
   (desktop Hermes and mobile agent-lite reach upstream through the same
   sidecar call), and Hermes' own 3-attempt wrapper now multiplies with a
   backed-off inner replay instead of hammering the same flap.
2. **A genuine failure that survives the retries folds into a first-class
   `provider-failed` notice** instead of a raw "Error: … upstream_provider_failed"
   part (until now only 429/503 had a friendly card). Desktop: new matchers
   `isUpstreamProviderFailureMessage` / `isUpstreamProviderFailureErrorSentinel`
   (`src/lib/errors.ts` — the strict sentinel keeps the JUN-169 guard: persisted
   prose that merely mentions the token stays text), notice kind
   `provider-failed` (`agent-chat-runtime.ts`, folded on the live error, failed
   message.complete, and persisted paths), card `ProviderFailedNoticePart`
   (`AgentWorkspace.tsx`: "The model provider could not answer this message.
   Try again, or switch to another model." + the retry affordance). Mobile:
   `agent_lite_provider_failed` with the same wording (`is_provider_failure_detail`).
   This does **not** reclassify the 5xx — the original decision stands: the
   wire shape (`502 upstream_provider_failed`) is untouched and the wording
   never claims the model is merely busy; it only upgrades the *presentation*
   of a hard failure to something actionable.

## Addendum — 2026-07-17 (accepted; surface an interrupted turn on reload)

A production incident closed the last gap this ADR left open. A desktop chat on
`zai-org-glm-5-2` did tool work, then its follow-up model call returned
`502 upstream_provider_failed` three times; the runtime gave up and the session
sat idle for hours. The user's report: "nothing has happened for hours." The
502 is correct to keep as a hard failure (this ADR's decision stands — we do not
reclassify 5xx as busy), but the turn was **invisible**: Hermes persists no
assistant row for a model call that never returned, so on the next rebuild from
the DB the transcript ends on the last tool result with no sign it was cut off.
The addendum above surfaces the live `error` frame, but that frame is in-memory
only — a reload (or, here, any rebuild after the live buffer cleared) loses it.

**Decision:** detect an interrupted turn from the durable **persisted message
shape**, not from error text. A completed agent loop always ends on a plain
assistant answer, so a session whose last message is a `tool` result (or an
assistant message that emitted tool calls but never resolved) was cut off.
`hermesMessagesEndInterrupted` (in `src/lib/agent-chat-runtime.ts`) tests that
shape; `withInterruptedTurnNotice` appends a new `interrupted` chat notice
("This turn stopped before it finished… Try again, or switch to another model.")
reusing the existing retry action. The caller
(`AgentWorkspace`) gates it on the session being idle — neither working (a live
tool tail is just the next call in flight) nor awaiting input (approval /
clarify) — and the notice yields to any more specific live notice already folded
onto the turn (credits / upstream-busy / overflow win).

Because it keys on structure, not the error string, it makes **every** silent
interruption visible (502, a crash, the app quit mid-turn) without asserting the
provider merely "busy" — so it does not reclassify the 502 and does not hide a
real outage. Chosen over persisting an error row in Hermes: that would edit the
pinned runtime (fork re-merge cost, `FORK_NOTES`) for a purely presentational
win the frontend can infer on its own. Frontend-only, no June API change.

## Addendum — 2026-07-17 (accepted; scope extended to 503 same day)

The original decision scoped the "busy" reclassification to **429 only** and
deferred 503 as "an easy follow-up if capacity errors become a recurring
user-visible pain." Hours later, production Hermes logs and live probes on the
user's Mac proved that pain is already here and is in fact the *dominant*
flavour: a hot model (`kimi-k3`) flaps between `429 UPSTREAM_RATE_LIMIT`,
`502`, and — most often — **`503 MODEL_INFRA_SATURATED`** (`retry-after: 9`). A
scheduled routine and a chat turn both died on `HTTP 502/503`, and the 502/503
still collapsed into the opaque `upstream_provider_failed` even with the 429 fix.

So `error_for_status` now maps **both `429` and `503`** to
`DomainError::UpstreamRateLimited` (name kept to avoid churn on the just-shipped
v1.15.0 identifiers; the user-facing surface was always "busy"). The sidecar
normalizes both to the `upstream_rate_limited` message, so the existing frontend
matcher folds them into the same "busy, retry / switch model" notice; the matcher
and the mobile `is_rate_limit_detail` also learned the raw saturation vocabulary
(`MODEL_INFRA_SATURATED`, `NO_PROVIDER_CAPACITY`, "saturated upstream") for
un-normalized bodies. Genuine gateway failures (500/502/504) still stay
`upstream_provider_failed`. Shipped alongside two related bug fixes (not ADRs):
the composer model-selector no longer blanks on a transient `/v1/models` failure
(so a flapping upstream can't trap the user on a dead model), and a chat turn
that fails *after* tool calls now surfaces the error instead of settling
silently (the live `error` frame is preserved across the session refresh).

## Context

When the Carpe Diem gateway is momentarily rate-limited or at capacity for a
model, it answers with **HTTP 429** (`UPSTREAM_RATE_LIMIT` / "Venice rate limit
reached — please retry in a few seconds", carrying a `retry_after_ms`). This is
a transient "the model is busy, retry shortly" signal — the request was well
formed, the key is valid, and the balance is fine.

Until this change the June API providers layer collapsed **every** non-2xx
upstream status except 402 into a single `DomainError::UpstreamProvider`
(`retry.rs::error_for_status`), which the API boundary rendered as
`502 upstream_provider_failed`. A user whose `kimi-k3` turn hit a busy upstream
therefore saw, in the desktop chat, the Hermes runtime's verbatim wrapper:

```
API call failed after 3 retries: HTTP 502: upstream_provider_failed
```

That message is wrong in kind (the provider did not fail — it was busy) and
useless in guidance (nothing tells the user the fix is to wait a moment or pick
another model). A live probe during the incident confirmed the diagnosis: a
second model (`qwen3-235b`) answered `200` and credits were healthy (1000
available); only `kimi-k3`'s upstream returned `429`.

There is a direct precedent in the same file (`api/src/error.rs`):
`ServiceError::AuthorizationDenied` was deliberately split out of the generic
502 into a **retryable `429` with a `Retry-After`** because a transient metering
denial "used to surface as 502 upstream_provider_failed — the client told users
the provider couldn't process their request when a short retry would have
succeeded." An upstream rate limit is the same shape of problem.

## Decision

Give an upstream **429** its own error identity end to end, retryable, distinct
from a genuine provider failure.

- **Providers** (`retry.rs::error_for_status`): `429 TOO_MANY_REQUESTS` →
  new `DomainError::UpstreamRateLimited` (was `UpstreamProvider`). `402` still
  maps to `InsufficientCredits`; every other non-2xx status stays
  `UpstreamProvider`. The status remains retryable
  (`is_retryable_status`), so the one bounded in-process retry is unchanged;
  only the *final* surfaced error differs.
- **Boundary** (`api/src/error.rs`): `UpstreamRateLimited` →
  **`429` + `Retry-After: 5` + `error_code 4291` + message `upstream_rate_limited`**,
  mirroring `AuthorizationDenied`. Genuine failures keep their exact existing
  `502 upstream_provider_failed` shape (error_code 5001) — the regression test
  asserting that shape is untouched.
- **Frontend** (the actual user-facing win): the transient rate-limit is folded
  into a first-class **`upstream-busy` chat notice** ("This model is busy right
  now. Wait a few seconds and send again, or switch to another model.") instead
  of raw error text, exactly like the existing `credits` and `context-overflow`
  notices. The same condition also gets a friendly note-failure-banner message
  and a friendly mobile agent-lite message. A shared matcher
  (`isUpstreamRateLimitedMessage`) plus a strict persisted-turn sentinel
  (`isUpstreamRateLimitedErrorSentinel`, so a saved answer that merely *discusses*
  rate limits is not mis-folded — the JUN-169 guard) live in `src/lib/errors.ts`.

### Why a new error code, not a message change

The June API contract is append-only (`AGENTS.md` boundaries): the desktop
Hermes runtime string-matches `upstream_provider_failed`, and older installs
keep calling older `/v1/*` contracts. Renaming the existing message would be a
breaking change. Adding `4291 upstream_rate_limited` as a *new* variant for a
status (429) that previously produced a 502 is additive — a client that does not
recognize it still sees a sensible retryable 429, and the string-match on
genuine failures is preserved.

### Scope boundary: only 429

Only `429` is reclassified. `503` (capacity / warm-up: `NO_PROVIDERS`,
`TEE_NOT_READY`, …) and the 5xx family stay `upstream_provider_failed`. 503 is
closer to a genuine "no capacity" failure than to a rate limit, and the reported
incident was specifically a 429; the frontend still gives 503 a friendlier
surface through the generic path. Promoting 503 into its own "busy" identity is
a deliberate, easy follow-up if capacity errors become a recurring user-visible
pain.

## Consequences

- A busy-model turn now reads as an actionable "busy, retry / switch model"
  notice rather than an opaque hard failure, on all three surfaces (desktop
  chat, note banner, mobile chat). Even the raw Hermes wrapper improves: it now
  reads `HTTP 429: upstream_rate_limited`, and Hermes gets a proper
  `Retry-After` to back off against.
- One new `DomainError` / `ServiceError` / `ApiError` variant threads through
  the existing exhaustive matches (a new variant forces a deliberate mapping at
  each boundary rather than silently collapsing — the `issues.rs` handler maps
  it to the same 429).
- The `Retry-After` is a fixed 5s, not the upstream's `retry_after_ms`. Plumbing
  the real hint would require a payload on the `DomainError` enum (today a plain,
  `Eq` enum); the fixed value matches the existing `AuthorizationDenied`
  precedent and is enough to stop a too-eager retry from re-tripping the limit.
- This is a fork-local change to upstream June API files; it is logged in
  `FORK_NOTES.md` for re-merge.

## Alternatives considered

- **Frontend-only translation.** Pattern-match `upstream_provider_failed` in the
  UI and show a nicer message. Rejected: it cannot distinguish a transient rate
  limit from a genuine failure (both arrive as the same 502 string), so the
  guidance would be wrong half the time. The signal has to be preserved at the
  source.
- **Rename the existing 502 message.** Rejected: breaks the append-only API
  contract and the desktop Hermes string-match (see above).
- **Reclassify all retryable statuses (429 + 503 + 5xx) as "busy".** Rejected as
  too broad: a 5xx genuinely is a provider failure and folding it into a "just
  retry" message would hide real outages. Kept to 429, the unambiguous
  rate-limit signal.
