---
name: carpe-diem-embeddings
description: Call POST /v1/embeddings on Carpe Diem. Use when the active key is a cdm_ Carpe Diem key and you need OpenAI-compatible text embeddings for retrieval, clustering, classification, or RAG. Covers request shape (input string or array, model), the {object:"list", data, model, usage} response, and per-input-token billing.
---

# Carpe Diem Embeddings

`POST /api/operator/v1/embeddings` returns vector embeddings for strings. Carpe Diem (carpe-diem.xyz) is a TEE-sealed operator that proxies **Venice** verbatim, so this endpoint is OpenAI-compatible: request and response match `https://api.openai.com/v1/embeddings` closely enough that the OpenAI SDK works out of the box with `baseURL: "https://carpe-diem.xyz/api/operator/v1"`.

> Use this when your key starts with `cdm_` (Carpe Diem). For a `VENICE_…` key calling `api.venice.ai` directly, use the `venice-*` skills instead.

## Use when

- You're building retrieval / RAG / similarity search.
- You need text clustering, classification, deduplication, or reranking.
- You want to route embeddings through Carpe Diem's prepaid-credit escrow rather than calling Venice directly.

Text-only. For image/multimodal signals, either run images through a vision chat model and embed the description, or pick a multimodal-capable embedding model from `GET /v1/models` (the catalog changes; inspect each row's `carpe_diem_type: "embedding"`).

## Minimal request

```bash
curl https://carpe-diem.xyz/api/operator/v1/embeddings \
  -H "Authorization: Bearer $CARPE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-bge-m3",
    "input": "Why is the sky blue?"
  }'
```

```json
{
  "object": "list",
  "model": "text-embedding-bge-m3",
  "data": [
    { "object": "embedding", "index": 0, "embedding": [0.0023, -0.0093, 0.0158, ...] }
  ],
  "usage": { "prompt_tokens": 8, "total_tokens": 8 }
}
```

## Request schema

| Field | Type | Notes |
|---|---|---|
| `model` | string | **Required.** Model ID with `carpe_diem_type: "embedding"` from `GET /v1/models`. |
| `input` | string \| string[] \| number[] \| number[][] | **Required.** Single string, array of strings, or pre-tokenized arrays. Forwarded verbatim to Venice. |
| `encoding_format` | `"float"` \| `"base64"` | Default `"float"`. Use `"base64"` for ~4× payload shrinkage; decode client-side. |
| `dimensions` | integer | Optional. Truncate output dimensions. Only meaningful when the model supports custom dimensions — test a small call first. |
| `user` | string | Accepted for OpenAI compat. Discarded. |

Carpe Diem forwards the body verbatim, so the per-string token cap and any batch limits are the upstream Venice model's (`maxInputTokens`, typically 8192; batch arrays typically ≤ 2048 items). One embedding is returned per element, in order, with a matching `index`.

## Billing

Embeddings are **billed per input token** through the Carpe Diem escrow (1 credit = $0.01). Every call returns `x-carpe-*` headers (`x-carpe-cost-usdc-micro`, `x-carpe-input-tokens`, `x-carpe-balance-credits`, `x-carpe-available-credits`, `x-carpe-route`). See [`carpe-diem-credits`](../carpe-diem-credits/SKILL.md) for the balance/pricing surface. Request `Accept-Encoding: gzip, br` for long batches — vectors are large.

## Using the OpenAI SDK

```ts
import OpenAI from 'openai'

const client = new OpenAI({
  apiKey: process.env.CARPE_KEY,           // a cdm_… key
  baseURL: 'https://carpe-diem.xyz/api/operator/v1',
})

const res = await client.embeddings.create({
  model: 'text-embedding-bge-m3',
  input: ['first doc', 'second doc'],
})

const vec0 = res.data[0].embedding
```

## Batch-embedding pattern

```ts
async function embedBatch(texts: string[], batchSize = 64) {
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize)
    const res = await client.embeddings.create({
      model: 'text-embedding-bge-m3',
      input: slice,
      encoding_format: 'float',
    })
    for (const row of res.data) out[i + row.index] = row.embedding
  }
  return out
}
```

- Keep batches ≤ model context limit total tokens.
- On `429`, back off exponentially (1s→2s→4s) and halve the batch.

## Choosing a model

Query `GET /v1/models` and filter to rows with `carpe_diem_type: "embedding"`. Built-in options mirror Venice's catalog: `text-embedding-bge-m3`, `text-embedding-bge-en-icl`, `text-embedding-qwen3-8b`, `text-embedding-qwen3-0-6b`, `text-embedding-multilingual-e5-large-instruct`, `text-embedding-3-small`, `text-embedding-3-large`, `gemini-embedding-2-preview`, `text-embedding-nemotron-embed-vl-1b-v2`. Use `GET /pricing` for per-model input-token cost (see [`carpe-diem-credits`](../carpe-diem-credits/SKILL.md)).

Always pin the model ID — cosine distances are **not** comparable across different embedding models.

## Error handling

| Code | Meaning |
|---|---|
| `400` `BAD_REQUEST`/`INVALID_MODEL` | Validation error, empty `input`, or bad model. Check `error` in the response. |
| `401` `AUTH_REQUIRED` | Bad/missing `cdm_` key. See [`carpe-diem-auth`](../carpe-diem-auth/SKILL.md). |
| `402` `PAYMENT_REQUIRED` | Insufficient credits (`credits_available`/`credits_required` in body). Top up. |
| `429` `ENDPOINT_RATE_LIMITED`/`UPSTREAM_RATE_LIMIT` | Rate limited; retry with backoff. |
| `502` `VENICE_ERROR` | Upstream inference failed; retry with jitter. |
| `503` `NO_PROVIDER_CAPACITY`/`MODEL_INFRA_SATURATED` | Model at capacity; retry later. |

## Gotchas

- `input` must not be empty; Carpe Diem rejects empty strings with `400`.
- `dimensions` is only meaningful on models that support custom dimensions — test with a small request before relying on it.
- Whether returned vectors are L2-normalized depends on the model — verify with `Math.hypot(...v) ≈ 1` before assuming.
- For RAG, store `model` alongside the vector so you can re-embed on upgrade.
