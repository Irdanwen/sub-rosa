---
name: carpe-diem-auth
description: Authenticate to the Carpe Diem API. Use when the active key is a cdm_ Carpe Diem key (or a wallet session JWT for account management) and you're making your first call, hit a 401, or need to know which endpoints are public. Covers the cdm_ bearer key for inference, the wallet SIWE JWT for key management, key validation via GET /v1/credits, and the public no-auth endpoints.
---

# Carpe Diem Authentication

Carpe Diem (carpe-diem.xyz) is a TEE-sealed operator that proxies **Venice** and bills in prepaid credits held in an on-chain escrow. It has **two auth modes** — and, unlike Venice, **no x402 / SIWE per-request inference header**.

> Use this when your key starts with `cdm_` (Carpe Diem). For a `VENICE_…` key calling `api.venice.ai` directly, use the `venice-*` skills instead.

## Use when

- You're making your first call to `carpe-diem.xyz/api/operator`.
- You hit `401 {"error":"Unauthorized","code":"AUTH_REQUIRED"}` and need to check the header.
- You need to know which mode signs which endpoints, or which endpoints are public.
- You're deciding between the `cdm_` key (inference) and the wallet JWT (account management).

## Mode A — API key (`cdm_…`) — for all inference

This is what agents use. A single bearer header, unchanged from Venice's format but with a `cdm_` token:

```http
Authorization: Bearer cdm_…
```

```bash
curl https://carpe-diem.xyz/api/operator/v1/chat/completions \
  -H "Authorization: Bearer $CARPE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "zai-org-glm-5-1",
    "messages": [{"role":"user","content":"hello"}]
  }'
```

- Use the `cdm_` key for **all inference** (chat, embeddings, image, audio, video) and for reading your own credits/usage.
- Billing draws from your prepaid credit escrow (1 credit = $0.01). See [`carpe-diem-credits`](../carpe-diem-credits/SKILL.md).
- There is **no ADMIN vs INFERENCE key split** like Venice. An API key **cannot** mint or revoke other keys — that requires the wallet JWT.

## Mode B — wallet session JWT (SIWE) — account management ONLY

Sign in with an Ethereum wallet (SIWE) to obtain a session JWT. This JWT is **only** for account management — creating and revoking API keys, and the dashboard. It is **not** required for, and adds nothing to, inference.

- Inference endpoints accept **either** a `cdm_` key **or** a wallet JWT, but the wallet JWT's real job is minting/revoking keys — something an API key cannot do.
- There is **NO** Venice-style `X-Sign-In-With-X` per-request inference header. Carpe Diem's wallet layer signs the escrow/dashboard flows, not individual inference calls. Do not try to carry a fresh SIWE signature on every chat request.

```
Authorization: Bearer <wallet-session-JWT>     # create/revoke keys, dashboard
```

## Validate a key

The cheapest liveness check is the credits endpoint — `200` means the key is good:

```bash
curl https://carpe-diem.xyz/api/operator/v1/credits \
  -H "Authorization: Bearer $CARPE_KEY"
```

A `200` returns your escrow/available balance (see [`carpe-diem-credits`](../carpe-diem-credits/SKILL.md)). Any bad or missing key returns a generic `401` on **every** endpoint:

```json
{ "error": "Unauthorized", "code": "AUTH_REQUIRED" }
```

Other 401 codes you may see: `AUTH_FAILED`, `TOKEN_EXPIRED` (JWT). A `403 JWT_REQUIRED` means you hit a key-management endpoint with an API key instead of a wallet JWT.

## Public endpoints (no auth)

These require **no** `Authorization` header at all:

| Endpoint | Purpose |
|---|---|
| `GET /v1/models`, `GET /models` | Model catalog (flat / grouped). |
| `GET /pricing` | Per-model dynamic pricing. |
| `GET /v1/capacity` | Aggregated upstream capacity. |
| `GET /v1/limits/:model` | Per-model rate limits. |
| `GET /health` | Operator health. |
| `GET /attestation` | TEE attestation document. |
| `GET /snapshot/status` | Escrow/snapshot status. |
| `GET /v1/video/file/:id` | Download a finished video (opaque id). |
| `GET /v1/image/share/:id` | Published image share link. |

Everything else — inference, `/v1/credits`, `/buyer/*`, key management — needs a `cdm_` key or wallet JWT.

## Choosing between the two modes

| Need | Pick |
|---|---|
| Run any inference (chat/embeddings/image/audio/video) | `cdm_` API key |
| Read your credit balance / usage ledger | `cdm_` API key (or JWT) |
| Create or revoke API keys | wallet session JWT (SIWE) |
| Dashboard / escrow management | wallet session JWT |

An API key **cannot** mint keys; a wallet JWT can do both management and inference, but for agents the `cdm_` key is the right tool.

## Common auth errors

| Status | Body `code` | Likely cause |
|---|---|---|
| `401` | `AUTH_REQUIRED` | Missing or malformed `Authorization` header. |
| `401` | `AUTH_FAILED` | Bad/unknown `cdm_` key or invalid JWT signature. |
| `401` | `TOKEN_EXPIRED` | Wallet session JWT expired — re-sign in. |
| `402` | `PAYMENT_REQUIRED` | Auth is fine but credits are exhausted — top up (see [`carpe-diem-credits`](../carpe-diem-credits/SKILL.md)). |
| `403` | `JWT_REQUIRED` | Tried to create/revoke a key with an API key — use the wallet JWT. |
| `403` | `OFAC_BLOCKED` / `FORBIDDEN` | Sanctioned wallet, or accessing another wallet's resource. |

## Security hygiene

- `cdm_` keys behave like passwords — store in a secret manager, rotate on compromise. A leaked key can spend your escrow.
- The wallet private key that signs the SIWE session must never ship in a client binary. Use a wallet provider (MetaMask, WalletConnect) in browsers.
- Revoke a compromised key from the dashboard (wallet JWT); the `cdm_` key itself can't self-revoke.
- Rate limits are per-key. See [`carpe-diem-credits`](../carpe-diem-credits/SKILL.md) for `GET /v1/rate_limits`.
