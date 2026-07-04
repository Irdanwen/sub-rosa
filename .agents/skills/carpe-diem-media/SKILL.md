---
name: carpe-diem-media
description: The ready-made CLI (carpe-media.sh) for generating images and videos (plus image edit/upscale) through Carpe Diem OR Venice — it auto-routes by key prefix (cdm_ -> Carpe Diem, VENICE_ -> Venice direct). Use when a task needs AI image generation, text-to-video, image-to-video, image editing, or upscaling — e.g. "generate an image", "make a video of", "edit this picture", "upscale", or any mention of Carpe Diem / Venice / cdm_ keys for media. Covers dual-backend key resolution (incl. the Sub Rosa app keychain), model discovery, sync vs async flows, per-family video durations, cost guards, and the CLI command set. For per-surface API detail load carpe-diem-api-overview first.
---

# Carpe Diem media generation (dual-backend CLI)

Generate images and videos with a single tested CLI that talks to **either
backend** and picks the right one from your key prefix:

- key starts with `cdm_` → **Carpe Diem** (`carpe-diem.xyz/api/operator/v1`)
- any other key (e.g. `VENICE_…`) → **Venice direct** (`api.venice.ai/api/v1`)

Same model catalogue and body shapes; the CLI adapts auth, balance reads, and the
video download per backend. For the full per-endpoint reference start at
[`carpe-diem-api-overview`](../carpe-diem-api-overview/SKILL.md) (or the `venice-*`
pack for a Venice key). Validated live against both backends (2026-07);
authoritative reference: https://carpe-diem.xyz/docs/api and https://docs.venice.ai.

## TL;DR — use the script

A deterministic CLI wraps the whole surface (auth resolution, queue/poll, cost
guards, error handling). Prefer it over hand-rolled `curl`:

```bash
S=".agents/skills/carpe-diem-media/scripts/carpe-media.sh"
bash $S credits                                    # balance (also validates the key)
bash $S models image                               # list models by type
bash $S image --model z-image-turbo --prompt "a red fox" --out fox.webp
bash $S video-quote --model seedance-2-0-mini-text-to-video --prompt "drone over forest" --duration 5s
bash $S video --model seedance-2-0-mini-text-to-video --prompt "drone over forest" \
       --duration 5s --aspect-ratio 16:9 --out clip.mp4
```

Exit codes: `0` success, `2` bad usage, `3` no valid key, `4` insufficient
credits / over `--max-usd`, `5` job failed or timed out.

## Auth — resolve, route, AND validate the key

- Header: `Authorization: Bearer <key>` on every call.
- **Backend is decided by key prefix** (the user's rule): `cdm_…` → Carpe Diem,
  anything else → Venice. The app's configured `base_url` only refines the host
  for a self-hosted deployment; it never overrides the prefix.
- **Never trust a key without validating it.** The CLI validates each candidate
  against the backend's balance endpoint (`GET /v1/credits` for Carpe Diem,
  `GET /api_keys/rate_limits` for Venice); the first that returns 200 wins. A bad
  key gives `401` on every endpoint, so an unvalidated key looks like anything.
- Public endpoints (`/v1/models`, `/models`, `/pricing`, `/v1/capacity`) return
  200 without a key — they prove nothing about it.
- The CLI resolves the key from, in order:
  1. `$CARPE_DIEM_API_KEY` / `$CARPEDIEM_API_KEY` / `$VENICE_API_KEY` (override),
  2. **the Sub Rosa app's key** — the one the user pasted in the app, stored in
     the macOS keychain (service `xyz.carpediem.subrosa.carpe-diem`, account
     `api-key`; debug builds use `xyz.carpediem.subrosa-dev.carpe-diem`). The
     app's `base_url` (from `carpe-diem.json`) is read as a host hint,
  3. known files (`~/.env.local`, `~/Documents/Codage/Bots/AudiBot/.env`,
     repo `.env.local`) — last-resort `cdm_` fallback.
- **Keychain one-time setup**: the item is ACL-protected by the app; from a
  script, `security` exits 128 (or hangs on an invisible prompt) until the user
  grants access once by running in a terminal:
  `security find-generic-password -s xyz.carpediem.subrosa.carpe-diem -a api-key -w`
  and clicking "Toujours autoriser". After that, reads are silent forever. The
  CLI hard-bounds the keychain read (`KEYCHAIN_TIMEOUT_DS`, default 4 s) and
  falls through to the other candidates rather than blocking — so a sandboxed
  run that can't reach the keychain still works via an env/file key.
  (Known state 2026-07: the Sub Rosa app on this machine holds a **Venice** key,
  so the CLI routes to Venice by default; the key in `~/.env.local` is stale;
  AudiBot's `.env` holds a working `cdm_` fallback.)

## Credits & cost guards

1 credit = $0.01. `GET /v1/credits` → `availableUsdc` / `availableCredits` is
what you can actually spend (escrow − pending − holds). Pricing is dynamic
(15%–100% of Venice's rate, resets 00:00 UTC): `GET /pricing` returns
`fixedCost[]` per image model (`costCredits`, current `multiplier`).

**Before any paid call**: check the balance covers the cost. For video, always
`POST /v1/video/quote` first (free, returns `{"quote": <USD>}`) — video runs
$0.4–$10+ per clip. Every paid response carries headers
`x-carpe-available-credits`, `x-carpe-pending-credits`, `x-carpe-balance-credits` —
read them to track budget without extra calls. Failed generations are not billed.

## Picking a model

`GET /v1/models` (public). Route on `carpe_diem_type` — **never on the model
name**:

| `carpe_diem_type` | Endpoint |
|---|---|
| `image` | `POST /v1/image/generate` (sync) or `…/generate/queue` (async) |
| `imageEdit` | `POST /v1/image/edit` (sync) or `…/edit/queue` (async) |
| `upscale` | `POST /v1/image/upscale` |
| `video` (text→video), `imageToVideo` | `POST /v1/video/queue` (always async) |

Sane defaults (cheapest → best, from live `/pricing`):
- **Image**: `z-image-turbo` / `venice-sd35` (0.94 cr, ~6 s), `gpt-image-2`
  (1.89 cr, heavy→async), `nano-banana-pro` (17 cr, frontier).
- **Video**: `seedance-2-0-mini-text-to-video` (~$0.47/5s),
  `kling-v3-standard-text-to-video` (~$0.69/5s), `sora-2-text-to-video`
  (~$0.44/4s). Image-to-video: same families with `-image-to-video` suffix.

## Images

**Sync** — `POST /v1/image/generate`, body
`{"model", "prompt", "variants"?}` (variants 1–4, prompt ≤ 10 000 chars).
200 → `{"id", "images": ["<base64>", …], "request": {...}, "timing": {...}}`.
Decode `images[0]` (WebP by default). Took 6.3 s for z-image-turbo in testing.

The response's `request.data` echoes the effective Venice params — observed
defaults: `format: webp`, 1024×1024, `steps: 8`, `hide_watermark: false`
(standard-tier images DO carry a visible "Venice" watermark). Extra Venice
fields (`width`, `height`, `hide_watermark`, `seed`, `negative_prompt`, …) are
not in Carpe Diem's documented body and are untested — if you need them, try
one call on a 0.94-credit model first rather than assuming passthrough.

**The edge proxy caps sync requests at ~60 s.** Heavy models (`gpt-image-2`,
`gpt-image-1-5`, `nano-banana-pro`, `recraft-v4-pro`, `*-edit` heavies) will 502
at the edge *even though the image was generated*. For those use the async
queue (each call returns <1 s):

1. `POST /v1/image/generate/queue` (same body) → `202 {"queue_id","status":"pending"}`
2. `POST /v1/image/generate/retrieve` `{"queue_id"}` every ~2 s —
   pending → JSON `{"status":"pending"}`; done → **binary image**
   (`Content-Type: image/*`); failure → error JSON
3. `POST /v1/image/generate/complete` `{"queue_id"}` — optional cleanup (15-min TTL backstop)

On a sync 502, fall back to the async path (the script does this automatically).

**Edit** — `POST /v1/image/edit` `{"model","prompt","image","aspect_ratio"?}`.
`image` is a **full data URI** (`data:image/png;base64,…`); HTTP URLs are NOT
fetched. Heavy edit models (`gpt-image-2-edit`): use `…/edit/queue` (5 MB max,
413 above).

**Upscale** — `POST /v1/image/upscale` `{"model":"upscaler","image","scale"?}`
(scale 1–4, default 2). `image` is **raw base64, no `data:` prefix** — the
opposite of `/edit`. Source must be ≥ 256×256 px, else 400.

## Video (always async)

```
quote (free, recommended) → queue → poll retrieve → download file
```

1. **Quote** — `POST /v1/video/quote`, same body as queue, forwarded to Venice
   verbatim. 200 → `{"quote": <USD>}`. Also your free payload validator: 400 if
   the model rejects `duration`/`aspect_ratio`/image params. Cheaper than
   debugging in `queue` (which places a hold on your balance).
   *Observed*: quote returns a generic `400 VENICE_ERROR` for `ltx-*` models even
   with valid params — for those, skip quote and go straight to queue.
2. **Queue** — `POST /v1/video/queue`
   `{"model","prompt","duration","aspect_ratio"?, …image params}` →
   job id in `id` (current) **or** `queue_id` (older shape) — accept both.
3. **Retrieve** — `POST /v1/video/retrieve` — **both** `{"queue_id","model"}`
   required. Poll every ~5 s. Running → `{"status":"processing"|"queued"|…}`;
   done → `{"status":"completed","video_url":"/v1/video/file/<id>"}`.
4. **Download** — `video_url` is relative to `https://carpe-diem.xyz/api/operator`
   (NOT `…/v1`): `GET https://carpe-diem.xyz/api/operator/v1/video/file/<id>`
   → `video/mp4`, no auth needed (opaque id).

**`duration` is a required string with an `s` suffix** (`"5s"`, never `5`).
Accepted values per family (validated upstream):

| Family | durations | notes on `aspect_ratio` |
|---|---|---|
| `sora-*` | 4s 8s 12s 16s | no `1:1` |
| `veo3*` | 4s 6s 8s | no `1:1` |
| `wan-*`, `kling-*`, `longcat*`, `grok-imagine*` | 5s 10s | longcat: no `1:1` |
| `seedance-2-0*` | 4s 5s 6s 8s 10s 12s 15s | also 4:3 / 3:4 |
| `seedance*` (1-5/older) | 4s–12s | also 4:3 / 3:4 |
| `pixverse-*` | 3s 5s 8s 10s | also 4:3 / 3:4 |
| `ltx-*` | 5s 8s 10s | also 4:3 / 3:4 |
| `vidu-*` | 3s 5s 8s 10s 12s 16s | also 4:3 / 3:4 |
| `happyhorse-*` | 3s 4s 5s 6s 8s 10s 12s | no `1:1` |

`16:9` and `9:16` work everywhere; omit to let Venice pick.

**Image conditioning** (for `imageToVideo` models): `image_url` (https URL or
data URI — required for `*-image-to-video`), `end_image_url` (last frame),
`image_urls[]` (reference sets). The operator forwards the body verbatim —
extra fields like `seed`, `negative_prompt`, motion controls reach the model
unchanged.

**Terminal poll errors — stop retrying**: 404 `VIDEO_JOB_NOT_FOUND` (expired),
403 `FORBIDDEN` (queue_id belongs to another wallet), 410 `VIDEO_KEY_REVOKED`
(re-queue from scratch). Same-account rule: any key of the wallet that queued
can poll; other wallets get 403.

## Errors & retries

All errors: `{"error": "<msg>", "code": "<CODE>"}`. 402 adds
`credits_available`/`credits_required`; 429 adds a reset hint.

- **Retry with backoff (1s→2s→4s)**: 429, 502 `VENICE_ERROR`, 503
  (`NO_PROVIDERS`, `INSUFFICIENT_PROVIDER_CAPACITY`, `TEE_NOT_READY`, …).
- **Fatal — fix, don't retry**: 400 (bad params/model), 401 (bad key),
  402 (top up at https://carpe-diem.xyz/dashboard — USDC on Base), 403, 404, 413.
- Rate limits mirror Venice per model: `GET /v1/limits/:model` (public);
  your own operator throttle: `GET /v1/rate_limits` (authed).

## Pitfalls checklist

- `/v1/image/edit` wants a data URI; `/v1/image/upscale` wants raw base64.
- Video `duration` must be `"Ns"` string; omit → 400.
- Video retrieve needs `model` alongside `queue_id`.
- `video_url` joins onto `/api/operator`, not `/api/operator/v1`… it already
  starts with `/v1/`.
- Queue response: read `id` falling back to `queue_id`.
- Public endpoints returning 200 don't validate your key.
- Sync image 502 ≠ failure: the image likely exists — re-run via async queue
  (you're only billed on retrievable success).
