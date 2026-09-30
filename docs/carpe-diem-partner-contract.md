# Sub Rosa × Carpe Diem: partner key issuance and card top-ups (wire contract v1)

This is the single source of truth for every wire format between the Sub Rosa
app, the Sub Rosa account service (`subrosa-cloud`), the Carpe Diem operator
(TEE) and the Carpe Diem pay service (Next.js frontend, outside the TEE).
Copies live at `Sub Rosa/docs/carpe-diem-partner-contract.md` and
`CarpeDiem/docs/partner-integration.md`. Change both or neither.

## Names

- **Operator root** (`OPERATOR_PUBLIC_URL` on Carpe Diem): the public URL under
  which operator routes are served. Production: `https://carpe-diem.xyz/api/operator`.
  Local: `http://127.0.0.1:3001`. The app derives it from its configured Carpe
  Diem base URL by stripping a trailing `/v1` or `/router` (and a trailing `/`).
- **Partner id**: `subrosa`.
- **Issuer**: the account service `public_url` without trailing slash
  (production `https://subrosa.furetier.com`).
- **Device key**: a `cdm_` key issued for one Sub Rosa device. All device keys of
  one link share the Carpe Diem account balance (balances are per wallet).
- **Link**: the Carpe Diem row `(partner, subject) → wallet`. `subject` is the
  Sub Rosa account UUID. Never re-derived from the email after creation.
- base64url = RFC 4648 §5 without padding. All JWS are compact serialization.
- `jkt` = base64url(SHA-256(RFC 7638 canonical JWK `{"crv":"P-256","kty":"EC","x":…,"y":…}`)),
  always 43 characters.

## 1. Account service: the issuance assertion

`POST {issuer}/api/v1/carpe-diem/assertion`

Like every route of the account service, a success is wrapped as `{"data": …}`
and a failure is `{"error": {"code": "…", "message": "…"}}` (see
`accounts-sync-contract.md`). Checks run in this order:

- Not configured (no `[carpe_diem]` section): `404 not_found`, answered before
  any session is read, so an app can tell "this deployment does not issue keys"
  apart from "sign in again".
- No valid session: `401 unauthorized`.
- Auth: native bearer session (`Authorization: Bearer <access token>`) bound to a
  live device. Browser cookie sessions are refused (`403 device_required`).
- The session must be **recent**: `authenticated_at` within 300 s
  (`Service::recent`). Otherwise `403 recent_auth_required`, the service's
  existing step-up code, and the app asks the person to sign in again. A session
  minted by the device secret (`/api/v1/session/renew`) inherits the device's
  admission time and is therefore never recent (ADR 0056): a stolen device
  secret keeps a device signed in but can never mint it a key.
- Rate limit: 5 per minute per account (`429 slow_down`, `Retry-After: 5`).
- Request: exactly `{"jkt": "<43 base64url chars decoding to 32 bytes>"}`;
  anything else, including an unknown field → `400 invalid_request`.
- Response `200`: `{"data": {"assertion": "<jws>", "expires_at": "<RFC 3339>"}}`.

JWS header: `{"alg":"ES256","typ":"partner-assertion+jwt","kid":"<kid>"}`

Claims:

```json
{
  "iss": "https://subrosa.furetier.com",
  "aud": "https://carpe-diem.xyz/api/operator",
  "sub": "<account uuid>",
  "email": "<account email as last asserted by the identity provider, lowercase>",
  "email_verified": true,
  "device_id": "<device uuid>",
  "device_name": "<the device's name in this service, first 64 characters>",
  "scope": "key:issue",
  "cnf": {"jkt": "<jkt>"},
  "jti": "<uuid v4>",
  "iat": 1790000000,
  "exp": 1790000120
}
```

## 2. Proof of possession (app → operator)

Every call that exchanges an issuance assertion or polls a link request carries
`DPoP: <proof jws>` signed by the app's ephemeral P-256 key (generated per
issuance attempt, kept in memory only, never persisted).

Header: `{"alg":"ES256","typ":"dpop+jwt","jwk":{"kty":"EC","crv":"P-256","x":"…","y":"…"}}`
(no private members). Claims:

```json
{"htm":"POST","htu":"<operator root>/partner/keys","iat":1790000000,"jti":"<uuid>","ath":"<base64url(SHA-256(ascii bound value))>"}
```

- For `/partner/keys` the bound value is the assertion string.
- For `/partner/keys/poll` the bound value is the `linkRequestId`.
- The operator checks: `alg` ES256, `typ` `dpop+jwt`, signature under the embedded
  `jwk`, `htm`/`htu` exact string equality with `OPERATOR_PUBLIC_URL + path`,
  `|now - iat| ≤ 60 s`, `jti` single use, `ath`, and `jkt(jwk) == assertion.cnf.jkt`
  (or the jkt recorded on the link request for polls).
- ES256 signatures are raw `r||s` (64 bytes, IEEE P1363), not DER.

## 3. Operator: issue a device key

`POST {operator root}/partner/keys`

Headers: `Authorization: PartnerAssertion <assertion>`, `DPoP: <proof>`. Body `{}`.

Assertion checks: header `alg` exactly `ES256`, `typ` exactly
`partner-assertion+jwt`, `kid` in the pinned key set of a configured partner whose
`issuer` equals `iss` (keys come from `PARTNERS_JSON`, never fetched), `aud` equals
`OPERATOR_PUBLIC_URL`, `exp` in the future and `exp - iat ≤ 300`, `scope` equals
`key:issue`, `email_verified` is `true`, `email` valid, `sub` and `device_id` are
UUIDs, `jti` single use (stored until `exp`).

Account resolution:

1. A link `(partner, sub)` exists → its wallet. Update `last_asserted_email`.
2. No link and no Carpe Diem email account for `email` → create the email account
   (derived wallet, as `/auth/email/verify` would), create the link
   (`origin = partner`), issue. `linked: "created"`.
3. No link but an email account already exists for `email` (created on Carpe Diem
   directly or by another path) → do **not** link. Create a link request
   (15 min, single use, stores `jkt`, device name, a 6-character code from
   `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`) and email the account a consent link
   `{APP_BASE_URL}/link?r=<token>`. Answer `202`:

```json
{"status":"confirmation_required","linkRequestId":"<uuid>","code":"K7Q2MX","expiresAt":"<ISO>","emailHint":"m***@zssa.ch"}
```

Issuing (cases 1, 2 and a confirmed 3):

- If an active key already exists for `(partner, sub, device_id)`, revoke it first
  (re-issue = rotation).
- Limits per link: at most 3 issuances per rolling 24 h and 5 active partner keys
  → `429 {"code":"ISSUANCE_LIMITED"}`. Per partner: more than
  `maxIssuancePerHour` (default 60) issuances in the last hour suspends the
  partner (alert, `503 {"code":"PARTNER_SUSPENDED"}`) until an admin clears it.
- Key name `Sub Rosa - <device name sanitized to [A-Za-z0-9 -], at most 48 chars, or "device">`.
- Rail pinned to `credits` (`kv rail:<keyId> = credits`).
- A notification email to the Carpe Diem account's email (not the asserted one if
  they differ) naming the device, with a revoke-all link
  `{APP_BASE_URL}/link/revoke?t=<token>` (token valid 7 days, single use). The
  mail is sent after the key is stored; a mail failure is logged and alerts but
  does not fail the issuance.

Response `201`:

```json
{"status":"issued","key":"cdm_…","keyId":"<uuid>","prefix":"cdm_1a2b3c4d...","wallet":"0x…","linked":"created|existing|confirmed","availableCredits":0}
```

Errors (body `{"error": "...", "code": "..."}`): `404 NOT_FOUND` when no partner
is configured; `401 ASSERTION_INVALID`; `401 PROOF_INVALID`; `409 ASSERTION_REPLAYED`;
`429 ISSUANCE_LIMITED`; `503 PARTNER_SUSPENDED`.

### Poll a link request

`POST {operator root}/partner/keys/poll`, header `DPoP` (bound value
`linkRequestId`, key must match the request's `jkt`), body `{"linkRequestId":"…"}`.

- `202 {"status":"pending","expiresAt":"…"}`
- `201` issued (same body as above, `linked: "confirmed"`)
- `403 {"code":"LINK_DECLINED"}`, `410 {"code":"LINK_REQUEST_EXPIRED"}`,
  `401 PROOF_INVALID`. Rate limit 30/min per request id.

### Consent pages (Carpe Diem frontend → operator)

- `POST /partner/link/describe {"token"}` → `{"partner":"Sub Rosa","deviceName":"…","emailHint":"…","expiresAt":"…"}` or `410`.
- `POST /partner/link/confirm {"token","code"}` → `{"ok":true}`; wrong code → `400 CODE_MISMATCH` (5 attempts, then the request is declined).
- `POST /partner/link/decline {"token"}` → `{"ok":true}`.
- `POST /partner/link/revoke-all {"token"}` (from the notification mail) → `{"ok":true,"revoked":n}`.

## 4. Revocation

### Server to server (account service → operator)

`POST {operator root}/partner/keys/revoke`, header
`Authorization: PartnerAssertion <jws>` (same header/kid rules), body `{}`. Claims:

```json
{"iss":"…","aud":"…","sub":"<account uuid>","scope":"key:revoke","device_id":"<uuid or null>","reason":"device_revoked|signed_out|account_deleted","jti":"<uuid>","iat":…,"exp":…}
```

- `device_id: null` revokes every key of the link.
- `reason: "account_deleted"` also deletes the link row (a later Sub Rosa account
  with the same email goes through consent). The Carpe Diem email account and its
  balance stay; the person can reach them with a Carpe Diem magic link.
- Always `200 {"ok":true,"revoked":n}`, including for an unknown subject
  (idempotent). No DPoP (no `cnf`).

The account service enqueues a row in its durable outbox
(`partner_revocations`) inside the same transaction as:

- `DELETE /api/v1/devices/{id}` → `reason: "device_revoked"`, only the first
  time a live device is revoked (revoking a revoked device enqueues nothing);
- `POST /api/v1/session/renounce` (the app signing itself out) →
  `reason: "signed_out"`;
- `DELETE /api/v1/me` → `device_id: null`, `reason: "account_deleted"`. The
  row lives in the deletion transaction, so `reapply_deletion` replays it when
  a restored backup still holds the account.

A browser `POST /auth/logout` has no device and enqueues nothing. Restoring a
database (`restore-sanitize`, which revokes every device) enqueues nothing
either: re-issuing a key for the same device already revokes the previous one.

The 60 s maintenance loop leases up to 50 due rows, delivers them in the order
they were written, marks a row done on any `2xx` (the body is not read) and
otherwise backs off `2^attempts` minutes, capped at six hours, forever. Carpe
Diem must therefore treat a revocation as idempotent: the same `(sub,
device_id, reason)` may arrive more than once, each time with a new `jti`.

### Self revocation (app → operator)

`POST {operator root}/v1/keys/self/revoke` with `Authorization: Bearer cdm_…` →
`200 {"status":"revoked","id":"<keyId>"}`. Used on sign-out so the key dies
immediately even before the outbox drains.

## 5. Card top-ups

### Capabilities and tiers (public)

`GET {operator root}/partner/capabilities` → `{"keyIssuance":true,"fiat":true}`
(`keyIssuance` false when no partner is configured, `fiat` false unless the fiat
rail is armed: `FIAT_GRANT_SECRET` set and, in production, `STRIPE_RESTRICTED_KEY`).

`GET {operator root}/v1/billing/tiers` →

```json
{"currency":"usd","tiers":[{"id":"usd_5","usdCents":500,"credits":500},{"id":"usd_10","usdCents":1000,"credits":1000},{"id":"usd_25","usdCents":2500,"credits":2500},{"id":"usd_50","usdCents":5000,"credits":5000}]}
```

Tiers come from `FIAT_TIERS_JSON` on the operator: `[{"id","usdCents","micros","stripePriceId"}]`.
`credits = micros / 10_000`. `stripePriceId` is never exposed publicly.

### Checkout ticket (app → operator)

`POST {operator root}/v1/billing/checkout-ticket`, `Authorization: Bearer cdm_…`
(or a JWT session), body `{"tier":"usd_10"|null,"returnTo":"subrosa"|"dashboard"|null}`.

- `201 {"ticketId":"<uuid>","url":"{APP_BASE_URL}/pay?t=<ticketId>","expiresAt":"…"}`
- `404 FIAT_DISABLED`, `400 UNKNOWN_TIER`, `403 PURCHASE_BLOCKED` (the wallet ended
  with a shortfall after a refund or dispute), `429` (10 per hour per wallet).
- Ticket: 15 minutes, reusable until expiry, stores wallet, account email (if an
  email account), tier, returnTo.

### Ticket redemption (pay service → operator)

`POST {operator root}/billing/tickets/redeem`, header
`x-carpe-grant-signature: hex(HMAC-SHA256(FIAT_GRANT_SECRET, "redeem:<ticketId>"))`,
body `{"ticketId"}` →
`{"ticketId","wallet","email":null|"…","emailHint":"…","tier":null|"usd_10","returnTo":null|"subrosa","expiresAt","tiers":[{"id","usdCents","credits","stripePriceId"}],"limits":{"remainingUsdCents":…}}`
or `410 TICKET_EXPIRED`, `401`.

### Grant (pay service → operator, after Stripe says paid)

`POST {operator root}/credits/grant` (existing route, extended):

```json
{"grantId":"cs:<checkout session id>","wallet":"0x…","amountMicros":"10000000","country":"CH","cardCountry":"CH"}
```

- Signature unchanged: `grant:<grantId>:<wallet>:<micros>:<country or empty>`.
- `amountMicros` is a decimal integer string (the old float `usdcAmount` stays
  accepted for compatibility; never both).
- When `grantId` starts with `cs:`, the operator re-reads the session from Stripe
  (`GET https://api.stripe.com/v1/checkout/sessions/<id>?expand[]=line_items`
  with `STRIPE_RESTRICTED_KEY`) and requires `mode=payment`,
  `payment_status=paid`, `currency=usd`, `metadata.wallet == wallet`, exactly
  one line item whose `price.id` is a configured tier, and
  `amountMicros == tier.micros`. Otherwise `422 {"code":"STRIPE_MISMATCH"}`.
  In production a `cs:` grant without `STRIPE_RESTRICTED_KEY` is refused
  (`503 STRIPE_UNVERIFIABLE`).
- Global ceiling: fiat grants over the last 24 h may not exceed
  `FIAT_DAILY_CEILING_USDC` (default 5000) → `503 FIAT_CEILING` + alert.
- New-account ceiling: a wallet whose first fiat grant is less than 7 days old may
  not exceed 50 USD per 24 h and 100 USD per 7 days → `403 PURCHASE_LIMIT`.
  Checkout tickets check this too so the person is told before paying.

### Revoke (refund or dispute)

`POST {operator root}/credits/revoke`:

```json
{"revokeId":"re:<refund id>|dp:<dispute id>","grantRef":"cs:<session id>","wallet":"0x…","amountMicros":"5000000"}
```

- Signature: `revoke:<revokeId>:<wallet>:<micros>:<grantRef>` when `grantRef` is
  present (the old 3-field form stays for callers without `grantRef`).
- The operator caps the cumulative revoked micros for one `grantRef` at that
  grant's micros. A shortfall (credits already consumed) marks the wallet
  `PURCHASE_BLOCKED`.

### Purchases (app → operator)

`GET {operator root}/v1/billing/purchases` (cdm_ key or JWT) →
`{"purchases":[{"id":"cs:…","kind":"purchase|refund","usd":10,"credits":1000,"at":"<ISO>"}]}`
newest first, at most 50.

### Stripe session (pay service)

- `mode: payment`, one line item `price: tier.stripePriceId`,
  `metadata` and `payment_intent_data.metadata`: `wallet`, `ticketId`, `tier`, `micros`.
- `client_reference_id: wallet`, `customer_email` when known.
- `automatic_tax[enabled]` from `STRIPE_TAX_ENABLED`, `billing_address_collection: required`,
  `tax_id_collection[enabled]: true`, `allow_promotion_codes: false`,
  `payment_method_options[card][request_three_d_secure]: automatic`, no Adaptive Pricing.
- Idempotency key `checkout:<ticketId>:<tier>`.
- `success_url`: `{APP_BASE_URL}/pay/done?session_id={CHECKOUT_SESSION_ID}` (+ `&r=subrosa` when returnTo is subrosa),
  `cancel_url`: `{APP_BASE_URL}/pay?t=<ticketId>`.
- Webhook: verify `Stripe-Signature` (t, v1, 5 min tolerance) on the raw body.
  `checkout.session.completed` / `checkout.session.async_payment_succeeded` with
  `payment_status=paid` → grant `cs:<session.id>`, country =
  `customer_details.address.country`, cardCountry from the PaymentIntent's
  charge. `charge.refunded` → one revoke per refund `re:<refund.id>` with
  `micros = floor(grantMicros × refund.amount / charge.amount)`.
  `charge.dispute.created` → revoke `dp:<dispute.id>` for the full remaining grant.
  Answer 2xx only after the operator acknowledged (Stripe retries otherwise).

## 6. App deep link

`/pay/done?r=subrosa` offers a button to `subrosa://credits/return`. The app
treats it as "refresh the balance now"; the real signal is its own fast poll of
`GET /v1/credits` (every 3 s for 2 minutes after opening the checkout).
