---
name: carpe-diem-models
description: Discover Carpe Diem models, their type, tier, capabilities, and pricing. Covers GET /v1/models (public, OpenAI-flat, enriched with carpe_diem_type / tier / privacy / capabilities / voices), GET /models (grouped), GET /pricing, and how to route by carpe_diem_type rather than by model name. Use when the active key is a cdm_ Carpe Diem key.
---

# Carpe Diem Models

> Use this when your key starts with `cdm_` (Carpe Diem). For a `VENICE_…` key
> calling `api.venice.ai` directly, use [`venice-models`](../venice-models/SKILL.md) instead.

Carpe Diem proxies **Venice** and re-shapes the catalog. Two public read-only
discovery endpoints plus a pricing endpoint:

| Endpoint | Returns |
|---|---|
| `GET /v1/models` | OpenAI-flat list, each row enriched with `carpe_diem_type`, `tier`, `privacy`, `capabilities`, `context_length`, and `voices` (tts only). |
| `GET /models` | The same catalog grouped by category. |
| `GET /pricing` | Per-model cost in USD + credits, with the current dynamic `multiplier`. |

Base URL: `https://carpe-diem.xyz/api/operator/v1` (and `…/api/operator` for the
grouped `/models`). **All three are public — no auth required.**

> **Carpe Diem does NOT expose `/models/traits` or `/models/compatibility_mapping`.**
> Use `carpe_diem_type` + `tier` + `capabilities` to pick a model. Don't call the
> trait/compat endpoints.

## Use when

- You need to pick a model at runtime for a `cdm_` key.
- You need to route a task to the right endpoint (chat / image / video / …).
- You need the current per-model price to build a cost estimate.

## The CLI (ready-made execution path)

```bash
# list all models, or filter by carpe_diem_type
bash .agents/skills/carpe-diem-media/scripts/carpe-media.sh models image

# pricing, optionally filtered by type
bash .agents/skills/carpe-diem-media/scripts/carpe-media.sh pricing video
```

## `GET /v1/models`

```bash
curl https://carpe-diem.xyz/api/operator/v1/models
```

OpenAI-flat shape, each row enriched with Carpe Diem fields:

```json
{
  "object": "list",
  "data": [
    {
      "id": "z-image-turbo",
      "object": "model",
      "carpe_diem_type": "image",
      "tier": "standard",
      "privacy": "private",
      "capabilities": { "...": "..." },
      "context_length": null,
      "voices": null
    }
  ]
}
```

### Enrichment fields

| Field | Values | Use |
|---|---|---|
| `carpe_diem_type` | `text` · `code` · `embedding` · `image` · `imageEdit` · `upscale` · `tts` · `asr` · `music` · `video` · `imageToVideo` | **Route by this.** See mapping below. |
| `tier` | `standard` · `premium` · `frontier` | Quality / cost band. Standard-tier images carry the "Venice" watermark. |
| `privacy` | `private` · `anonymized` | Zero data retention if `private`. |
| `capabilities` | object | Vision / reasoning / function-calling / etc. flags (forwarded from Venice). |
| `context_length` | int / null | Context window for text/code models. |
| `voices` | array / null | Voice IDs — **tts only**; null for everything else. |

## Route by `carpe_diem_type`, never by name

Model names change; the `carpe_diem_type` tells you which endpoint to call:

| `carpe_diem_type` | Endpoint |
|---|---|
| `text` · `code` | `POST /v1/chat/completions` (or `/v1/messages`) |
| `embedding` | `POST /v1/embeddings` |
| `image` | `POST /v1/image/generate` |
| `imageEdit` | `POST /v1/image/edit` |
| `upscale` | `POST /v1/image/upscale` |
| `tts` | `POST /v1/audio/speech` |
| `asr` | `POST /v1/audio/transcriptions` |
| `music` | `POST /v1/audio/music/queue` |
| `video` · `imageToVideo` | `POST /v1/video/queue` |

## `GET /models` — grouped

```bash
curl https://carpe-diem.xyz/api/operator/models
```

Same catalog as `/v1/models`, grouped by category — handy for building a picker UI.

## `GET /pricing`

```bash
curl https://carpe-diem.xyz/api/operator/v1/pricing
```

Returns `{ models[], fixedCost[], updatedAt }`:

- `models[]` — per-model token/unit cost in USD + credits.
- `fixedCost[]` — per-image / per-video USD + credits with the current
  `multiplier` (the dynamic-pricing factor).

Carpe Diem's pricing is **dynamic**: 15%–100% of Venice's rate, floating with the
daily DIEM pool and resetting at 00:00 UTC. `GET /pricing` is the authoritative
current price. See [`carpe-diem-credits`](../carpe-diem-credits/SKILL.md) for
balance and the per-call `x-carpe-cost-usdc-micro` header.

## Common patterns

### Pick a standard image model

```ts
const list = await fetch(`${base}/v1/models`).then(r => r.json())
const model = list.data.find((m: any) =>
  m.carpe_diem_type === 'image' && m.tier === 'standard'
)
```

### Estimate a call's cost

```ts
const pricing = await fetch(`${base}/v1/pricing`).then(r => r.json())
const row = pricing.models.find((m: any) => m.id === myModel)
// 1 credit = $0.01; row carries the current multiplier-adjusted rate
```

## Gotchas

- **Route by `carpe_diem_type`, not by name** — names drift, the type is stable.
- **No `/models/traits`, no `/models/compatibility_mapping`.** Filter on
  `carpe_diem_type` + `tier` + `capabilities` instead.
- **`voices` is only populated for `tts` models** — null elsewhere.
- **Pricing floats daily** (15%–100% of Venice's rate). Re-read `/pricing` rather
  than caching a fixed number; caching for minutes is fine, days is not.
- The discovery + pricing endpoints are **public** — no `cdm_` key needed to browse.
