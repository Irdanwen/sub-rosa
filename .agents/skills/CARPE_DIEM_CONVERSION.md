# Carpe Diem conversion sheet (Venice → Carpe Diem)

Canonical rules for adapting a `venice-*` SKILL.md into its `carpe-diem-*`
counterpart. Carpe Diem (carpe-diem.xyz) is a TEE-sealed operator that **proxies
Venice verbatim** and bills in prepaid credits — so most request/response bodies
are identical to Venice's; what changes is the base URL, auth, billing surface,
and a handful of async wrappers. Everything here was verified against the live
API and https://carpe-diem.xyz/docs/api (2026-07). When Carpe Diem does not
expose a Venice surface, say so explicitly rather than inventing an endpoint.

## Global replacements (apply to every skill)

| Venice | Carpe Diem |
|---|---|
| Base URL `https://api.venice.ai/api/v1` | `https://carpe-diem.xyz/api/operator/v1` |
| Anthropic base (for `/messages`) | `https://carpe-diem.xyz/api/operator` (SDK appends `/v1/messages`) |
| `$VENICE_API_KEY` | `$CARPE_KEY` (a `cdm_…` key) |
| `Authorization: Bearer <VENICE_API_KEY>` | `Authorization: Bearer cdm_…` (unchanged header, `cdm_` token) |
| Links `../venice-<x>/SKILL.md` | `../carpe-diem-<x>/SKILL.md` |
| Skill `name:` `venice-<x>` | `carpe-diem-<x>` |
| "Venice" as the product name | "Carpe Diem" (but keep "Venice" when naming the *upstream* that actually runs inference — Carpe Diem is a marketplace in front of Venice) |

Every `carpe-diem-*` skill's frontmatter `description` MUST include a phrase like
"Use when the active key is a `cdm_…` Carpe Diem key" so the router picks it over
the `venice-*` twin. Add a one-line note near the top:

> Use this when your key starts with `cdm_` (Carpe Diem). For a `VENICE_…` key
> calling `api.venice.ai` directly, use the `venice-*` skills instead.

## Auth (carpe-diem-auth)

- Two modes: **API key** `cdm_…` (bearer, for all inference — this is what agents
  use) and **wallet session JWT** (SIWE, for *account management* only: create/
  revoke keys, dashboard). An API key **cannot** mint other keys.
- Inference endpoints accept **either** a `cdm_` key or a wallet JWT.
- There is NO x402/SIWE-per-request inference header like Venice's `X-Sign-In-With-X`.
  Carpe Diem's wallet layer is for the escrow/dashboard, not per-call auth.
- Validate a key with `GET /v1/credits` (200 = good). `401 {"error":"Unauthorized",
  "code":"AUTH_REQUIRED"}` on every endpoint for a bad key — generic shape.
- Public (no auth): `GET /v1/models`, `/models`, `/pricing`, `/v1/capacity`,
  `/v1/limits/:model`, `/health`, `/attestation`, `/snapshot/status`,
  `GET /v1/video/file/:id`, `GET /v1/image/share/:id`.

## Billing → credits (carpe-diem-credits, replaces venice-billing + venice-x402)

Carpe Diem does NOT have Venice's `/billing/*` or `/x402/*`. Instead:

- `GET /v1/credits` (alias `GET /v1/billing/balance`) → `{escrowUsdc, pendingUsdc,
  holdsUsdc, availableUsdc, escrowCredits, pendingCredits, holdsCredits,
  availableCredits, updatedAt}`. **1 credit = $0.01.** `available*` is spendable
  (escrow − pending − holds). Auth: API key or JWT (no ADMIN/INFERENCE split).
- `GET /buyer/usage?limit=&offset=` → per-request ledger `{events:[{id,model,
  provider,prompt_tokens,completion_tokens,cost_usdc,multiplier,created_at}],total}`.
- `GET /buyer/usage/summary?days=` → `{byModel,byDay,totals}`.
- `GET /buyer/api-keys/usage?days=` · `GET /buyer/debt` → `{pendingUsdc,…}`.
- Top-ups: USDC on Base into the escrow; `GET /deposits/quote?token=&amount=` for
  non-USDC swaps. No withdrawal (credits are a usage entitlement).
- Response headers on every paid call: `x-carpe-cost-usdc-micro`,
  `x-carpe-input-tokens`, `x-carpe-output-tokens`, `x-carpe-balance-credits`,
  `x-carpe-pending-credits`, `x-carpe-available-credits`, `x-carpe-route`.
- Dynamic pricing: 15%–100% of Venice's rate, floats with the daily DIEM pool,
  resets 00:00 UTC. `GET /pricing` → `{models[], fixedCost[], updatedAt}`
  (`fixedCost[]` = per-image/per-video USD + credits + current `multiplier`).
- Capacity: `GET /v1/capacity[?model=]`, `GET /v1/limits/:model` (Venice RPM/TPM
  aggregated), `GET /v1/rate_limits` (your operator-side throttle).

## Models (carpe-diem-models)

- `GET /v1/models` (OpenAI-flat, public) — each row enriched with
  **`carpe_diem_type`** (`text|code|embedding|image|imageEdit|upscale|tts|asr|
  music|video|imageToVideo`), `tier` (`standard|premium|frontier`), `privacy`,
  `capabilities`, `context_length`, `voices` (tts only).
- `GET /models` (public) — same catalog grouped by category.
- **Route by `carpe_diem_type`, never by model name.** Mapping: text/code →
  chat; embedding → embeddings; image → image/generate; imageEdit → image/edit;
  upscale → image/upscale; tts → audio/speech; asr → audio/transcriptions;
  music → audio/music/queue; video & imageToVideo → video/queue.
- Carpe Diem does NOT expose `/models/traits` or `/models/compatibility_mapping`.
  Use `carpe_diem_type` + `tier` + `capabilities` to pick.
- `GET /pricing` gives per-model cost (see credits).

## Chat (carpe-diem-chat)

- `POST /v1/chat/completions` (OpenAI) and `POST /v1/messages` (Anthropic —
  base `…/api/operator`, no `/v1`). Body/response are Venice/OpenAI/Anthropic
  standard; Carpe Diem forwards verbatim, so `venice_parameters` still work.
- Claude caveats (upstream, forwarded faithfully): on `claude-fable-5`,
  `tool_choice` forcing a specific/required tool → 400 (works on other Claude
  models); Anthropic native `thinking` block is silently dropped on all Claude
  models — use `reasoning_effort: low|medium|high` (Venice convention, in
  `reasoning_content`) on models with `supportsReasoningEffort`.
- Streaming: `stream:true`, standard SSE, `data: [DONE]`.

## Embeddings (carpe-diem-embeddings)

- `POST /v1/embeddings` — OpenAI-compatible, `{model, input}` (string or array).
  Response `{object:"list", data:[{embedding:[…]}], model, usage}`. Billed per
  input token.

## Image generate (carpe-diem-image-generate)

- `POST /v1/image/generate` — sync, `{model, prompt, variants?}` (variants 1–4,
  prompt ≤ 10 000). 200 → `{id, images:["<base64>",…], request, timing}`.
  Venice-native extra fields (`width,height,steps,seed,negative_prompt,format,
  style_preset,safe_mode,hide_watermark,cfg_scale`) are forwarded verbatim to
  Venice — document them as "passthrough, per the upstream Venice image spec".
- **Carpe-Diem-only async path** (Venice has none): heavy models (`gpt-image-2`,
  `gpt-image-1-5`, `nano-banana-pro`, `recraft-v4-pro`) exceed the ~60 s edge cap
  on the sync path and 502 *even though the image was made*. Use
  `POST /v1/image/generate/queue` → `202 {queue_id,status:"pending"}`, poll
  `POST /v1/image/generate/retrieve {queue_id}` (pending→JSON, done→**binary
  image**), optional `POST /v1/image/generate/complete {queue_id}` (15-min TTL).
  Billed only on retrievable success.
- `POST /v1/image/share` / `GET /v1/image/share/:id` (public) to publish a link.
- Standard-tier images carry a visible "Venice" watermark by default.
- `/images/generations` (OpenAI-compat) is NOT documented on Carpe Diem — prefer
  `/v1/image/generate`.

## Image edit / upscale (carpe-diem-image-edit)

- `POST /v1/image/edit` — `{model, prompt, image, aspect_ratio?}`. `image` is a
  **full data URI** `data:image/png;base64,…` (HTTP URLs are NOT fetched).
  Heavy edit models (`gpt-image-2-edit`) use the async `…/edit/queue` →
  `/edit/retrieve` → `/edit/complete` trio (same shape as image generate; 5 MB
  max, 413 above).
- `POST /v1/image/upscale` — `{model:"upscaler", image, scale?}` (scale 1–4,
  default 2). `image` is **raw base64, NO `data:` prefix** (opposite of /edit).
  Source ≥ 256×256 px else 400.
- Carpe Diem does NOT expose `/image/multi-edit` or `/image/background-remove`.

## Audio speech / TTS (carpe-diem-audio-speech)

- `POST /v1/audio/speech` — `{model, input, voice?, response_format?}`, input
  ≤ 50 000 chars, billed per character, returns binary audio. Voices are
  model-specific: omit `voice` for the default, or read the `voices[]` array on
  the model's `GET /v1/models` row. OpenAI's generic voice names are rejected.

## Audio music (carpe-diem-audio-music)

- Async: `POST /v1/audio/music/queue {model, prompt, lyrics_prompt?}` →
  `{queue_id}`, then `POST /v1/audio/music/retrieve {queue_id, model}` until
  `completed`. `lyrics_prompt` is model-specific: required for `minimax-music-*`,
  optional for `ace-step-15`, forbidden (400) for `elevenlabs-music`,
  `lyria-3-pro`, `stable-audio-25`, `elevenlabs-sound-effects-v2`,
  `mmaudio-v2-text-to-audio`. Carpe Diem has NO `/audio/quote` or
  `/audio/complete` for music (unlike Venice) — just queue + retrieve.

## Audio transcription (carpe-diem-audio-transcription)

- `POST /v1/audio/transcriptions` — `multipart/form-data`, `file` + `model`,
  OpenAI Whisper-compatible. 200 → `{text}`. ASR models via
  `GET /v1/models` (`carpe_diem_type:"asr"`).

## Video (carpe-diem-video)

- Async, always: `quote (optional) → queue → poll retrieve → download file`.
- `POST /v1/video/quote` — same body as queue, forwarded to Venice; free; also a
  payload validator (400 if the model rejects a field). Returns `{quote:<USD>}`.
  Known: `ltx-*` models 400 on quote even when valid — skip quote for those.
- `POST /v1/video/queue` — `{model, prompt, duration, aspect_ratio?, …image
  params}`. `duration` is a **required string with `s` suffix** (`"5s"`, never
  `5`). Job id in `id` OR `queue_id` (accept both). Per-family durations:
  sora `4/8/12/16s` (no 1:1); veo3 `4/6/8s` (no 1:1); wan/kling/longcat/grok
  `5/10s`; seedance-2-0 `4/5/6/8/10/12/15s`; pixverse `3/5/8/10s`; ltx `5/8/10s`;
  vidu `3/5/8/10/12/16s`; happyhorse `3/4/5/6/8/10/12s`. `16:9`/`9:16` everywhere.
- Image-to-video (`carpe_diem_type:"imageToVideo"`): `image_url` (https or data
  URI, required), `end_image_url`, `image_urls[]`. Body forwarded verbatim (seed,
  negative_prompt, motion controls all reach Venice).
- `POST /v1/video/retrieve` — **needs `{queue_id, model}` both**. Running →
  `{status:"processing"|"queued"|…}`; done → `{status:"completed",
  video_url:"/v1/video/file/<id>"}`.
- Download: `video_url` joins onto `https://carpe-diem.xyz/api/operator` (NOT
  `…/v1`, since it already starts with `/v1/`). `GET …/api/operator/v1/video/
  file/:id` → `video/mp4`, no auth (opaque id).
- Terminal poll errors: 404 `VIDEO_JOB_NOT_FOUND`, 403 `FORBIDDEN` (other
  wallet), 410 `VIDEO_KEY_REVOKED` (re-queue). Carpe Diem has NO `/video/complete`
  or `/video/transcriptions` (unlike Venice).

## Errors (carpe-diem-errors)

- Shape: `{"error":"<msg>","code":"<CODE>"}`. 402 adds `credits_available`/
  `credits_required`; 429 adds a reset hint.
- Codes: 400 `BAD_REQUEST`/`INVALID_MODEL`/`MODEL_ERROR`; 401 `AUTH_REQUIRED`/
  `AUTH_FAILED`/`TOKEN_EXPIRED`; 402 `PAYMENT_REQUIRED`; 403 `OFAC_BLOCKED`/
  `FORBIDDEN`/`JWT_REQUIRED`; 404 `NOT_FOUND`/`VIDEO_JOB_NOT_FOUND`; 410
  `VIDEO_KEY_REVOKED`; 413 `PAYLOAD_TOO_LARGE`; 429 `ENDPOINT_RATE_LIMITED`/
  `UPSTREAM_RATE_LIMIT`; 451 geo; 502 `VENICE_ERROR`/`QUOTE_FAILED`; 503
  `NO_PROVIDERS`/`NO_PROVIDER_CAPACITY`/`INSUFFICIENT_PROVIDER_CAPACITY`/
  `MODEL_INFRA_SATURATED`/`TEE_NOT_READY`/`BALANCE_CHECK_FAILED`.
- Retry with backoff (1s→2s→4s): 429, 502, 503. Fatal (fix, don't retry): 400,
  401, 402 (top up), 403, 404, 410, 413.
- No `422 ContentViolationError`/`suggested_prompt` shape (that's Venice audio);
  content issues on Carpe Diem come back as 400.

## Provider API (carpe-diem-provider) — new, no Venice twin

For DIEM stakers lending their Venice key to the marketplace:
`POST /tee/provision` (wallet-signed), `GET /tee/status`, `GET /tee/providers`,
`GET /attestation`, `DELETE /tee/providers/:address[/keys/:keyId]`,
`GET /provider/stats`, `GET /provider/usage[/summary]`,
`GET /providers/:wallet/yield`, `GET /providers/:wallet/rewards/daily`.
Earn 65% of each served request in DIEM. (Document briefly; agents rarely need it.)

## Surfaces with NO Carpe Diem equivalent (state this, don't fake it)

`/responses` (Alpha), `/characters*`, `/augment/*`, `/crypto/rpc/*`,
`/x402/*` (Carpe Diem has its own on-chain escrow instead),
`/api_keys` CRUD (Carpe Diem manages keys via the dashboard + wallet JWT),
`/models/traits`, `/models/compatibility_mapping`, `/image/multi-edit`,
`/image/background-remove`, `/audio/quote`, `/audio/complete`,
`/video/complete`, `/video/transcriptions`.

## The CLI

A tested `carpe-media.sh` (in `carpe-diem-media/scripts/`) wraps auth resolution,
model discovery, sync/async image, and the video queue/poll/download with budget
guards. `carpe-diem-image-generate`, `-image-edit`, `-video`, `-models`,
`-credits` should each point to it as the ready-made execution path, e.g.:
`bash .../carpe-media.sh image --model z-image-turbo --prompt "…" --out x.webp`.
