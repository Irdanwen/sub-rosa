---
name: carpe-diem-audio-transcription
description: Transcribe audio files to text via POST /v1/audio/transcriptions through the Carpe Diem API (carpe-diem.xyz). Use when the active key is a cdm_ Carpe Diem key and you need speech-to-text for voice notes, meetings, podcasts, or short audio. OpenAI Whisper-compatible multipart.
---

# Carpe Diem Transcription (`/v1/audio/transcriptions`)

> Use this when your key starts with `cdm_` (Carpe Diem). For a `VENICE_…` key
> calling `api.venice.ai` directly, use the
> [`venice-audio-transcription`](../venice-audio-transcription/SKILL.md) skill
> instead.

`POST /v1/audio/transcriptions` takes an audio file and returns text. Carpe Diem
proxies Venice verbatim, so it is OpenAI Whisper-compatible with
`multipart/form-data` — the OpenAI SDK's `audio.transcriptions.create()` works
unchanged when pointed at the Carpe Diem base URL.

## Use when

- You need STT (speech-to-text) for voice notes, meetings, podcasts, or short
  audio and your key is a `cdm_…` key.

For music generation see
[`carpe-diem-audio-music`](../carpe-diem-audio-music/SKILL.md); for text-to-speech
see [`carpe-diem-audio-speech`](../carpe-diem-audio-speech/SKILL.md). Carpe Diem
has **no** video/YouTube transcription endpoint (that's a Venice-only surface).

## Minimal request

```bash
curl https://carpe-diem.xyz/api/operator/v1/audio/transcriptions \
  -H "Authorization: Bearer $CARPE_KEY" \
  -F "file=@./meeting.m4a" \
  -F "model=openai/whisper-large-v3"
```

```json
{ "text": "Alright everyone, let's kick off the meeting..." }
```

A successful call returns `200` with `{"text": "..."}`.

## Request (`multipart/form-data`)

| Field | Type | Notes |
|---|---|---|
| `file` | binary | **Required.** The audio file. Upload as a real multipart file part — base64 is **not** accepted. |
| `model` | string | **Required.** An ASR model — pick a row with `carpe_diem_type:"asr"` from `GET /v1/models`. |

Being OpenAI-compatible, standard Whisper form fields (`response_format`,
`language`, …) are forwarded verbatim to Venice.

## Discovering ASR models

Route by `carpe_diem_type`, never by model name. ASR (transcription) models are
the rows with `carpe_diem_type:"asr"`:

```bash
curl -s https://carpe-diem.xyz/api/operator/v1/models \
  | jq -r '.[] | select(.carpe_diem_type=="asr") | .id'
```

## OpenAI SDK

```ts
import OpenAI from 'openai'
import fs from 'node:fs'

const client = new OpenAI({
  apiKey: process.env.CARPE_KEY,
  baseURL: 'https://carpe-diem.xyz/api/operator/v1',
})

const out = await client.audio.transcriptions.create({
  file: fs.createReadStream('meeting.m4a'),
  model: 'openai/whisper-large-v3',
})

console.log(out.text)
```

## Errors

Carpe Diem error shape is `{"error":"<msg>","code":"<CODE>"}`.

| Code | Meaning |
|---|---|
| `400` | Bad params, unsupported audio format, empty file, or invalid model. Fatal — fix and retry. |
| `401` | `AUTH_REQUIRED` / `AUTH_FAILED` — bad or missing `cdm_` key. |
| `402` | `PAYMENT_REQUIRED` — insufficient credits (adds `credits_available`/`credits_required`). Top up. |
| `413` | `PAYLOAD_TOO_LARGE` — the audio file is too big; split it client-side. |
| `429` | `ENDPOINT_RATE_LIMITED` / `UPSTREAM_RATE_LIMIT` — retry with backoff (1s→2s→4s). |
| `502` / `503` | `VENICE_ERROR` / capacity — retry with backoff. |

## Gotchas

- **`file` must be a real multipart file part.** JSON + base64 is not supported
  here.
- **Route by `carpe_diem_type:"asr"`, not by model name.**
- For very long files, split client-side on silence (`ffmpeg` / `pydub`),
  transcribe each chunk, then concatenate. Carpe Diem exposes no native chunking.

  ```bash
  ffmpeg -i long.mp3 -f segment -segment_time 600 -c copy chunk_%03d.mp3
  ```
