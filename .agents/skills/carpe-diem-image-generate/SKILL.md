---
name: carpe-diem-image-generate
description: Generate images through Carpe Diem (carpe-diem.xyz), the credit-metered operator in front of Venice. Covers POST /v1/image/generate (sync, base64 response), the Carpe-Diem-only async /v1/image/generate/queue → /retrieve → /complete path for heavy models, request fields (prompt, variants, plus Venice passthroughs), and the standard-tier watermark. Use when the active key is a cdm_ Carpe Diem key.
---

# Carpe Diem Image Generation

> Use this when your key starts with `cdm_` (Carpe Diem). For a `VENICE_…` key
> calling `api.venice.ai` directly, use [`venice-image-generate`](../venice-image-generate/SKILL.md) instead.

Carpe Diem is a TEE-sealed operator that proxies **Venice** verbatim and bills
in prepaid credits (1 credit = $0.01). The request/response bodies are Venice's;
what changes is the base URL, the `cdm_` bearer, and an async wrapper Venice does
not have.

Base URL: `https://carpe-diem.xyz/api/operator/v1`
Auth: `Authorization: Bearer cdm_…` (a `cdm_` key, exported as `$CARPE_KEY`).

One text-to-image endpoint plus a heavy-model async path:

1. **`POST /v1/image/generate`** — sync, base64 (or binary) response, up to 4 variants.
2. **`POST /v1/image/generate/queue` → `/retrieve` → `/complete`** — Carpe-Diem-only
   async path for heavy models that would 502 at the edge cap on the sync path.

For editing / upscaling, see [`carpe-diem-image-edit`](../carpe-diem-image-edit/SKILL.md).
For picking a model, see [`carpe-diem-models`](../carpe-diem-models/SKILL.md).

> `/images/generations` (the OpenAI-compatible generation endpoint on Venice) is
> **not documented on Carpe Diem** — prefer `/v1/image/generate`.

## Use when

- You need to generate images from text prompts with a `cdm_` key.
- You need multiple variants in one call.
- You're calling a heavy model (`gpt-image-2`, `nano-banana-pro`, `recraft-v4-pro`, …)
  and the sync call keeps returning `502` — switch to the async queue path.

## The CLI (ready-made execution path)

The tested `carpe-media.sh` wraps auth resolution, model discovery, and both the
sync and async image flows with budget guards. Prefer it over hand-rolled curl:

```bash
bash .agents/skills/carpe-diem-media/scripts/carpe-media.sh \
  image --model z-image-turbo --prompt "A beautiful sunset over a mountain range" --out out.webp
```

## `/v1/image/generate` — sync

### Request

```bash
curl https://carpe-diem.xyz/api/operator/v1/image/generate \
  -H "Authorization: Bearer $CARPE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "z-image-turbo",
    "prompt": "A beautiful sunset over a mountain range",
    "variants": 1,
    "width": 1024,
    "height": 1024,
    "cfg_scale": 7.5,
    "steps": 8,
    "seed": 123456789,
    "format": "webp",
    "style_preset": "3D Model",
    "safe_mode": true
  }'
```

### Fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `model` | string | — | **Required.** Image model ID. Pick one with `carpe_diem_type:"image"` from `GET /v1/models`. |
| `prompt` | string | — | **Required.** ≤ 10 000 chars (per-model cap may be lower). |
| `variants` | int | 1 | 1–4. |
| `negative_prompt` | string | — | Passthrough, per the upstream Venice image spec. |
| `width`, `height` | int | 1024, 1024 | Passthrough. Must satisfy the model's `widthHeightDivisor`. |
| `aspect_ratio` | string | — | Passthrough (`"1:1"`, `"16:9"`, …) for ratio-driven models. |
| `resolution` | string | — | Passthrough (`"1K"`/`"2K"`/`"4K"`) for resolution-driven models. |
| `cfg_scale` | number | model default | Passthrough. |
| `steps` | int | model default | Passthrough (ignored by turbo models). |
| `seed` | int | 0 / random | Passthrough. |
| `format` | `"webp"`/`"png"`/`"jpeg"` | `webp` | Passthrough. |
| `style_preset` | string | — | Passthrough. |
| `hide_watermark` | bool | `false` | Passthrough (advisory — see gotchas). |
| `safe_mode` | bool | `true` | Passthrough; blurs adult content. |

> The Venice-native extra fields (`width`, `height`, `steps`, `seed`,
> `negative_prompt`, `format`, `style_preset`, `safe_mode`, `hide_watermark`,
> `cfg_scale`) are forwarded verbatim to Venice — treat them as passthrough, per
> the upstream Venice image spec.

### Response (200)

```json
{
  "id": "...",
  "images": ["<base64>", "<base64>"],
  "request": { ... },
  "timing": { ... }
}
```

`images[]` is an array of base64 strings (one per variant). Every paid call also
carries the credit headers (`x-carpe-cost-usdc-micro`, `x-carpe-balance-credits`,
`x-carpe-available-credits`, `x-carpe-route`, …).

## Async path — heavy models

Heavy models exceed the operator's **~60 s edge cap** on the sync path and return
`502` **even though the image was made**. When you target `gpt-image-2`,
`gpt-image-1-5`, `nano-banana-pro`, or `recraft-v4-pro`, use the async trio
instead. (Venice has no equivalent — this is Carpe-Diem-only.)

```bash
# 1. queue
curl https://carpe-diem.xyz/api/operator/v1/image/generate/queue \
  -H "Authorization: Bearer $CARPE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "nano-banana-pro", "prompt": "…", "aspect_ratio": "16:9"}'
# → 202 { "queue_id": "…", "status": "pending" }

# 2. poll (pending → JSON status; done → BINARY image bytes)
curl https://carpe-diem.xyz/api/operator/v1/image/generate/retrieve \
  -H "Authorization: Bearer $CARPE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"queue_id": "…"}' --output out.png

# 3. (optional) complete / free the slot early
curl https://carpe-diem.xyz/api/operator/v1/image/generate/complete \
  -H "Authorization: Bearer $CARPE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"queue_id": "…"}'
```

| Step | Endpoint | Body | Returns |
|---|---|---|---|
| Queue | `POST /v1/image/generate/queue` | same as sync `generate` | `202 {queue_id, status:"pending"}` |
| Poll | `POST /v1/image/generate/retrieve` | `{queue_id}` | pending → JSON status; done → **binary image** |
| Complete | `POST /v1/image/generate/complete` | `{queue_id}` | frees the slot (15-min TTL) |

You are **billed only on retrievable success**. The `carpe-media.sh` CLI handles
the queue/poll/complete loop for you.

## Sharing

`POST /v1/image/share` publishes an image and returns a public link served by
`GET /v1/image/share/:id` (no auth on the read side).

## Errors

| Code | Meaning |
|---|---|
| `400` | Bad params (bad dimensions, prompt too long, invalid model). Content-policy refusals also come back as `400`, not `422`. |
| `401` | Bad / missing `cdm_` key (`AUTH_REQUIRED`). |
| `402` | `PAYMENT_REQUIRED` — out of credits; body carries `credits_available` / `credits_required`. Top up (USDC on Base). |
| `413` | `PAYLOAD_TOO_LARGE`. |
| `429` | Rate limited — back off. |
| `502` | `VENICE_ERROR` — upstream, or the sync edge cap on a heavy model (switch to the async queue path). |
| `503` | Capacity (`NO_PROVIDERS`, `TEE_NOT_READY`, …) — retry with backoff. |

Full retry table in [`carpe-diem-errors`](../carpe-diem-errors/SKILL.md).

## Gotchas

- **No `422` content shape.** Carpe Diem returns `400` for content-policy issues,
  not Venice's `422` / `suggested_prompt` body.
- **Heavy models 502 on the sync path** even though the image was generated — this
  is the ~60 s edge cap, not a real failure. Use the async queue path for
  `gpt-image-2`, `gpt-image-1-5`, `nano-banana-pro`, `recraft-v4-pro`.
- **`retrieve` returns binary once done** — write it to a file, don't parse it as
  JSON. A JSON body from `retrieve` means the job is still pending.
- **Standard-tier images carry a visible "Venice" watermark** by default.
  `hide_watermark: true` is advisory and may not clear it on flagged content.
- **`/images/generations` is not documented on Carpe Diem** — use `/v1/image/generate`.
- Bill only lands on retrievable success for the async path; a `502` that never
  produced a retrievable image is not charged.
