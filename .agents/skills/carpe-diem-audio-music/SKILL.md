---
name: carpe-diem-audio-music
description: Async music / audio-track generation through the Carpe Diem API (carpe-diem.xyz). Use when the active key is a cdm_ Carpe Diem key and you need songs, jingles, score, soundscape, or sound effects. Covers the queue + retrieve poll loop and the per-model lyrics_prompt rules (required / optional / forbidden).
---

# Carpe Diem Music / Async Audio

> Use this when your key starts with `cdm_` (Carpe Diem). For a `VENICE_…` key
> calling `api.venice.ai` directly, use the
> [`venice-audio-music`](../venice-audio-music/SKILL.md) skill instead.

Music (and audio-track) generation is **asynchronous**. Unlike Venice, Carpe
Diem exposes **only two** endpoints — there is **NO** `/audio/quote` and **NO**
`/audio/complete` for music. The flow is just queue then poll:

```
POST /v1/audio/music/queue     → { queue_id }
POST /v1/audio/music/retrieve  → status, until "completed"
```

For short text-to-speech, use the synchronous
[`carpe-diem-audio-speech`](../carpe-diem-audio-speech/SKILL.md) endpoint instead.

## Use when

- You need songs, jingles, score, soundscape, or sound effects and your key is a
  `cdm_…` key.
- You can tolerate async execution.

## Lifecycle

### 1. `POST /v1/audio/music/queue` — enqueue

```bash
curl https://carpe-diem.xyz/api/operator/v1/audio/music/queue \
  -H "Authorization: Bearer $CARPE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "minimax-music-1-5",
    "prompt": "Uplifting indie-folk acoustic track, 120 BPM, major key.",
    "lyrics_prompt": "Verse 1: Walking through the city lights...\nChorus: We are the dreamers..."
  }'
```

Response: `{ "queue_id": "..." }`.

| Field | Notes |
|---|---|
| `model` | **Required.** A music model — pick a row with `carpe_diem_type:"music"` from `GET /v1/models`. |
| `prompt` | **Required.** Describe genre, mood, tempo, instruments. |
| `lyrics_prompt` | **Model-specific** (see table below). |

### 2. `POST /v1/audio/music/retrieve` — poll until completed

`/audio/music/retrieve` **needs BOTH `queue_id` and `model`**.

```bash
curl https://carpe-diem.xyz/api/operator/v1/audio/music/retrieve \
  -H "Authorization: Bearer $CARPE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"queue_id":"...","model":"minimax-music-1-5"}'
```

Poll every 2–5 s until the status is `completed`, then fetch the returned media.

There is **no** `/audio/complete` step — queue and retrieve is the whole loop.

## `lyrics_prompt` rules (per model)

`lyrics_prompt` behavior depends on the model. Getting it wrong is a `400`:

| Model | `lyrics_prompt` |
|---|---|
| `minimax-music-*` | **Required** |
| `ace-step-15` | **Optional** |
| `elevenlabs-music` | **Forbidden** (400) |
| `lyria-3-pro` | **Forbidden** (400) |
| `stable-audio-25` | **Forbidden** (400) |
| `elevenlabs-sound-effects-v2` | **Forbidden** (400) |
| `mmaudio-v2-text-to-audio` | **Forbidden** (400) |

## Full loop (TypeScript)

```ts
const base = 'https://carpe-diem.xyz/api/operator/v1'
const headers = {
  Authorization: `Bearer ${process.env.CARPE_KEY}`,
  'Content-Type': 'application/json',
}

async function generateTrack() {
  const { queue_id } = await fetch(`${base}/audio/music/queue`, {
    method: 'POST', headers,
    body: JSON.stringify({
      model: 'minimax-music-1-5',
      prompt: 'Uplifting indie-folk acoustic track, 120 BPM.',
      lyrics_prompt: 'Chorus: We are the dreamers...', // required for minimax-music-*
    }),
  }).then(r => r.json())

  while (true) {
    const body = await fetch(`${base}/audio/music/retrieve`, {
      method: 'POST', headers,
      body: JSON.stringify({ queue_id, model: 'minimax-music-1-5' }), // BOTH required
    }).then(r => r.json())

    if (body.status === 'completed') return body
    await new Promise(r => setTimeout(r, 3000))
  }
}
```

## Errors

Carpe Diem error shape is `{"error":"<msg>","code":"<CODE>"}`.

| Code | Meaning |
|---|---|
| `400` | Wrong params: `lyrics_prompt` supplied to a model that forbids it, missing `lyrics_prompt` on a `minimax-music-*` model, invalid model, or a content issue. Fatal — fix and retry. |
| `401` | `AUTH_REQUIRED` / `AUTH_FAILED` — bad or missing `cdm_` key. |
| `402` | `PAYMENT_REQUIRED` — insufficient credits (adds `credits_available`/`credits_required`). Top up. |
| `404` | On retrieve: unknown / expired `queue_id`. |
| `429` | `ENDPOINT_RATE_LIMITED` / `UPSTREAM_RATE_LIMIT` — retry with backoff (1s→2s→4s). |
| `502` / `503` | `VENICE_ERROR` / capacity — retry with backoff. |

## Gotchas

- **No `/audio/quote` and no `/audio/complete` for music** (unlike Venice) —
  just queue + retrieve.
- **`/audio/music/retrieve` needs both `queue_id` and `model`.**
- **Match `lyrics_prompt` to the model.** Required for `minimax-music-*`,
  optional for `ace-step-15`, forbidden (400) for `elevenlabs-music`,
  `lyria-3-pro`, `stable-audio-25`, `elevenlabs-sound-effects-v2`, and
  `mmaudio-v2-text-to-audio`.
- Store `queue_id` alongside the `model` — both are required for every poll.
- Content issues come back as `400` on Carpe Diem (no `422`/`suggested_prompt`).
