---
name: carpe-diem-credits
description: Read Carpe Diem prepaid credits, usage, pricing, and capacity. Use when the active key is a cdm_ Carpe Diem key and you need the escrow/available balance, a per-request usage ledger, dynamic per-model pricing, top-up quotes, or rate/capacity limits. Replaces both venice-billing and venice-x402 — Carpe Diem has its own on-chain USDC escrow, not Venice's /billing/* or /x402/*.
---

# Carpe Diem Credits

Carpe Diem (carpe-diem.xyz) is a TEE-sealed operator that proxies **Venice** and bills from a prepaid **credit escrow** (USDC on Base). It does **not** expose Venice's `/billing/*` or `/x402/*` surfaces — it has its own escrow and `/buyer/*` + `/v1/credits` endpoints. **This skill replaces both `venice-billing` and `venice-x402`.**

**1 credit = $0.01.** `available*` is what you can actually spend (escrow − pending − holds).

> Use this when your key starts with `cdm_` (Carpe Diem). For a `VENICE_…` key calling `api.venice.ai` directly, use the `venice-*` skills instead.

## Use when

- You need the current spendable balance before or after inference.
- You want a per-request usage ledger or an aggregated usage summary.
- You need per-model dynamic pricing (Carpe Diem floats between 15% and 100% of Venice).
- You want a top-up quote or to understand the USDC-into-escrow flow.
- You need capacity / rate-limit info to pace requests.

## Balance — `GET /v1/credits` (alias `GET /v1/billing/balance`)

Auth: `cdm_` API key or wallet JWT (no ADMIN/INFERENCE split).

```bash
curl https://carpe-diem.xyz/api/operator/v1/credits \
  -H "Authorization: Bearer $CARPE_KEY"
```

```json
{
  "escrowUsdc": 25.00,
  "pendingUsdc": 0.40,
  "holdsUsdc": 0.10,
  "availableUsdc": 24.50,
  "escrowCredits": 2500,
  "pendingCredits": 40,
  "holdsCredits": 10,
  "availableCredits": 2450,
  "updatedAt": "2026-07-03T12:34:56Z"
}
```

- `available*` = `escrow − pending − holds` — the only figure safe to gate on.
- `pending*` = in-flight/settling charges; `holds*` = reserved for open async jobs (video/image queues).
- `/v1/billing/balance` is a byte-identical alias, kept so Venice-shaped dashboards keep working.

### Abort before inference if the escrow is dry

```ts
const { availableCredits } = await fetch(`${base}/v1/credits`, { headers }).then(r => r.json())
if (availableCredits <= 0) throw new Error('Carpe Diem escrow exhausted — top up before continuing')
```

## Usage ledger — `GET /buyer/usage`

Per-request ledger. Auth required.

```bash
curl "https://carpe-diem.xyz/api/operator/buyer/usage?limit=200&offset=0" \
  -H "Authorization: Bearer $CARPE_KEY"
```

```json
{
  "events": [
    {
      "id": "usg_01H...",
      "model": "zai-org-glm-5-1",
      "provider": "0xProvider…",
      "prompt_tokens": 339,
      "completion_tokens": 227,
      "cost_usdc": 0.000636,
      "multiplier": 0.42,
      "created_at": "2026-07-03T12:34:56Z"
    }
  ],
  "total": 1000
}
```

- `multiplier` is the dynamic-pricing fraction applied (see pricing below).
- Page with `limit` + `offset` against `total`.

## Usage summary — `GET /buyer/usage/summary`

```bash
curl "https://carpe-diem.xyz/api/operator/buyer/usage/summary?days=7" \
  -H "Authorization: Bearer $CARPE_KEY"
```

Returns `{ byModel, byDay, totals }` — pre-shaped aggregates for dashboards.

## Other buyer reads

| Endpoint | Purpose |
|---|---|
| `GET /buyer/api-keys/usage?days=` | Usage broken down per API key. |
| `GET /buyer/debt` | Unsettled balance owed: `{pendingUsdc, …}`. Clears as charges settle against escrow. |

## Top-ups (USDC on Base → escrow)

Credits are a **usage entitlement** — you fund them by depositing **USDC on Base** into the escrow contract. There is **no withdrawal**.

- For non-USDC deposits, get a swap quote first:

```bash
curl "https://carpe-diem.xyz/api/operator/deposits/quote?token=USDC&amount=50" \
  -H "Authorization: Bearer $CARPE_KEY"
```

Returns the quoted credits/USDC you'd receive for the deposit.

## Dynamic pricing — `GET /pricing` (public)

Carpe Diem prices each model at **15%–100% of Venice's rate**. The `multiplier` floats with the daily DIEM pool and **resets at 00:00 UTC**.

```bash
curl https://carpe-diem.xyz/api/operator/pricing
```

```json
{
  "models": [
    { "id": "zai-org-glm-5-1", "input_usd_per_mtoken": 1.2, "output_usd_per_mtoken": 2.8, "multiplier": 0.42 }
  ],
  "fixedCost": [
    { "id": "z-image-turbo", "usd": 0.01, "credits": 1, "multiplier": 0.42 }
  ],
  "updatedAt": "2026-07-03T00:00:00Z"
}
```

- `models[]` — per-token cost (already reflecting the current multiplier).
- `fixedCost[]` — per-image / per-video flat USD + credits + current `multiplier`.

## Capacity & rate limits

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /v1/capacity[?model=]` | public | Aggregated upstream (Venice) capacity for a model. |
| `GET /v1/limits/:model` | public | Per-model RPM/TPM (Venice limits, aggregated across providers). |
| `GET /v1/rate_limits` | `cdm_` key | **Your** operator-side throttle. |

## Response headers on every paid call

Read these instead of polling `/v1/credits` after each request:

| Header | Meaning |
|---|---|
| `x-carpe-cost-usdc-micro` | Cost of this call in USDC micro-units. |
| `x-carpe-input-tokens` / `x-carpe-output-tokens` | Token counts. |
| `x-carpe-balance-credits` | Escrow credits after this call. |
| `x-carpe-pending-credits` | Pending (settling) credits. |
| `x-carpe-available-credits` | Spendable credits after this call. |
| `x-carpe-route` | Provider/route that served the request. |

## CLI

The tested `carpe-media.sh` (in `carpe-diem-media/scripts/`) wraps auth resolution and budget guards. For credits and pricing:

```bash
bash .../carpe-media.sh credits      # print escrow / available balance
bash .../carpe-media.sh pricing      # print current per-model multipliers
```

## Errors

| Code | `code` | Meaning |
|---|---|---|
| `401` | `AUTH_REQUIRED`/`AUTH_FAILED` | Bad/missing credential. See [`carpe-diem-auth`](../carpe-diem-auth/SKILL.md). |
| `402` | `PAYMENT_REQUIRED` | Escrow exhausted on a paid call; body adds `credits_available`/`credits_required`. Top up USDC on Base. |
| `429` | `ENDPOINT_RATE_LIMITED`/`UPSTREAM_RATE_LIMIT` | Throttled; body adds a reset hint. Back off. |
| `503` | `BALANCE_CHECK_FAILED` | Transient escrow read failure; retry. |

## Gotchas

- Gate on `availableCredits` / `x-carpe-available-credits`, **not** `escrowCredits` — escrow includes pending charges and holds you can't spend.
- The pricing `multiplier` resets at **00:00 UTC** — a cost estimate made before midnight can be wrong after it.
- Credits are non-withdrawable; only deposit what you'll spend.
- Async jobs (video/image queues) place a **hold** that appears in `holdsCredits` until the job resolves or expires.
- This is Carpe Diem's own escrow — do **not** reach for Venice's `/billing/*` or `/x402/*` (they don't exist here).
