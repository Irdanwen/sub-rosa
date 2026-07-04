---
name: carpe-diem-video
description: Generate videos (text-to-video and image-to-video) through the Carpe Diem API (carpe-diem.xyz). Use when the active key is a cdm_ Carpe Diem key and the task needs async video generation — the quote (optional) + queue + retrieve-poll + download-file loop. Covers per-family durations, image-to-video refs, and the download join rule.
---

# Carpe Diem Video

> Use this when your key starts with `cdm_` (Carpe Diem). For a `VENICE_…` key
> calling `api.venice.ai` directly, use the [`venice-video`](../venice-video/SKILL.md)
> skill instead.

Video is **always asynchronous** on Carpe Diem. Carpe Diem proxies Venice
verbatim, so the request/response bodies mirror the upstream Venice video spec —
what changes is the base URL, the `cdm_` auth, and the fact that there are only
**three** endpoints (no `/video/complete`, no `/video/transcriptions`).

The flow is always: **quote (optional) → queue → poll retrieve → download file.**

| Endpoint | Purpose |
|---|---|
| `POST /v1/video/quote` | Price in USD (no charge, no job). Also a payload validator. Optional. |
| `POST /v1/video/queue` | Enqueue generation. Returns a job id in `id` or `queue_id`; reserves credits. |
| `POST /v1/video/retrieve` | Poll status; on completion returns a `video_url` to download. |

Carpe Diem has **NO** `/video/complete` and **NO** `/video/transcriptions`
(unlike Venice).

## Use when

- You need text-to-video or image-to-video and your key is a `cdm_…` key.
- You can tolerate async execution (single-digit seconds to several minutes
  depending on model, duration, and queue depth).
- You want to price a job precisely before committing (`/video/quote`).

## Ready-made CLI

The tested `carpe-media.sh` wraps auth resolution, the queue/poll/download loop,
and budget guards. Prefer it over hand-rolling curl:

```bash
bash .agents/skills/carpe-diem-media/scripts/carpe-media.sh \
  video --model wan-2-7-text-to-video --prompt "A city at dusk" --duration 5s --out out.mp4

bash .agents/skills/carpe-diem-media/scripts/carpe-media.sh \
  video-quote --model wan-2-7-text-to-video --prompt "A city at dusk" --duration 5s
```

## Lifecycle

### 1. Price with `/video/quote` (optional)

Same body as `/video/queue`, forwarded to Venice; free; also validates the
payload (400 if the model rejects a field). Returns `{"quote": <USD>}`.

```bash
curl https://carpe-diem.xyz/api/operator/v1/video/quote \
  -H "Authorization: Bearer $CARPE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "wan-2-7-text-to-video",
    "prompt": "Commerce being conducted in a canal city.",
    "duration": "5s",
    "aspect_ratio": "16:9"
  }'
```

Response: `{"quote": 0.35}` (USD).

> **`ltx-*` models return 400 on `/video/quote` even for a valid payload — skip
> the quote step for those and go straight to queue.**

### 2. Submit with `/video/queue`

```bash
curl https://carpe-diem.xyz/api/operator/v1/video/queue \
  -H "Authorization: Bearer $CARPE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "wan-2-7-text-to-video",
    "prompt": "A golden retriever chasing a frisbee in slow motion at sunset.",
    "duration": "5s",
    "aspect_ratio": "16:9"
  }'
```

Response carries the job id in **`id` OR `queue_id`** — accept both.

### 3. Poll with `/video/retrieve`

`/video/retrieve` **needs BOTH `queue_id` and `model`**.

```bash
curl https://carpe-diem.xyz/api/operator/v1/video/retrieve \
  -H "Authorization: Bearer $CARPE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"queue_id":"<id>","model":"wan-2-7-text-to-video"}'
```

- Running: `{"status":"processing"}` (or `"queued"`, etc.).
- Done: `{"status":"completed","video_url":"/v1/video/file/<id>"}`.

### 4. Download the file

The `video_url` is a **relative path starting with `/v1/`**, so it joins onto
`https://carpe-diem.xyz/api/operator` (**NOT** `…/api/operator/v1`, since the
path already starts with `/v1/`):

```bash
curl "https://carpe-diem.xyz/api/operator/v1/video/file/<id>" --output out.mp4
```

`GET …/api/operator/v1/video/file/:id` → `video/mp4`, **no auth** (the id is
opaque and public).

## `/video/queue` fields

Availability depends on the model — check `GET /v1/models` and route by
`carpe_diem_type` (`video` = text-to-video, `imageToVideo` = image-to-video).

| Field | Type | Notes |
|---|---|---|
| `model` | string | **Required.** |
| `prompt` | string | **Required** (min length 1). Max length varies per model. |
| `duration` | **string with `s` suffix** | **Required.** `"5s"`, never `5`. Model-specific subset (below). |
| `aspect_ratio` | string | `16:9` / `9:16` everywhere; `1:1` unsupported on sora/veo3. |
| `image_url` | https or `data:` URI | **Image-to-video only** — the reference frame (required for i2v). |
| `end_image_url` | https or `data:` URI | Image-to-video end frame / transition. |
| `image_urls[]` | array | Image-to-video reference images. |

Other Venice video fields (`seed`, `negative_prompt`, motion controls, …) are
forwarded verbatim to Venice — document them as passthrough per the upstream
Venice video spec.

### Per-family durations

`duration` must be one of the strings its model family accepts:

| Family | Allowed `duration` values | Notes |
|---|---|---|
| `sora` | `4s` / `8s` / `12s` / `16s` | no `1:1` |
| `veo3` | `4s` / `6s` / `8s` | no `1:1` |
| `wan` / `kling` / `longcat` / `grok` | `5s` / `10s` | |
| `seedance-2-0` | `4s` / `5s` / `6s` / `8s` / `10s` / `12s` / `15s` | |
| `pixverse` | `3s` / `5s` / `8s` / `10s` | |
| `ltx` | `5s` / `8s` / `10s` | skip `/video/quote` (400s) |
| `vidu` | `3s` / `5s` / `8s` / `10s` / `12s` / `16s` | |
| `happyhorse` | `3s` / `4s` / `5s` / `6s` / `8s` / `10s` / `12s` | |

`16:9` and `9:16` aspect ratios are supported everywhere.

## Common recipes

### Text → video

```json
{
  "model": "wan-2-7-text-to-video",
  "prompt": "A golden retriever chasing a frisbee in slow motion at sunset.",
  "duration": "5s",
  "aspect_ratio": "16:9"
}
```

### Image → video

`carpe_diem_type: "imageToVideo"` models. `image_url` (https or data URI) is
required:

```json
{
  "model": "<image-to-video model>",
  "prompt": "Camera slowly zooms out, revealing the cityscape.",
  "image_url": "https://example.com/cityscape.jpg",
  "end_image_url": "https://example.com/final-frame.jpg",
  "duration": "5s",
  "aspect_ratio": "16:9"
}
```

## Full polling loop (TypeScript)

```ts
const base = 'https://carpe-diem.xyz/api/operator/v1'
const operatorRoot = 'https://carpe-diem.xyz/api/operator'
const headers = {
  Authorization: `Bearer ${process.env.CARPE_KEY}`,
  'Content-Type': 'application/json',
}

async function waitForVideo(model: string, prompt: string, duration: string) {
  const queued = await fetch(`${base}/video/queue`, {
    method: 'POST', headers,
    body: JSON.stringify({ model, prompt, duration, aspect_ratio: '16:9' }),
  }).then(r => r.json())
  const queueId = queued.id ?? queued.queue_id // accept either

  while (true) {
    const body = await fetch(`${base}/video/retrieve`, {
      method: 'POST', headers,
      body: JSON.stringify({ queue_id: queueId, model }), // BOTH required
    }).then(r => r.json())

    if (body.status === 'completed') {
      // video_url starts with /v1/, so join onto operatorRoot (NOT base)
      const v = await fetch(`${operatorRoot}${body.video_url}`) // no auth needed
      return Buffer.from(await v.arrayBuffer())
    }
    await new Promise(r => setTimeout(r, 5000))
  }
}
```

## Errors

Carpe Diem error shape is `{"error":"<msg>","code":"<CODE>"}`.

| Code | Meaning |
|---|---|
| `400` | Bad params (missing/invalid `duration` string, unsupported family duration, `ltx-*` on quote, missing `image_url` for i2v, missing `prompt`). Fatal — fix and retry. |
| `402` | Insufficient credits (`PAYMENT_REQUIRED`, adds `credits_available`/`credits_required`). Top up. |
| `404` | `VIDEO_JOB_NOT_FOUND` — terminal. |
| `403` | `FORBIDDEN` — job belongs to another wallet. Terminal. |
| `410` | `VIDEO_KEY_REVOKED` — re-queue the job. Terminal. |
| `429` | `ENDPOINT_RATE_LIMITED` / `UPSTREAM_RATE_LIMIT` — retry with backoff (1s→2s→4s). |
| `502` / `503` | `VENICE_ERROR` / capacity — retry with backoff. |

## Gotchas

- **`duration` is a required string with the `s` suffix** — `"5s"`, never the
  integer `5`, and never omitted.
- **Job id may be in `id` OR `queue_id`.** Accept both from the queue response.
- **`/video/retrieve` needs both `queue_id` and `model`** — model alone or id
  alone is a 400/404.
- **The `video_url` download joins onto `…/api/operator`, not `…/api/operator/v1`.**
  It already starts with `/v1/`; double-prefixing gives you a wrong URL.
- The download endpoint takes **no auth** (opaque id).
- Skip `/video/quote` for `ltx-*` models — they 400 on quote even when the
  payload is valid.
- Carpe Diem has **no** `/video/complete` (no explicit finalize step) and **no**
  `/video/transcriptions` (no YouTube transcription). For audio-file
  transcription use [`carpe-diem-audio-transcription`](../carpe-diem-audio-transcription/SKILL.md).
