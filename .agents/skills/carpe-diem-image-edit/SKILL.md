---
name: carpe-diem-image-edit
description: Transform existing images through Carpe Diem (carpe-diem.xyz), the credit-metered operator in front of Venice. Covers POST /v1/image/edit (data-URI input, heavy models via /edit/queue) and POST /v1/image/upscale (raw base64, scale 1-4). Notes that Carpe Diem does NOT expose /image/multi-edit or /image/background-remove. Use when the active key is a cdm_ Carpe Diem key.
---

# Carpe Diem Image Editing

> Use this when your key starts with `cdm_` (Carpe Diem). For a `VENICE_…` key
> calling `api.venice.ai` directly, use [`venice-image-edit`](../venice-image-edit/SKILL.md) instead.

Carpe Diem proxies **Venice** verbatim and bills in prepaid credits
(1 credit = $0.01). Two edit-family endpoints:

| Endpoint | Purpose |
|---|---|
| `POST /v1/image/edit` | Transform one image with a text prompt. |
| `POST /v1/image/upscale` | Upscale 1–4× and/or enhance. |

Base URL: `https://carpe-diem.xyz/api/operator/v1`
Auth: `Authorization: Bearer cdm_…` (`$CARPE_KEY`).

> **Carpe Diem does NOT expose `/image/multi-edit` or `/image/background-remove`.**
> Those Venice endpoints have no Carpe Diem equivalent — don't call them. For
> compositing multiple images or transparent cutouts, use Venice directly.

For text-to-image generation, see [`carpe-diem-image-generate`](../carpe-diem-image-generate/SKILL.md).

## Use when

- You need to edit one image with a prompt using a `cdm_` key.
- You need to upscale an image 1–4×.
- You want the CLI to handle the data-URI / raw-base64 encoding difference for you.

## The CLI (ready-made execution path)

```bash
# edit one image with a prompt
bash .agents/skills/carpe-diem-media/scripts/carpe-media.sh \
  image-edit --model qwen-edit --prompt "Change the sky to a sunrise" --in photo.png --out edited.png

# upscale
bash .agents/skills/carpe-diem-media/scripts/carpe-media.sh \
  upscale --scale 2 --in small.png --out big.png
```

## `/v1/image/edit`

Edit one image with a short, descriptive prompt.

```bash
curl https://carpe-diem.xyz/api/operator/v1/image/edit \
  -H "Authorization: Bearer $CARPE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-edit",
    "prompt": "Change the color of the sky to a sunrise",
    "image": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg...",
    "aspect_ratio": "16:9"
  }'
```

| Field | Notes |
|---|---|
| `model` | Edit-capable model. Pick one with `carpe_diem_type:"imageEdit"` from `GET /v1/models`. Default `qwen-edit`. |
| `prompt` | Required. Short & specific works best. |
| `image` | Required. A **full data URI** — `data:image/png;base64,…`. HTTP(S) URLs are **not** fetched. |
| `aspect_ratio` | Optional; supported values vary per model (check `capabilities` on `GET /v1/models`). |

Good prompts: *"remove the tree"*, *"add sunglasses to the cat"*, *"make the sky a vivid orange sunrise"*.

### Heavy edit models — async path

Heavy edit models (e.g. `gpt-image-2-edit`) exceed the sync edge cap and use the
Carpe-Diem-only async trio, same shape as image generate:

```
POST /v1/image/edit/queue     {model, prompt, image}  → 202 {queue_id, status:"pending"}
POST /v1/image/edit/retrieve  {queue_id}               → pending → JSON; done → BINARY image
POST /v1/image/edit/complete  {queue_id}               → frees the slot
```

Max **5 MB** input; larger returns `413 PAYLOAD_TOO_LARGE`. Billed only on
retrievable success.

## `/v1/image/upscale`

Upscale by 1–4×.

```bash
curl https://carpe-diem.xyz/api/operator/v1/image/upscale \
  -H "Authorization: Bearer $CARPE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "upscaler",
    "image": "iVBORw0KGgoAAAANSUhEUg...",
    "scale": 2
  }'
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `model` | string | `"upscaler"` | The upscale model. |
| `image` | base64 | — | Required. **Raw base64, NO `data:` prefix** (the opposite of `/image/edit`). Source must be ≥ **256×256 px** or you get a `400`. |
| `scale` | 1..4 | 2 | Upscale factor. |

Response is the upscaled image as binary (`image/png` typically).

## Encoding asymmetry (read this)

The two endpoints disagree on how `image` is encoded — get it right or you get a `400`:

| Endpoint | `image` encoding |
|---|---|
| `/v1/image/edit` | **Full data URI** — `data:image/png;base64,…` |
| `/v1/image/upscale` | **Raw base64** — no `data:` prefix |

## Errors

| Code | Meaning |
|---|---|
| `400` | Bad params — source below 256×256 for upscale, wrong `image` encoding, unknown model. Content-policy refusals also come back as `400`. |
| `401` | Bad / missing `cdm_` key (`AUTH_REQUIRED`). |
| `402` | `PAYMENT_REQUIRED` — out of credits; body carries `credits_available` / `credits_required`. |
| `413` | `PAYLOAD_TOO_LARGE` — edit input above 5 MB. |
| `429` | Rate limited — back off. |
| `502` | `VENICE_ERROR` — upstream, or the sync edge cap on a heavy edit model (use the async path). |
| `503` | Capacity — retry with backoff. |

Full retry table in [`carpe-diem-errors`](../carpe-diem-errors/SKILL.md).

## Gotchas

- **Encoding differs per endpoint:** `/edit` wants a full `data:` URI, `/upscale`
  wants raw base64 with no prefix. Mixing them up is a `400`.
- **HTTP URLs are not fetched** by `/edit` — you must inline the bytes as a data URI.
- **No multi-edit, no background-remove** on Carpe Diem. If a task needs
  compositing 2–3 images or a transparent cutout, Carpe Diem can't do it.
- **Upscale needs ≥ 256×256** source; smaller inputs `400`.
- **Heavy edit models 502 on the sync path** — switch to `/edit/queue` →
  `/retrieve` → `/complete`.
- **No `422` content shape.** Content-policy issues return `400`.
