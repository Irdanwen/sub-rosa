---
name: carpe-diem-chat
description: Call POST /v1/chat/completions (OpenAI) or POST /v1/messages (Anthropic) on Carpe Diem. Use when the active key is a cdm_ Carpe Diem key and you need LLM text generation, tools, streaming, multimodal inputs, reasoning controls, structured output, or Venice-only venice_parameters (forwarded verbatim to the upstream Venice models).
---

# Carpe Diem Chat Completions

Carpe Diem (carpe-diem.xyz) is a TEE-sealed operator that proxies **Venice** verbatim and bills in prepaid credits. Its two text endpoints are:

- `POST /api/operator/v1/chat/completions` — OpenAI-compatible.
- `POST /api/operator/v1/messages` — Anthropic Messages API. The Anthropic base is `https://carpe-diem.xyz/api/operator` (NO `/v1`); the SDK appends `/v1/messages` itself.

Because Carpe Diem forwards request/response bodies unchanged to Venice, everything from the OpenAI/Anthropic shapes works, and **Venice-only `venice_parameters` still work** (web search, E2EE, characters, thinking control, X search).

> Use this when your key starts with `cdm_` (Carpe Diem). For a `VENICE_…` key calling `api.venice.ai` directly, use the `venice-*` skills instead.

## Use when

- You need LLM text generation, with or without tools, with or without streaming.
- You want multimodal inputs (images, audio, video) to a vision/audio-capable model.
- You want Venice-specific features: web search, E2EE, characters, xAI X/Twitter search, strip-thinking, web scraping (all forwarded through Carpe Diem to Venice).
- You need prompt caching for large system prompts or long documents.
- You need structured (`json_schema`) output.
- You want the Anthropic Messages surface for Claude models via an Anthropic-style SDK.

## Minimal request (OpenAI)

```bash
curl https://carpe-diem.xyz/api/operator/v1/chat/completions \
  -H "Authorization: Bearer $CARPE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "zai-org-glm-5-1",
    "messages": [{"role": "user", "content": "Why is the sky blue?"}]
  }'
```

Response shape is the standard OpenAI `chat.completion` object (`id`, `object: "chat.completion"`, `choices[].message`, `usage`). With `stream: true`, responses come as SSE `data:` lines in `chat.completion.chunk` format, terminated by `data: [DONE]`.

## Minimal request (Anthropic /v1/messages)

The Anthropic client base is `https://carpe-diem.xyz/api/operator` — it appends `/v1/messages`:

```bash
curl https://carpe-diem.xyz/api/operator/v1/messages \
  -H "Authorization: Bearer $CARPE_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-opus-4-7",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Why is the sky blue?"}]
  }'
```

With the Anthropic SDK, set `baseURL: "https://carpe-diem.xyz/api/operator"` (no `/v1`); the SDK constructs the `/v1/messages` path. The bearer is your `cdm_…` key, not an Anthropic key.

## The request body

### Core fields (OpenAI-compatible)

| Field | Notes |
|---|---|
| `model` | string — model ID, trait name, or compatibility mapping. Suffixes allowed (see below). Required. |
| `messages` | array of `system` / `developer` / `user` / `assistant` / `tool` messages. Required, min 1. |
| `temperature`, `top_p`, `top_k`, `min_p`, `min_temp`, `max_temp` | sampling controls |
| `repetition_penalty`, `frequency_penalty`, `presence_penalty` | repetition controls |
| `max_tokens` *(deprecated)* / `max_completion_tokens` | upper bound on output tokens |
| `n` | number of choices (keep `1` to minimize cost) |
| `seed` | integer for reproducibility |
| `stop` / `stop_token_ids` | up to 4 strings, or raw token IDs |
| `stream`, `stream_options.include_usage` | SSE streaming + include usage in the final chunk |
| `response_format` | `{type:"json_schema", json_schema:{...}}` (preferred), `{type:"json_object"}`, or `{type:"text"}` |
| `tools`, `tool_choice`, `parallel_tool_calls` | function calling / built-in tools |
| `logprobs`, `top_logprobs` | return token log-probabilities |
| `reasoning.effort` / `reasoning_effort` | `none` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` |
| `reasoning.summary` | `auto` \| `concise` \| `detailed` |
| `prompt_cache_key`, `prompt_cache_retention` (`default`/`extended`/`24h`) | prompt caching hints |
| `text.verbosity` | `low`/`medium`/`high`/`auto` |
| `metadata` | key/value strings for tracking |
| `user`, `store` | accepted but ignored (OpenAI compat) |

### `venice_parameters` (forwarded to Venice)

All optional. Carpe Diem forwards these verbatim to Venice, so they keep working through the proxy.

| Field | Type | Default | Effect |
|---|---|---|---|
| `character_slug` | string | — | Apply a published Venice character. |
| `strip_thinking_response` | bool | `false` | Strip `<think>...</think>` from the assistant output on reasoning models. |
| `disable_thinking` | bool | `false` | Disable thinking entirely on supported reasoning models and strip tags. |
| `enable_e2ee` | bool | `true` | End-to-end encryption on E2EE-capable models when E2EE headers are present. Set `false` to force TEE-only. |
| `enable_web_search` | `"off"`/`"auto"`/`"on"` | `"off"` | Server-side web search. Citations arrive in the first streamed chunk or the response. |
| `enable_web_scraping` | bool | `false` | Scrape any URLs found in the last user message. |
| `enable_web_citations` | bool | `false` | Ask the LLM to cite sources with `^1^` / `^1,3^` superscripts. |
| `include_search_results_in_stream` | bool | `false` | Experimental — emit search results as the first stream chunk. |
| `return_search_results_as_documents` | bool | — | Also surface search results as a synthetic tool call `venice_web_search_documents`. |
| `include_venice_system_prompt` | bool | `true` | Prepend the curated upstream system prompt. Turn off for full control. |
| `enable_x_search` | bool | `false` | xAI native web + X/Twitter search (Grok models with `supportsXSearch`). Adds ~$0.01/search. |

### Model feature suffixes

Some `venice_parameters` can also be expressed as **model feature suffixes** on the `model` string — useful when the caller/library (OpenAI SDK, LangChain) can't set `venice_parameters`. Syntax:

```
<model-id>:<key>=<value>[&<key>=<value>…]
```

Values are URL-decoded. Supported keys: `enable_web_search` (`on`/`off`/`auto`), `enable_web_citations`, `enable_web_scraping`, `include_venice_system_prompt`, `include_search_results_in_stream`, `return_search_results_as_documents`, `character_slug`, `strip_thinking_response`, `disable_thinking` (all bools as `"true"`/`"false"`). Unknown keys are silently ignored. Examples:

```
zai-org-glm-5-1:enable_web_search=on
kimi-k2-6:strip_thinking_response=true&enable_web_search=auto
zai-org-glm-5-1:character_slug=alan-watts
```

Note: `enable_e2ee` and `enable_x_search` can **only** be set via `venice_parameters`, not as suffixes.

## Messages and modalities

`messages[].content` is either a string or an array of typed parts. Roles: `user`, `assistant`, `tool`, `system`, `developer`.

### Text + image (`image_url`)

```json
{
  "model": "zai-org-glm-5-1",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "What's in this image?"},
      {"type": "image_url", "image_url": {"url": "https://example.com/cat.jpg"}}
    ]
  }]
}
```

- `url` accepts a public URL **or** `data:image/png;base64,...`.
- Models with `supportsMultipleImages: true` preserve images across the conversation; single-image vision models only keep images from the **last** user message. Check `maxImages` for the per-request cap.

### Audio input (`input_audio`)

```json
{"type": "input_audio", "input_audio": {"data": "<base64>", "format": "wav"}}
```

Formats: `wav`, `mp3`, `aiff`, `aac`, `ogg`, `flac`, `m4a`, `pcm16`, `pcm24`. Audio URLs are **not** supported — always inline base64.

### Video input (`video_url`)

```json
{"type": "video_url", "video_url": {"url": "https://www.youtube.com/watch?v=..."}}
```

Accepts public URLs (including YouTube for some providers) or `data:video/mp4;base64,...`. Formats: `mp4`, `mpeg`, `mov`, `webm`.

### Prompt caching (`cache_control`)

Any text / image_url / input_audio / video_url part can carry `{"cache_control": {"type": "ephemeral", "ttl": "1h"}}`. Combine with `prompt_cache_key` and `prompt_cache_retention: "24h"` on the root request.

## Tools & function calling

```json
{
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get current weather for a city",
      "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
      "strict": true
    }
  }],
  "tool_choice": "auto"
}
```

- `tool_choice` can also be `"required"`, `"none"`, or `{"type":"function","function":{"name":"get_weather"}}`.
- `parallel_tool_calls: true` (default) lets the model emit multiple calls at once.
- Respond by appending `{"role":"tool","tool_call_id":"...","content":"..."}` before the next call.
- Built-in tools `[{"type":"web_search"},{"type":"x_search"}]` map to the corresponding `venice_parameters`.

## Reasoning models

On thinking models (GLM 5.1, Kimi K2.6, Claude Opus 4.7, GPT-5.4 Pro, …):

```json
{
  "model": "zai-org-glm-5-1",
  "reasoning": {"effort": "medium", "summary": "auto"},
  "messages": [...]
}
```

- `reasoning_effort` is the OpenAI-compatible flat variant (takes precedence over `reasoning.effort`).
- Reasoning models may return `reasoning_content` or structured `reasoning_details[]`. **Pass `reasoning_details` back verbatim** in the next turn — it encodes thought signatures for Claude Opus 4.7 and GPT-5.4 Pro.

## Claude caveats (upstream, forwarded faithfully)

Carpe Diem forwards Claude requests to Venice unchanged, so Venice's Claude quirks carry through:

- **`claude-fable-5` + forced `tool_choice` → 400.** Forcing a specific tool (`{"type":"function","function":{"name":…}}`) or `"required"` on `claude-fable-5` returns 400. It works on other Claude models. Use `"auto"` on `claude-fable-5`.
- **Native Anthropic `thinking` block is silently dropped on all Claude models.** Do not rely on an Anthropic-style `thinking` content block coming back. Instead use `reasoning_effort: low|medium|high` (the Venice convention) on models with `supportsReasoningEffort`; the thinking surfaces in `reasoning_content`.

## Structured output (`response_format`)

```json
{"response_format": {"type": "json_schema", "json_schema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}}}
```

Prefer `json_schema` over the legacy `json_object`. Plain text is the default (`{"type": "text"}`).

## Streaming

```json
{"stream": true, "stream_options": {"include_usage": true}}
```

- Response is `text/event-stream`. Each event is `data: {...chunk...}\n\n`, terminated by `data: [DONE]`.
- `include_usage: true` adds a final chunk with token counts.
- With `venice_parameters.include_search_results_in_stream: true`, the **first** chunk carries `venice_search_results`.

## Billing & error handling

- Every paid call returns `x-carpe-*` headers (`x-carpe-cost-usdc-micro`, `x-carpe-input-tokens`, `x-carpe-output-tokens`, `x-carpe-balance-credits`, `x-carpe-available-credits`, `x-carpe-route`). See [`carpe-diem-credits`](../carpe-diem-credits/SKILL.md).
- `402 {"error":"…","code":"PAYMENT_REQUIRED"}` (with `credits_available`/`credits_required`) — top up; see credits.
- `400` — bad request / invalid model / content issue (Carpe Diem returns content violations as 400, not Venice's 422).
- `401 {"error":"Unauthorized","code":"AUTH_REQUIRED"}` — bad/missing key; see [`carpe-diem-auth`](../carpe-diem-auth/SKILL.md).
- `429`/`502`/`503` — retry with backoff (1s→2s→4s).

## Common gotchas

- `max_tokens` is deprecated on the OpenAI path — prefer `max_completion_tokens`. On the Anthropic `/v1/messages` path, `max_tokens` is required.
- Image URLs must be **publicly reachable** from the operator's network. Localhost / signed S3 URLs without public access fail.
- Audio inputs cannot be URLs — always base64.
- Single-image vision models drop older images on each turn; chain them into the **last** user message.
- Don't force `tool_choice` on `claude-fable-5` (→ 400) and don't expect a native `thinking` block on Claude — use `reasoning_effort`.
- `character_slug` **replaces** the default system prompt. Combine with `include_venice_system_prompt: false` for total control.
