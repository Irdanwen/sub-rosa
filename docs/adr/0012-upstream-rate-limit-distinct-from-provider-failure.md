---
status: accepted
date: 2026-07-17
---

# Upstream rate limits are a distinct, retryable error, not a generic provider failure

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
