---
name: carpe-diem-api-overview
description: High-level map of the Carpe Diem API (carpe-diem.xyz) - the TEE-sealed, pay-per-use marketplace that proxies Venice models behind an OpenAI- and Anthropic-compatible surface with cdm_ keys and prepaid credits. Load this first for any Carpe Diem work. Covers the key-prefix routing rule (cdm_ -> Carpe Diem skills, VENICE_ -> venice-* skills), base URL, auth, credits/billing, endpoint categories, and the bundled CLI. Use when the active key is a cdm_ Carpe Diem key, or when deciding which pack to use.
---

# Carpe Diem API overview

Carpe Diem is a pay-per-use marketplace that serves **Venice** models through one
OpenAI- and Anthropic-compatible API. You call it with a `cdm_…` key and prepaid
credits; the operator runs inside a TEE (Intel TDX on Phala) and proxies Venice
verbatim. Because it forwards Venice's payloads unchanged, most request/response
bodies match Venice's — what differs is the base URL, auth, and the billing
surface (credits instead of Venice's DIEM/USD/x402).

> **This pack is for `cdm_…` keys.** In Sub Rosa the key comes from the app
> (macOS keychain) or an env var. **The pack you use is decided by the key
> prefix**, not by which model you want:
>
> | Key looks like | Backend | Use these skills |
> |---|---|---|
> | `cdm_…` | Carpe Diem (`carpe-diem.xyz/api/operator/v1`) | **`carpe-diem-*`** (this pack) |
> | `VENICE_…` (or any non-`cdm_`) | Venice direct (`api.venice.ai/api/v1`) | **`venice-*`** (the twin pack) |
>
> Same model catalogue, same body shapes — different host, auth, and billing.
> If you're not sure which key is active, run `credits` on the CLI (below): it
> prints the resolved backend.

## Use when

- You're starting any integration against `carpe-diem.xyz`.
- You need to know which endpoint serves which task, or which `carpe-diem-*`
  skill to load.
- You need the auth, credit, and response-header basics.
- You're deciding between the Carpe Diem pack and the `venice-*` pack.

## Base URL

```
https://carpe-diem.xyz/api/operator/v1     # OpenAI-compatible + native routes
https://carpe-diem.xyz/api/operator        # Anthropic base (SDK appends /v1/messages)
```

## Authentication

`Authorization: Bearer cdm_…` on every call. Two credential types:

- **API key `cdm_…`** — long-lived bearer, used for all inference. This is what
  agents use. An API key **cannot** create or revoke other keys.
- **Wallet session JWT (SIWE)** — for account management only (mint/revoke keys,
  dashboard). Not needed for inference.

There is **no** per-request x402/SIWE inference header (that's a Venice feature).
Validate a key with `GET /v1/credits` (200 = good). A bad key returns
`401 {"error":"Unauthorized","code":"AUTH_REQUIRED"}` on every endpoint.

**Public (no auth):** `GET /v1/models`, `/models`, `/pricing`, `/v1/capacity`,
`/v1/limits/:model`, `/health`, `/attestation`, `/snapshot/status`,
`GET /v1/video/file/:id`, `GET /v1/image/share/:id`. A 200 on these proves
nothing about your key — always validate against `/v1/credits`.

See [`carpe-diem-auth`](../carpe-diem-auth/SKILL.md).

## Endpoint map

| Category | Endpoints | Skill |
|---|---|---|
| Chat | `POST /v1/chat/completions`, `POST /v1/messages` | [`carpe-diem-chat`](../carpe-diem-chat/SKILL.md) |
| Embeddings | `POST /v1/embeddings` | [`carpe-diem-embeddings`](../carpe-diem-embeddings/SKILL.md) |
| Image gen | `POST /v1/image/generate` (+ async `/queue`) | [`carpe-diem-image-generate`](../carpe-diem-image-generate/SKILL.md) |
| Image edit | `POST /v1/image/edit`, `POST /v1/image/upscale` | [`carpe-diem-image-edit`](../carpe-diem-image-edit/SKILL.md) |
| TTS | `POST /v1/audio/speech` | [`carpe-diem-audio-speech`](../carpe-diem-audio-speech/SKILL.md) |
| STT | `POST /v1/audio/transcriptions` | [`carpe-diem-audio-transcription`](../carpe-diem-audio-transcription/SKILL.md) |
| Music (async) | `POST /v1/audio/music/queue`, `/retrieve` | [`carpe-diem-audio-music`](../carpe-diem-audio-music/SKILL.md) |
| Video (async) | `POST /v1/video/quote`, `/queue`, `/retrieve`, `GET /v1/video/file/:id` | [`carpe-diem-video`](../carpe-diem-video/SKILL.md) |
| Models | `GET /v1/models`, `/models`, `/pricing` | [`carpe-diem-models`](../carpe-diem-models/SKILL.md) |
| Credits & billing | `GET /v1/credits`, `/buyer/*`, `/v1/capacity`, `/deposits/quote` | [`carpe-diem-credits`](../carpe-diem-credits/SKILL.md) |
| Provider (supply) | `POST /tee/provision`, `GET /provider/*` | [`carpe-diem-provider`](../carpe-diem-provider/SKILL.md) |
| Errors & retries | uniform `{error, code}` | [`carpe-diem-errors`](../carpe-diem-errors/SKILL.md) |
| CLI + media quickstart | the `carpe-media.sh` wrapper | [`carpe-diem-media`](../carpe-diem-media/SKILL.md) |

**Not available on Carpe Diem** (use the `venice-*` twin against a Venice key if
you need them): `/responses`, `/characters*`, `/augment/*`, `/crypto/rpc/*`,
`/x402/*` (Carpe Diem uses its own on-chain escrow), `/api_keys` CRUD (dashboard +
wallet JWT instead), `/models/traits`, `/models/compatibility_mapping`,
`/image/multi-edit`, `/image/background-remove`, `/audio/quote`,
`/audio/complete`, `/video/complete`, `/video/transcriptions`.

## Credits & pricing (quick facts)

- **1 credit = $0.01.** `GET /v1/credits` → `availableCredits`/`availableUsdc`
  is what you can actually spend (escrow − pending − holds).
- Dynamic pricing floats 15%–100% of Venice's rate (daily DIEM pool, resets
  00:00 UTC), capped so you never pay more than Venice direct. `GET /pricing`
  for per-model fixed costs; `GET /v1/capacity` for the live multiplier.
- Every paid response carries `x-carpe-available-credits`,
  `x-carpe-balance-credits`, `x-carpe-pending-credits`, `x-carpe-cost-usdc-micro`,
  `x-carpe-route`. Read them to budget without extra calls.
- For video, always `POST /v1/video/quote` first (free) — clips run $0.4–$10+.

See [`carpe-diem-credits`](../carpe-diem-credits/SKILL.md).

## Model discovery

`GET /v1/models` (public). Route by the **`carpe_diem_type`** field
(`text|code|embedding|image|imageEdit|upscale|tts|asr|music|video|imageToVideo`),
never by model name. See [`carpe-diem-models`](../carpe-diem-models/SKILL.md).

## The CLI (fastest path)

A tested wrapper handles key resolution (incl. the Sub Rosa app keychain),
prefix-based backend routing, model discovery, sync/async image, and the video
queue/poll/download with budget guards. It works against **both** backends —
it picks Carpe Diem or Venice from the key prefix automatically.

```bash
S=".agents/skills/carpe-diem-media/scripts/carpe-media.sh"
bash $S credits                      # validate key + show balance + resolved backend
bash $S models image                 # discover models by type
bash $S image --model z-image-turbo --prompt "a red fox" --out fox.webp
bash $S video --model seedance-2-0-mini-text-to-video --prompt "drone over forest" \
       --duration 5s --aspect-ratio 16:9 --out clip.mp4
```

See [`carpe-diem-media`](../carpe-diem-media/SKILL.md) for the full command set,
exit codes, and the keychain one-time-grant note.

## Errors

Uniform `{"error":"<msg>","code":"<CODE>"}`. Retry with backoff on 429/502/503;
fatal (fix, don't retry) on 400/401/402/403/404/410/413. Full table in
[`carpe-diem-errors`](../carpe-diem-errors/SKILL.md).
