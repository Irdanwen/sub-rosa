---
name: carpe-diem-provider
description: Carpe Diem provider (supply-side) API for DIEM stakers lending a Venice key to the marketplace. Use when the active key is a cdm_ Carpe Diem key (or wallet JWT) and you're provisioning a TEE-sealed provider, checking attestation/status, revoking a provisioned key, or reading provider stats/usage/yield/rewards. Rarely needed by inference agents.
---

# Carpe Diem Provider API

The **supply side** of the Carpe Diem marketplace. DIEM stakers **lend their Venice API key** into a TEE-sealed operator; the operator serves buyer inference against that key and pays the provider **65% of each served request in DIEM**. This is the counterpart to the buyer-facing skills — most agents never touch it.

> Use this when your key starts with `cdm_` (Carpe Diem). For a `VENICE_…` key calling `api.venice.ai` directly, use the `venice-*` skills instead.

## Use when

- You stake DIEM and want to provision (or revoke) a Venice key into the marketplace.
- You need the TEE attestation before trusting the operator with a key.
- You want provider-side stats, usage, yield, or daily rewards.

If you only call inference, you do **not** need this — see [`carpe-diem-chat`](../carpe-diem-chat/SKILL.md) and [`carpe-diem-credits`](../carpe-diem-credits/SKILL.md).

## Provisioning (wallet-signed)

Provisioning a key is a **wallet-signed** operation (SIWE / wallet session), not a plain `cdm_` API-key call — you're binding an on-chain provider identity.

| Method + endpoint | Purpose |
|---|---|
| `POST /tee/provision` | Wallet-signed. Seal a Venice key into the TEE so the operator can serve buyer requests against it. |
| `GET /tee/status` | Provisioning / health status of your provider. |
| `GET /tee/providers` | List provisioned providers. |
| `GET /attestation` | TEE attestation document (public) — verify this **before** provisioning a key. |
| `DELETE /tee/providers/:address` | Remove a provider (stop lending). |
| `DELETE /tee/providers/:address/keys/:keyId` | Revoke a single sealed key from a provider. |

Verify the attestation first, then provision:

```bash
# 1. Confirm the TEE before trusting it with a key
curl https://carpe-diem.xyz/api/operator/attestation

# 2. Provision (wallet-signed; illustrative — sign per the wallet flow)
curl -X POST https://carpe-diem.xyz/api/operator/tee/provision \
  -H "Content-Type: application/json" \
  -d '{ "...wallet-signed provisioning payload..." }'
```

## Provider analytics

Read-only reporting on what your lent key has served and earned.

| Endpoint | Purpose |
|---|---|
| `GET /provider/stats` | Aggregate stats for your provider (requests served, uptime, etc.). |
| `GET /provider/usage` | Per-request served-inference ledger. |
| `GET /provider/usage/summary` | Aggregated usage (by model / day). |
| `GET /providers/:wallet/yield` | Yield accrued to a provider wallet. |
| `GET /providers/:wallet/rewards/daily` | Daily DIEM rewards breakdown. |

```bash
curl "https://carpe-diem.xyz/api/operator/providers/0xYOUR_WALLET/rewards/daily" \
  -H "Authorization: Bearer $CARPE_KEY"
```

## Economics

- Providers earn **65% of each served request, paid in DIEM**.
- Rewards float with the daily DIEM pool and the same pricing multiplier buyers see (15%–100% of Venice's rate; resets 00:00 UTC — see [`carpe-diem-credits`](../carpe-diem-credits/SKILL.md)).

## Gotchas

- Always fetch and verify `GET /attestation` **before** `POST /tee/provision` — you're handing a real Venice key to the enclave.
- Provisioning is wallet-signed; a plain `cdm_` buyer key cannot provision or revoke providers.
- Revoking a provider or a sealed key stops new inference against it; in-flight buyer jobs may surface `410 VIDEO_KEY_REVOKED`-style errors and need re-queueing on the buyer side.
