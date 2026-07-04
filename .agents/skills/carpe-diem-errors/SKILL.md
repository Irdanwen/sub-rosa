---
name: carpe-diem-errors
description: Handle Carpe Diem (carpe-diem.xyz) API errors correctly. Covers the {error, code} body shape, the 402 PAYMENT_REQUIRED credits shape, every meaningful status code (400, 401, 402, 403, 404, 410, 413, 429, 451, 502, 503), which codes to retry with backoff, and how Carpe Diem differs from Venice (no 422 content shape, no x402 402 body). Use when the active key is a cdm_ Carpe Diem key.
---

# Carpe Diem errors & retries

> Use this when your key starts with `cdm_` (Carpe Diem). For a `VENICE_…` key
> calling `api.venice.ai` directly, use [`venice-errors`](../venice-errors/SKILL.md) instead.

Carpe Diem is the operator in front of **Venice**. It returns a single, uniform
error shape — much simpler than Venice's four shapes.

## Error body shape

Every error is:

```json
{ "error": "<human message>", "code": "<CODE>" }
```

Two codes carry extra fields:

- **`402 PAYMENT_REQUIRED`** adds `credits_available` and `credits_required`:

  ```json
  {
    "error": "Insufficient credits",
    "code": "PAYMENT_REQUIRED",
    "credits_available": 42,
    "credits_required": 120
  }
  ```

  (1 credit = $0.01. Top up USDC on Base into the escrow — see
  [`carpe-diem-credits`](../carpe-diem-credits/SKILL.md).)

- **`429`** adds a reset hint for backoff.

> **No `422` / `ContentViolationError` / `suggested_prompt` shape.** That is
> Venice's audio pipeline. On Carpe Diem, content-policy issues come back as
> `400`. There is also **no x402 `PAYMENT-REQUIRED` header / `X402InferencePaymentRequired`
> body** — Carpe Diem's `402` is the `PAYMENT_REQUIRED` credits shape above.

## Status code map

| Status | Codes | Meaning | What to do |
|---|---|---|---|
| `400` | `BAD_REQUEST` · `INVALID_MODEL` · `MODEL_ERROR` | Malformed input, unknown model, or a content-policy refusal. | Fix and re-send. **Don't retry.** |
| `401` | `AUTH_REQUIRED` · `AUTH_FAILED` · `TOKEN_EXPIRED` | Missing / invalid `cdm_` key or expired JWT. | Rotate credentials. **Don't retry.** |
| `402` | `PAYMENT_REQUIRED` | Out of credits. Body carries `credits_available` / `credits_required`. | Top up (USDC on Base). **Don't retry** until funded. |
| `403` | `OFAC_BLOCKED` · `FORBIDDEN` · `JWT_REQUIRED` | Valid auth but not entitled (sanctioned, other wallet's resource, or an account-management route that needs a wallet JWT not an API key). | **Don't retry.** Investigate. |
| `404` | `NOT_FOUND` · `VIDEO_JOB_NOT_FOUND` | Unknown route or an expired/unknown job id. | **Don't retry.** |
| `410` | `VIDEO_KEY_REVOKED` | The provider key backing a job was revoked. | Re-queue the job. |
| `413` | `PAYLOAD_TOO_LARGE` | Input exceeds the size cap (e.g. 5 MB image edit). | Shrink the input. **Don't retry** as-is. |
| `429` | `ENDPOINT_RATE_LIMITED` · `UPSTREAM_RATE_LIMIT` | Operator-side or upstream Venice rate cap. | Back off with jitter (honor the reset hint). **Retry.** |
| `451` | (geo) | Geo-blocked. | **Don't retry.** |
| `502` | `VENICE_ERROR` · `QUOTE_FAILED` | Upstream Venice failure, or the ~60 s sync edge cap on a heavy image/edit model. | Retry with backoff; for heavy image/edit models switch to the async queue path. |
| `503` | `NO_PROVIDERS` · `NO_PROVIDER_CAPACITY` · `INSUFFICIENT_PROVIDER_CAPACITY` · `MODEL_INFRA_SATURATED` · `TEE_NOT_READY` · `BALANCE_CHECK_FAILED` | Temporary capacity / warm-up issue. | Retry with backoff; consider a fallback model. |

## Retry strategy

### Retry with backoff (1s → 2s → 4s, add jitter, 3–5 max)

- `429` — honor the reset hint, then back off.
- `502` — upstream/edge-cap. For heavy image/edit models, switch to the async
  `queue → retrieve → complete` path instead of blindly retrying the sync call.
- `503` — capacity / TEE warm-up.

### Fatal — fix, don't retry

- `400` — bad input (including content-policy refusals). Fix the request.
- `401` — bad auth. Fix the `cdm_` key.
- `402` — top up credits first, then retry.
- `403` — not entitled. Don't hammer.
- `404` — unknown route / job.
- `410` — key revoked; re-queue (a fresh job, not a blind retry).
- `413` — payload too large; shrink it.

### Reference retry loop

```ts
async function callCarpe<T>(fn: () => Promise<Response>): Promise<T> {
  const RETRYABLE = new Set([429, 502, 503])
  const maxRetries = 5
  let delay = 1000
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fn()
    if (res.ok) return res.json() as Promise<T>

    const body = await res.clone().json().catch(() => ({}))
    const { status } = res

    if (status === 402 && body.code === 'PAYMENT_REQUIRED') {
      throw Object.assign(new Error('Out of credits'), {
        status, creditsAvailable: body.credits_available, creditsRequired: body.credits_required,
      })
    }

    if (!RETRYABLE.has(status) || attempt === maxRetries) {
      throw Object.assign(new Error(body.error ?? 'Carpe Diem error'), { status, code: body.code })
    }

    await sleep(delay + Math.random() * 250) // honor the 429 reset hint if present
    delay *= 2
  }
  throw new Error('Exceeded max retries')
}
```

## Streaming errors

Streaming chat (`stream: true`) delivers mid-stream errors as SSE events and then
closes the connection; the HTTP status stays `200`. Treat an in-band error event
as terminal. Don't treat `data: [DONE]` or empty keepalive lines as errors.

## Gotchas

- **`400`, not `422`, for content issues.** If you were porting Venice code that
  branches on `422` / `suggested_prompt`, that path never fires on Carpe Diem.
- **`402` is the credits shape**, not an x402 wallet-signature flow. Read
  `credits_available` / `credits_required`; top up USDC on Base.
- **`502` on a heavy image/edit model** is usually the sync edge cap, not a real
  failure — the artifact may already exist behind the async queue path.
- **`410 VIDEO_KEY_REVOKED`** means re-queue, not retry the same job id.
- The credit headers (`x-carpe-balance-credits`, `x-carpe-available-credits`, …)
  are on **successful** paid calls — watch `x-carpe-available-credits` to predict
  a coming `402` before it happens.
