---
name: carpe-diem-audio-speech
description: Generate speech from text via POST /v1/audio/speech through the Carpe Diem API (carpe-diem.xyz). Use when the active key is a cdm_ Carpe Diem key and you need TTS narration, voice replies, or UI audio. Covers model-specific voices, response formats, the ≤50000 char input cap, and per-character billing.
---

# Carpe Diem TTS (`/v1/audio/speech`)

> Use this when your key starts with `cdm_` (Carpe Diem). For a `VENICE_…` key
> calling `api.venice.ai` directly, use the
> [`venice-audio-speech`](../venice-audio-speech/SKILL.md) skill instead.

`POST /v1/audio/speech` converts text to a binary audio file. Carpe Diem proxies
Venice verbatim, so the request/response shape is OpenAI-compatible — the OpenAI
SDK's `audio.speech.create()` works as a drop-in when pointed at the Carpe Diem
base URL. Billed **per character**.

## Use when

- You want narration, voice replies, or UI audio from text and your key is a
  `cdm_…` key.
- You need a specific voice from a TTS model's own voice list.

For music generation (lyrics + instrumental) see
[`carpe-diem-audio-music`](../carpe-diem-audio-music/SKILL.md); for transcription
(audio → text) see
[`carpe-diem-audio-transcription`](../carpe-diem-audio-transcription/SKILL.md).

## Minimal request

```bash
curl https://carpe-diem.xyz/api/operator/v1/audio/speech \
  -H "Authorization: Bearer $CARPE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "tts-xai-v1",
    "voice": "eve",
    "input": "Hello, welcome to Carpe Diem.",
    "response_format": "mp3"
  }' --output hello.mp3
```

The response body is the raw audio (`Content-Type` matches `response_format`).

## Request schema

| Field | Type | Notes |
|---|---|---|
| `model` | string | **Required.** A TTS model — pick a row with `carpe_diem_type:"tts"` from `GET /v1/models`. |
| `input` | string | **Required.** Up to **50 000** characters. Billed per character. |
| `voice` | string | **Model-specific.** Omit for the model's default; otherwise pass a value from that model's `voices[]`. OpenAI's generic voice names are rejected. |
| `response_format` | `mp3` / `opus` / `aac` / `flac` / `wav` / `pcm` | Optional. Defaults to `mp3`. `pcm` returns 24 kHz signed-16 LE for pipelines. |

## Choosing a voice

Voices are **model-specific** and there is no universal voice set. To pick one:

1. `GET /v1/models` and find the row for your TTS model (`carpe_diem_type:"tts"`).
2. Read that row's **`voices[]`** array — it is the authoritative list.
3. Pass one of those values as `voice`, **or omit `voice` entirely** to use the
   model's default.

Passing a voice that isn't in the chosen model's `voices[]` — or an OpenAI
generic voice name (`alloy`, `nova`, …) — is a `400`.

```bash
# discover the voices a model supports
curl -s https://carpe-diem.xyz/api/operator/v1/models \
  | jq -r '.[] | select(.id=="tts-xai-v1") | .voices[]'
```

## OpenAI SDK

```ts
import OpenAI from 'openai'
import fs from 'node:fs/promises'

const client = new OpenAI({
  apiKey: process.env.CARPE_KEY,
  baseURL: 'https://carpe-diem.xyz/api/operator/v1',
})

const mp3 = await client.audio.speech.create({
  model: 'tts-xai-v1',
  voice: 'eve',           // must be in this model's voices[], or omit for default
  input: 'Hello from Carpe Diem.',
  response_format: 'mp3',
})

await fs.writeFile('hello.mp3', Buffer.from(await mp3.arrayBuffer()))
```

## Errors

Carpe Diem error shape is `{"error":"<msg>","code":"<CODE>"}`.

| Code | Meaning |
|---|---|
| `400` | Bad voice/model combo, OpenAI generic voice name, input over 50 000 chars, invalid model. Fatal — fix and retry. |
| `401` | `AUTH_REQUIRED` / `AUTH_FAILED` — bad or missing `cdm_` key. |
| `402` | `PAYMENT_REQUIRED` — insufficient credits (adds `credits_available`/`credits_required`). Top up. |
| `429` | `ENDPOINT_RATE_LIMITED` / `UPSTREAM_RATE_LIMIT` — retry with backoff (1s→2s→4s). |
| `502` / `503` | `VENICE_ERROR` / capacity — retry with backoff. |

## Gotchas

- **Voices are model-specific.** There is no shared voice set — always read the
  target model's `voices[]` on its `GET /v1/models` row, or omit `voice` for the
  default. OpenAI generic voice names are rejected.
- **`input` hard cap is 50 000 chars.** For longer content, split on sentence
  boundaries and concatenate the audio client-side.
- Voice names are case-sensitive (`eve` ≠ `EVE`).
- Content issues come back as `400` on Carpe Diem (there is no
  `422`/`suggested_prompt` shape — that's a Venice-audio-only path).
