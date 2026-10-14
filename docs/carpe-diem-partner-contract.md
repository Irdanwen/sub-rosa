# Sub Rosa × Carpe Diem: partner key issuance and card top-ups (wire contract v1)

> Operator implementation: `operator/src/services/partners.ts`,
> `operator/src/routes/partnerRoute.ts`, `operator/src/services/fiat.ts`,
> `operator/src/routes/billingRoute.ts`, `operator/src/services/browserKeys.ts` (section 7).
> Tests: `operator/test/routes/partner-keys.test.ts`, `operator/test/routes/billing-tickets.test.ts`,
> `operator/test/routes/partner-browser-keys.test.ts`. The "Changes from v1 draft" section at
> the end lists what the implementation settled that the first draft left open.

This is the single source of truth for every wire format between the Sub Rosa
app, the Sub Rosa account service (`subrosa-cloud`), the Carpe Diem operator
(TEE) and the Carpe Diem pay service (Next.js frontend, outside the TEE).
Copies live at `Sub Rosa/docs/carpe-diem-partner-contract.md` and
`CarpeDiem/docs/partner-integration.md`, and they are identical, byte for
byte. Change both or neither.

Last synchronized 2026-10-14 against Sub Rosa `fix/partner-contract-sync` and Carpe Diem `fix/partner-keys-rail`.

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
`accounts-sync-contract.md`). Implementation: `subrosa-cloud/crates/api/src/carpe_diem.rs`
and `Service::carpe_diem_assertion` in `subrosa-cloud/crates/services/src/lib.rs`.
Checks run in this order:

- Not configured (no `[carpe_diem]` section): `404 not_found`, answered before
  anything is read, the body and the session included, so an app can tell
  "this deployment does not issue keys" apart from "sign in again" or "that
  request was malformed".
- Body: a JSON content type (`application/json`) and exactly
  `{"jkt": "<string>"}`; anything else, including an unknown field →
  `400 invalid_request`. The body bytes are kept whole: a browser device's
  proof is bound to them (section 7).
- No valid session: `401 unauthorized`. A browser cookie session must also
  carry the service's `Origin` and CSRF token, else `403 forbidden`.
- Auth: native bearer session (`Authorization: Bearer <access token>`) bound to a
  live device. Browser cookie sessions are refused (`403 device_required`),
  unless the browser is an admitted browser device (section 7).
- The session must be **recent**: `authenticated_at` within 300 s
  (`Service::recent`). Otherwise `403 recent_auth_required`, the service's
  existing step-up code, and the app asks the person to sign in again. A session
  minted by the device secret (`/api/v1/session/renew`) inherits the device's
  admission time and is therefore never recent (ADR 0056): a stolen device
  secret keeps a device signed in but can never mint it a key.
- Rate limit: 5 per minute per account (`429 slow_down`, `Retry-After: 5`).
- `jkt` must be 43 base64url characters decoding to 32 bytes, else
  `400 invalid_request`.
- A browser device's proof is then verified (`401 device_proof_invalid`,
  section 7), and the device must still be live (`401 unauthorized`).
- Before signing, the service writes a `carpe_diem_key_requested` line in the
  account's security history; if that write fails, no assertion is signed.
- Response `200`: `{"data": {"assertion": "<jws>", "expires_at": "<RFC 3339>"}}`.

JWS header: `{"alg":"ES256","typ":"partner-assertion+jwt","kid":"<kid>"}`

Claims (`exp - iat` is 120 s):

```json
{
  "iss": "https://subrosa.furetier.com",
  "aud": "https://carpe-diem.xyz/api/operator",
  "sub": "<account uuid>",
  "email": "<account email as last asserted by the identity provider, lowercase>",
  "email_verified": true,
  "device_id": "<device uuid>",
  "device_name": "<the device's name in this service, truncated to at most 64 Unicode code points>",
  "scope": "key:issue",
  "cnf": {"jkt": "<jkt>"},
  "kind": "browser (browser devices only, section 7)",
  "bound": {"daily_cap_credits": 200, "valid_seconds": 604800},
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

Headers: `Authorization: PartnerAssertion <assertion>`, `DPoP: <proof>`. Body `{}`,
or `{"reactivate": true}` after a `410 ACCOUNT_CLOSED` (see below).

Assertion checks: header `alg` exactly `ES256`, `typ` exactly
`partner-assertion+jwt`, no `crit`, `kid` in the pinned key set of a configured partner whose
`issuer` equals `iss` (keys come from `PARTNERS_JSON`, never fetched), `aud` equals
`OPERATOR_PUBLIC_URL`, `exp` in the future, `iat` at most 60 s in the future and
`0 < exp - iat ≤ 300`, `scope` equals
`key:issue`, `email_verified` is `true`, `email` valid, `sub` and `device_id` are
UUIDs, `jti` single use (stored until `exp`). Both `jti` (the assertion's and the
proof's) are consumed only once everything else checked out, so a bad proof
never burns a good assertion.

Account resolution:

0. The person deleted the Carpe Diem account this subject was linked to (from
   the Carpe Diem dashboard, or as an inactive email account): the operator
   keeps `(partner, sub, closed_at)`, without the email, for 10 years, and
   answers `410 {"code":"ACCOUNT_CLOSED","closedAt":"<ISO>"}` instead of
   recreating the account (it would bring back the email address the deletion
   erased). See "Deleted Carpe Diem account" below.
1. A link `(partner, sub)` exists → its wallet. Update `last_asserted_email`.
   If the link is marked `consent_required` (section 3, consent pages), go
   through the consent of case 3 with the Carpe Diem account's own email.
2. No link and no Carpe Diem email account for `email` → create the email account
   (derived wallet, as `/auth/email/verify` would), create the link
   (`origin = partner`), issue. `linked: "created"`.
3. No link but an email account already exists for `email` (created on Carpe Diem
   directly or by another path) → do **not** link. Create a link request
   (15 min, single use, stores `jkt`, device name, a 6-character code from
   `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`) and email the account a consent link
   `{APP_BASE_URL}/link?r=<token>`. At most 3 such mails per address per hour
   (then `429 ISSUANCE_LIMITED`), so even a compromised partner cannot flood a
   mailbox. Answer `202`:

```json
{"status":"confirmation_required","linkRequestId":"<uuid>","code":"K7Q2MX","expiresAt":"<ISO>","emailHint":"m***@zssa.ch"}
```

Issuing (cases 1, 2 and a confirmed 3):

- If an active key already exists for `(partner, sub, device_id)`, revoke it first
  (re-issue = rotation).
- Limits per link: at most 3 issuances per rolling 24 h (rotations included) and
  5 active partner keys (neither revoked nor expired, not counting this
  device's current key, which the issuance replaces) → `429 {"code":"ISSUANCE_LIMITED"}`. Per partner: more than
  `maxIssuancePerHour` (default 60) issuances in the last hour suspends the
  partner (alert, `503 {"code":"PARTNER_SUSPENDED"}`) until an admin clears it.
- Key name `<partner name> - <device name>`: accents are stripped (NFKD), anything
  outside `[A-Za-z0-9 -]` becomes a space and runs of spaces collapse, the
  partner part is at most 12 chars (`Partner` when empty), the device part is at
  most 48 chars, `device` when empty. Example: `Sub Rosa - iPhone de Morgan`.
- Rail pinned to `credits` (`kv rail:<keyId> = credits`, `railFallback:<keyId> = 0`).
  A partner key pays in credits only, whatever wallet carries it: after the
  account is linked to a real wallet, that wallet's prepaid account and
  fallback never apply to it, and it cannot open prepaid itself
  (`/v1/prepaid/register` and any rail change towards prepaid answer
  `403 WALLET_SESSION_REQUIRED`). See `services/prepaid/creditsOnlyKeys.ts`.
- Issuing counts as activity of the Carpe Diem email account (it resets the
  24-month inactivity clock), like a sign-in.
- A notification email to the Carpe Diem account's email (not the asserted one if
  they differ) naming the device, with a revoke-all link
  `{APP_BASE_URL}/link/revoke?t=<token>` (token valid 7 days, single use). The
  mail is sent after the key is stored; a mail failure is logged and alerts but
  does not fail the issuance. A wallet with no Carpe Diem email account gets no
  mail.

Response `201`:

```json
{"status":"issued","key":"cdm_…","keyId":"<uuid>","prefix":"cdm_1a2b3c4d...","wallet":"0x…","linked":"created|existing|confirmed","availableCredits":0}
```

A browser key's body also carries `expiresAt` and `bound` (section 7).

Errors (body `{"error": "...", "code": "..."}`): `404 NOT_FOUND` when issuance is
not open (see "Operator configuration"); `401 ASSERTION_INVALID`; `401 PROOF_INVALID`
(the proof's `iat` is the only value signed by the device clock, so a device more
than 60 s off gets this one; a replayed proof gets it too); `403 DEVICE_REVOKED` (that device was revoked, it
never receives a key again); `403 ASSERTION_REVOKED` (signed before a revocation
of the whole subject, ask a fresh one); `409 ASSERTION_REPLAYED`;
`409 CONSENT_UNAVAILABLE`; `410 ACCOUNT_CLOSED`; `429 ISSUANCE_LIMITED` (per link
limits, retry tomorrow); `429 RATE_LIMITED` (more than 20 requests a
minute from one IP, retry in a minute; the body also carries `retry_after_ms`);
`503 PARTNER_SUSPENDED`. A request from a
blocked country is refused by the geoblock before the route, `451` with no `code`
(body `{"error","message"}`).

`403 ASSERTION_REVOKED`: the assertion was signed at or before the subject's
revocation cutoff (a deleted Carpe Diem account, or "revoke all"). The cutoff
counts whole seconds, so an assertion signed in that very second is refused
too; the partner signs a fresh one. `403 DEVICE_REVOKED`: this `device_id` was
revoked and never receives a key again.

Request rate limits are per client IP: `/partner/keys` 20/min, `/partner/keys/poll`
30/min, `/partner/keys/revoke` 60/min, the consent pages 20/min.

### Deleted Carpe Diem account

A Carpe Diem account can be deleted by its owner at any time, outside the
partner app. Its device keys are revoked at once (the subject gets a cutoff, so
an assertion signed before the deletion answers `403 ASSERTION_REVOKED`), and
the next fresh assertion answers `410 ACCOUNT_CLOSED`. The app must then:

1. Tell the user that their Carpe Diem account was deleted, and that its
   credits are gone (they are not refundable). Do not retry on its own.
2. Offer a new account only as an explicit choice of the user (a button, not a
   default). Only after that choice, request a key again with a fresh assertion
   and body `{"reactivate": true}`. The operator then forgets the deletion and
   resolves the account as usual: a new, empty account (`linked: "created"`), or
   the consent flow if the user has meanwhile opened a Carpe Diem account with
   that email.

`reactivate` is ignored unless the subject's account was deleted, and only the
literal `true` counts. Never send it automatically.

In Sub Rosa: the app maps the refusal to `carpe_diem_account_closed`
(`src-tauri/src/carpe_diem/issued.rs`, `DeviceKeyIssue.tsx`), the site to
`AccountClosedError` (`website/src/lib/browser-device.ts`, the device card in
`website/src/pages/browser-device.tsx`). Both offer "Open a new, empty
account", the only path that sends `reactivate`, and both answer
`ASSERTION_REVOKED` once with a fresh assertion.

### Poll a link request

`POST {operator root}/partner/keys/poll`, header `DPoP` (bound value
`linkRequestId`, key must match the request's `jkt`), body `{"linkRequestId":"…"}`.

- `202 {"status":"pending","expiresAt":"…"}`
- A confirmed request can still be collected for 15 minutes after `expiresAt`.
- `201` issued (same body as above, `linked: "confirmed"`)
- `403 {"code":"LINK_DECLINED"}`, `410 {"code":"LINK_REQUEST_EXPIRED"}` (also for
  an unknown or already collected request), `401 PROOF_INVALID`,
  `400 BAD_REQUEST` (a `linkRequestId` that is not a UUID), `404 NOT_FOUND` when
  issuance is not open. Rate limit 30/min per client IP.
- The issuing refusals of the section above (`403 DEVICE_REVOKED`,
  `403 ASSERTION_REVOKED`, `429 ISSUANCE_LIMITED`, `503 PARTNER_SUSPENDED`) can
  also answer a poll. A refused limit leaves the request confirmed, so the app
  can poll again.

### Consent pages (Carpe Diem frontend → operator)

- `POST /partner/link/describe {"token"}` → `{"partner":"Sub Rosa","deviceName":"…","emailHint":"…","expiresAt":"…"}` or `410`.
- `POST /partner/link/confirm {"token","code"}` → `{"ok":true}`; wrong code → `400 CODE_MISMATCH` with `attemptsLeft` (5 attempts, then the request is declined).
- `POST /partner/link/decline {"token"}` → `{"ok":true}`.
- `POST /partner/link/revoke-all {"token"}` (from the notification mail) → `{"ok":true,"revoked":n}`.
  It also marks the link `consent_required`: the next issuance for that subject
  answers `202 confirmation_required` (code + mail) even though the link exists,
  because the partner account itself may be compromised. Confirming clears it.
  Revoking a single partner key from the Carpe Diem dashboard
  (`/auth/api-keys/:id/revoke`) marks the link the same way: the partner never
  gets a replacement silently for a key its owner chose to revoke.
- Tokens in these links are 64 lowercase hex characters; the pages
  (`frontend/app/link/page.tsx`, `frontend/app/link/revoke/page.tsx`) and the
  operator refuse any other shape. Malformed, unknown, used or expired tokens → `410 LINK_REQUEST_EXPIRED`.

### In Sub Rosa: issuing on the device

`src-tauri/src/carpe_diem/issued.rs` maps the answers of `/partner/keys` and
`/partner/keys/poll` to error codes the app words for the person:

- `410 ACCOUNT_CLOSED` → `carpe_diem_account_closed` (with `closedAt`), any
  other `410` → `carpe_diem_link_expired`;
- `451` → `carpe_diem_issue_region`;
- `401 PROOF_INVALID` → `carpe_diem_issue_clock`;
- `401 ASSERTION_INVALID` → `carpe_diem_issue_refused`;
- `403 DEVICE_REVOKED` → `carpe_diem_device_revoked`;
- `403 LINK_DECLINED` → `carpe_diem_link_declined`;
- `429 ISSUANCE_LIMITED` → `carpe_diem_issue_limited`, any other `429` →
  `carpe_diem_issue_busy`;
- `503 PARTNER_SUSPENDED` → `carpe_diem_issue_paused`, any other `5xx` →
  `carpe_diem_issue_down`;
- `404` → `carpe_diem_issue_unavailable`; anything else (including
  `409 CONSENT_UNAVAILABLE`) → `carpe_diem_issue_rejected`.

`409 ASSERTION_REPLAYED` and `403 ASSERTION_REVOKED` are answered with a fresh
assertion (the latter after 1.1 s), two tries in all, never looped on.

A confirmation already waiting (the same attempt, held in memory with its
ephemeral key) is shown again with its code instead of being replaced, so the
person never receives a second mail with a different code; only `reactivate`
starts a new attempt, and a restart of the app loses the waiting one. The app
polls only while the screen is visible (ADR-0018), and a network failure keeps
the attempt.

A minted key cannot be fetched again: it already counts against the link's
limits and retired this device's previous key. So the app stores it unless
`GET /v1/credits` clearly refuses it (`401` or `403`); a network failure, a
server error or an unreadable answer stores it anyway. When it cannot be stored
(that refusal, or a credential store that will not write), the app retires it
at once with a self revocation (section 4) so it does not hold one of the
link's five active places for nothing.

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
- Always `200 {"ok":true,"revoked":n}` for a fresh assertion, including for an
  unknown subject (the effect is idempotent). A **replayed** assertion (same
  `jti`) is refused with `409 ASSERTION_REPLAYED`: the outbox must sign a fresh
  assertion for every attempt. No DPoP (no `cnf`). `404 NOT_FOUND` only when no
  partner is configured at all (the route stays open without a mailer or a card
  rail, changelog 13b and 22).

The account service enqueues a row in its durable outbox
(`partner_revocations`) inside the same transaction as:

- `DELETE /api/v1/devices/{id}` → `reason: "device_revoked"`, on every
  explicit revocation, including of a device already marked revoked;
- `POST /api/v1/session/renounce` (the app signing itself out) →
  `reason: "signed_out"`;
- `DELETE /api/v1/me` → `device_id: null`, `reason: "account_deleted"`. The
  row lives in the deletion transaction, so `reapply_deletion` replays it when
  a restored backup still holds the account.

- `restore-sanitize` (`invalidate_restored_sessions`, which marks every device
  of a restored database revoked) → one `reason: "device_revoked"` row per
  device that was live before it, inserted in the same transaction before the
  update.

A browser `POST /auth/logout` has no device and enqueues nothing.

Why the restore path and the repeat both enqueue: a restore revokes every
device without anyone asking Carpe Diem. If it enqueued nothing, a device
stolen before the restore would keep a key that could never be revoked again
(revoking it later would find it already revoked), and every device signing
in again gets a new device id and so a new key, while the old keys stay
active until the link hits Carpe Diem's five-active-keys cap and every further
issuance answers `429 ISSUANCE_LIMITED`. A revocation Carpe Diem already
applied costs it nothing, so asking twice is always safe and asking never is
not.

The 60 s maintenance loop leases up to 50 due rows (for five minutes, so a slow
delivery is not picked up twice), delivers them in the order
they were written, marks a row done on any `2xx` (the body is not read) and
otherwise backs off `2^attempts` minutes, capped at six hours, forever. Carpe
Diem must therefore treat a revocation as idempotent: the same `(sub,
device_id, reason)` may arrive more than once, each time with a new `jti`.

What the account service keeps about a failure (10 October 2026): the row's
`last_error` is the HTTP status (`http 404`), `unreachable` or `signing`,
never a body. A `404` here means the operator has no partner configured:
`partnersEnabled()` is false (no valid `subrosa` entry in `PARTNERS_JSON`), and
the route answers before it reads the assertion. That is what every
revocation met from 4 to 10 October 2026, while `/partner/capabilities`
reported `keyIssuance: false` for the same reason. A row that failed twelve
times (the backoff waits 1, 2, 4 to 256 minutes, then six hours a time, so
about 21 hours of refusals) counts as stuck: the service logs one
`ERROR` naming the count, the oldest row and the last status, then at most
once a day while any row stays stuck, and `GET /readyz` reports
`partner_revocations: {pending, stuck}` without ever turning unready.

### Self revocation (app → operator)

`POST {operator root}/v1/keys/self/revoke` with `Authorization: Bearer cdm_…` →
`200 {"status":"revoked","id":"<keyId>"}`. Used on sign-out so the key dies
immediately even before the outbox drains. Without a `cdm_` bearer →
`400 KEY_REQUIRED`; an unknown or already revoked key → `401 AUTH_REQUIRED`.

In Sub Rosa (`src-tauri/src/carpe_diem/issued.rs`, `src-tauri/src/account/mod.rs`):

- Signing out, revoking this device and deleting the account each self-revoke
  the issued key (best effort) and forget it locally whatever the answer. A
  pasted or restored key is left alone.
- The explicit "revoke" button clears the key locally only once Carpe Diem
  confirmed: a `2xx`, or a `401`/`403` (the key already does not work). Any
  other answer keeps the key and reports `carpe_diem_revoke_unconfirmed`.
- Carpe Diem tells partners nothing when a key is revoked from its dashboard or
  its account is closed, so the `carpe_diem_issued_key_health` command reads
  `GET /v1/credits` with the key when the settings are shown: `401`/`403` →
  refused, `2xx` → accepted, anything else → unknown.
- A sign-out while offline keeps a "farewell" (the device id and its device
  secret, at most 8 waiting) in the credential store and replays
  `POST /api/v1/session/renounce` at the next launch. Until the account service
  hears it, the device stays listed as live and no `signed_out` revocation is
  enqueued.

## 5. Card top-ups

### Capabilities and tiers (public)

`GET {operator root}/partner/capabilities` →
`{"keyIssuance":true,"fiat":true,"blockedCountries":["BY","CU","IR","KP","MM","RU","SD","SS","SY","US"]}`
(`keyIssuance` false when no partner is configured or, in production, without a
real mailer or an armed fiat rail, changelog 13b and 22; `fiat` false unless the fiat
rail is armed: `FIAT_GRANT_SECRET` set and, in production, `STRIPE_RESTRICTED_KEY`
and a Stripe price on every tier, read back from Stripe and matching). `blockedCountries` is the operator's own
geo-block list (sanctions + restricted), sorted: the pay page answers 451 there,
so apps never show a pay link in those countries.

`GET {operator root}/v1/billing/tiers` →

```json
{"currency":"usd","tiers":[{"id":"credits_500","usdCents":599,"credits":500},{"id":"credits_1000","usdCents":1149,"credits":1000},{"id":"credits_2000","usdCents":2249,"credits":2000},{"id":"credits_5000","usdCents":5449,"credits":5000}]}
```

Tiers come from `FIAT_TIERS_JSON` on the operator: `[{"id","usdCents","micros","stripePriceId"}]`.
`credits = micros / 10_000`. `stripePriceId` is never exposed publicly. Prices
are in USD cents **before tax** (Stripe Tax adds VAT where due); they are not
at par: 100 credits cost more than 1 USD by card (card, FX, tax and USDC
purchase fees), while USDC deposits stay at 1 USDC = 100 credits.

**Read tier ids from this endpoint; never hard-code them.** Ids, prices and the
number of tiers are operator configuration and change without notice (the
`usd_5`…`usd_50` ids of earlier drafts are gone). Show `credits` and `usdCents`
as returned, and send back the `id` the person picked.

### Checkout ticket (app → operator)

`POST {operator root}/v1/billing/checkout-ticket`, `Authorization: Bearer cdm_…`
(or a JWT session), body `{"tier":"<id from GET /v1/billing/tiers>"|null,"returnTo":"subrosa"|"dashboard"|null}`.

- `201 {"ticketId":"<uuid>","url":"{APP_BASE_URL}/pay?t=<ticketId>","expiresAt":"…"}`
- `401 AUTH_REQUIRED`, `404 FIAT_DISABLED`, `400 UNKNOWN_TIER`, `400 BAD_REQUEST`
  (an unknown `returnTo`), `403 PURCHASE_BLOCKED` (the wallet ended
  with a shortfall after a refund or dispute), `403 PURCHASE_LIMIT` with
  `remainingUsdCents` (the chosen tier, or the smallest one when none is
  chosen, is over the new-account ceiling below), `429 ENDPOINT_RATE_LIMITED`
  (10 per hour per wallet).
- Ticket: 15 minutes, reusable until expiry, stores wallet, account email (if an
  email account), tier, returnTo.

### Ticket redemption (pay service → operator)

`POST {operator root}/billing/tickets/redeem`, header
`x-carpe-grant-signature: hex(HMAC-SHA256(FIAT_GRANT_SECRET, "redeem:<ticketId>"))`,
body `{"ticketId"}` →
`{"ticketId","wallet","email":null|"…","emailHint":"…","tier":null|"credits_1000","returnTo":null|"subrosa","expiresAt","tiers":[{"id","usdCents","credits","micros":"10000000","stripePriceId"}],"limits":{"remainingUsdCents":…}}`
(`micros` is a decimal string) or `410 TICKET_EXPIRED`, `403 PURCHASE_BLOCKED`, `401`,
`400 BAD_REQUEST` (a `ticketId` that is not a UUID),
`404 FIAT_DISABLED` (sales disarmed since the ticket was issued; checked after the signature).
`remainingUsdCents` is the room left under the ceilings **in credits**
(`micros / 10_000`), despite its name: ceilings bound the credit value, not the
price paid. Compare it with a tier's `credits`, never with its `usdCents`
(a 5 000-credit pack costs 5 449 cents and fits a 5 000 room). The same holds
for the `remainingUsdCents` of a checkout ticket's `403 PURCHASE_LIMIT`.

### Grant (pay service → operator, after Stripe says paid)

`POST {operator root}/credits/grant` (existing route, extended):

```json
{"grantId":"cs:<checkout session id>","wallet":"0x…","amountMicros":"10000000","country":"CH","cardCountry":"CH"}
```

- Signature: `grant:<grantId>:<wallet>:<micros>:<country or empty>`, or, when
  `cardCountry` is sent, `grant:<grantId>:<wallet>:<micros>:<country or empty>:<cardCountry>`.
  The 4-field form stays valid, but a `cardCountry` it does not cover is ignored.
- `amountMicros` is a decimal integer string (the old float `usdcAmount` stays
  accepted for compatibility; never both).
- When `grantId` starts with `cs:`, the operator re-reads the session from Stripe
  (`GET https://api.stripe.com/v1/checkout/sessions/<id>?expand[]=line_items`
  with `STRIPE_RESTRICTED_KEY`) and requires `mode=payment`,
  `payment_status=paid`, `currency=usd`, `metadata.wallet == wallet`, exactly
  one line item whose `price.id` is a configured tier, and
  `amountMicros == tier.micros`. Otherwise `422 {"code":"STRIPE_MISMATCH"}`.
  It also requires `consent.terms_of_service == "accepted"` (Checkout
  `consent_collection.terms_of_service: required`, the EU withdrawal waiver);
  otherwise `422 {"code":"TOS_NOT_ACCEPTED"}`: final, alerted, never refunded
  automatically (handled by hand).
  A session Stripe does not know (`404`) is **retryable**:
  `503 {"code":"STRIPE_NOT_FOUND"}` plus a critical alert. With a well-formed id,
  the likely cause is the operator's own key (another Stripe account, or the
  wrong test/live mode); treating it as final would refund every sale.
  In production a `cs:` grant without `STRIPE_RESTRICTED_KEY` is refused
  (`503 STRIPE_UNVERIFIABLE`), a session whose `livemode` is not `true` (a
  `cs_test_` session) is a mismatch, and **any grant whose id does not start with `cs:` is refused**
  (`403 GRANT_REQUIRES_STRIPE`): the HMAC secret lives outside the TEE, so it
  alone must never be able to mint credits.
- The country stored is Stripe's `customer_details.address.country`; a signed
  `country` that contradicts it is a mismatch. The card country is read from
  Stripe (`payment_intent.latest_charge.payment_method_details.card.country`);
  the body's `cardCountry` is only used when no Stripe verification ran (dev).
- **Blocked regions.** A billing country or card country in the operator's
  blocked list (OFAC sanctions + US, the same list as the HTTP geoblock and
  `/partner/capabilities.blockedCountries`) is refused: `403 REGION_BLOCKED`
  (final). The IP geoblock is one VPN away; Stripe's two countries are not.
- A replayed `grantId` answers `200 {"applied":false}` without calling Stripe
  or re-checking ceilings.
- Global ceiling: fiat grants over the last 24 h may not exceed
  `FIAT_DAILY_CEILING_USDC` (default 5000) → `503 FIAT_CEILING` + alert.
- New-account ceiling: a wallet whose first fiat grant is less than 7 days old may
  not exceed 50 USD per 24 h and 100 USD per 7 days → `403 PURCHASE_LIMIT`.
  Checkout tickets check this too so the person is told before paying.
- **Refusals carry `permanent` and `refund`.** Every refusal body is
  `{"error","code","permanent":true|false,"refund":{"id":"re_…","status":"succeeded"}|null}`.
  On a permanent refusal of a purchase the session itself makes uncreditable
  (`PURCHASE_LIMIT`, `PURCHASE_BLOCKED`, `REGION_BLOCKED`, a session-intrinsic
  `STRIPE_MISMATCH`), **the operator refunds the session itself** with its
  sealed key (idempotency key `refund-refused:<session>`) and returns the
  refund. Never refunded automatically: `TOS_NOT_ACCEPTED`, a `STRIPE_MISMATCH`
  caused by the request (wallet, amount, signed country) or by the payment's
  state (not paid, refunded, disputed), `GRANT_REFUNDED`, `ID_CONFLICT`,
  `GRANT_REQUIRES_STRIPE` (`refund: null`, alerted).
- **What the pay service does with a refusal.** `permanent: true` ⇒ answer the
  webhook 2xx (log `[ALERT]` with `code` and `refund`); it **never refunds**
  itself and its key needs no `Refunds: write`. Anything else ⇒ non-2xx so
  Stripe retries: `503` codes (`FIAT_CEILING`, `STRIPE_UNAVAILABLE`,
  `STRIPE_UNVERIFIABLE`, `STRIPE_NOT_FOUND`, and `REFUND_FAILED` with
  `refusedCode` when the operator could not issue the refund), `400`, `401`.

### Revoke (refund or dispute)

`POST {operator root}/credits/revoke`:

```json
{"revokeId":"re:<refund id>|dp:<dispute id>","grantRef":"cs:<session id>","wallet":"0x…","amountMicros":"5000000"}
```

- Signature: `revoke:<revokeId>:<wallet>:<micros>:<grantRef>` when `grantRef` is
  present (the old 3-field form stays for callers without `grantRef`).
- The operator caps the cumulative revoked micros for one `grantRef` at that
  grant's micros (`capped: true, revokedUsdc: 0` once exhausted). A shortfall
  (credits already consumed) marks the wallet `PURCHASE_BLOCKED` until an admin
  calls `POST /admin/fiat/unblock/:wallet`. A replayed `revokeId` returns the
  original outcome with `applied: false`.
- A `grantRef` that was **never credited** (the operator refunded a payment
  whose grant was permanently refused) answers
  `200 {"applied":false,"uncredited":true,"revokedUsdc":0,"shortfallUsdc":0}`
  and never blocks purchases. It leaves a tombstone: a later grant for that
  same session is refused with `409 GRANT_REFUNDED` (final, the money is
  already back with the person). A `grantRef` credited to **another** wallet →
  `404 GRANT_NOT_FOUND`.
- Check-and-apply is one synchronous SQLite transaction for grants (refund
  tombstone, ceilings, apply) and for revokes (cumulative cap, take back,
  block): two concurrent requests cannot both pass a limit.

### Purchases (app → operator)

`GET {operator root}/v1/billing/purchases` (cdm_ key or JWT) →
`{"purchases":[{"id":"cs:…","kind":"purchase|refund","usd":10,"credits":1000,"at":"<ISO>"}]}`
newest first, at most 50. An account recreated at the same address does not
see the purchases from before its deletion.

### Keys and their spend (app → operator)

`GET {operator root}/buyer/api-keys/usage?days=1..90` (cdm_ key or JWT; not a
browser key, not CORS-enabled for the site origins) →
`{"keys":[{"id","name","prefix","createdAt","revokedAt","expiresAt","partner","partnerDevice","requests","tokens","cost","lastUsedAt"}],"windowDays":30}`.
Every key of the wallet, spend over the window in USD (`cost`). `partner` and
`partnerDevice` name the partner and the partner's device id for a key issued
to it (`null` for a key made on the dashboard), so the app can show which of
the account's devices holds a key and what it spent. Sub Rosa matches on
`partnerDevice` only, never on the key name.

### Stripe session (pay service)

- `mode: payment`, one line item `price: tier.stripePriceId`,
  `metadata` and `payment_intent_data.metadata`: `wallet`, `ticketId`, `tier`, `micros`.
- `client_reference_id: wallet`. No `customer_email`: the ticket travels in a URL,
  and prefilling would show the full address to whoever holds the link.
- `consent_collection[terms_of_service]: required`, with
  `custom_text[terms_of_service_acceptance][message]` carrying the withdrawal
  waiver (the terms URL is set in the Stripe dashboard). Required: the operator
  refuses a session without `consent.terms_of_service = accepted`.
- `automatic_tax[enabled]` from `STRIPE_TAX_ENABLED`, `billing_address_collection: required`,
  `tax_id_collection[enabled]: true`, `allow_promotion_codes: false`,
  `payment_method_options[card][request_three_d_secure]: automatic`, no Adaptive Pricing.
- `expires_at`: the ticket's expiry + 31 min (Unix seconds, within Stripe's 30 min to 24 h).
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

## 7. Browser devices (2026-10-08)

A browser can become a device of its Sub Rosa account (Sub Rosa ADR 0096) and
obtain its own key through sections 1 to 3, with three differences: who may
ask, what the assertion says, and what Carpe Diem holds the key to.

### Account service

- The browser becomes a device through `POST /api/v1/browser-devices`: a browser
  session authenticated within five minutes, plus an out-of-band admission (a
  pairing request a live app of the account approved, or a value derived from
  the recovery key). Its device key is a WebCrypto P-256 key generated
  non-extractable; the service keeps the public half.
- `POST /api/v1/carpe-diem/assertion` accepts, besides an app's bearer
  session, a browser session with a `subrosa-device-proof` header: an ES256 JWS,
  `typ` `subrosa-device+jwt`, `kid` = the device id, claims `htm`, `htu`
  (exact), `iat` (±60 s), `jti` (single use) and `ath` =
  base64url(SHA-256(the exact request body bytes)), here `{"jkt":"…"}` as
  sent (10 October 2026; previously the hash of `jkt` alone). It need not be
  recent, so the key can be renewed while the device is live. A browser
  session without a proof still answers `403 device_required`; a proof that
  does not verify answers `401 device_proof_invalid`. The bound asked for
  comes from the service's `[carpe_diem]` configuration (defaults 200 credits
  a day and 7 days, never above 5000 credits and 7 days).
- Revoking the browser device, or the browser signing itself out
  (`POST /api/v1/browser-devices/renounce`), enqueues the same section 4
  revocation as an app (`device_revoked` / `signed_out`).

### Assertion claims

A browser device's issuance assertion carries two more claims. An app's
assertion carries neither, exactly as before.

```json
{
  "kind": "browser",
  "bound": {"daily_cap_credits": 200, "valid_seconds": 604800}
}
```

The operator checks, in addition to section 3:

- `kind` absent (or `null`) means an app. Any value other than `"browser"` →
  `401 ASSERTION_INVALID`.
- With `kind: "browser"`, `bound` is required: `daily_cap_credits` an integer
  ≥ 1, `valid_seconds` an integer ≥ 3600. Missing or malformed →
  `401 ASSERTION_INVALID`. Values above the operator's ceilings
  (5000 credits, 7 days) are lowered to them, never refused: the partner may
  ask for less, never for more.
- A link request (the `202` consent path) stores the bound, and the key the
  poll delivers after confirmation carries it.

### Issuance

- The key row stores `bound_kind = "browser"`, `bound_daily_cap_micros =
  daily_cap_credits × 10 000` and `bound_expires_at = now + valid_seconds`.
- Issuing again for the same `(partner, sub, device_id)` still revokes the
  previous key (section 3). That is how a browser renews. A renewal that
  replaced a key of the same browser not yet revoked, expired or not, sends
  no new notification mail (the browser was announced when it got its first
  key). The browser's first key, a key after a revocation of that browser,
  and every app key still send one.
- An expired browser key no longer counts among the link's 5 active partner
  keys (section 3): a browser that lost its storage and comes back with a new
  `device_id` is not locked out by its own dead keys. Active means neither
  revoked nor expired.
- The `201` body gains two fields for a browser key only:

```json
{"expiresAt": "<ISO>", "bound": {"kind": "browser", "dailyCapCredits": 200}}
```

### What a browser key may do

Checked inside the operator on every request carrying the key (before body
validation), in this order:

1. Expired (`now ≥ bound_expires_at`) → `401 {"code":"KEY_EXPIRED"}`, except
   `POST /v1/keys/self/revoke`, which always works.
2. `/router/*` or any `x402` path → `403 {"code":"BROWSER_KEY_RAIL_REFUSED"}`.
3. Anything other than `/v1/chat/completions`, `/v1/embeddings`,
   `/v1/audio/*`, `/v1/image/*`, `/v1/augment/*`, `/v1/models`,
   `/v1/credits` and `/v1/keys/self/revoke` → `403 {"code":"BROWSER_KEY_ROUTE"}`.
4. A non-`GET` request when the **account's** browser spend over the last 24
   hours, plus the account's reservations still pending, is at or above the
   cap of the key making the request → `429 {"code":"KEY_DAILY_CAP"}` with
   `Retry-After`. When settled spend alone reaches the cap, it is the number
   of seconds until enough of it, oldest first, has left the 24-hour window
   to bring it back under the cap (at least 1). When pending reservations
   reach it, it is 10: they settle or are released within seconds or minutes.

The cap is per partner account, not per key: the spend is the sum, in the
usage ledger (`usage_events.cost_usdc`), of every browser key of the same
`(partner, sub)`, revoked and expired keys included. A renewal mints a new key
id, and a browser that loses its storage gets a new `device_id`; neither starts
the 24 hours over. The figure compared with that sum is the cap of the key
making the request, so a browser whose bound is lower stops earlier, and an
account's browsers together never exceed the highest cap among them (at most
5000 credits) by more than one request. App keys' spend is not counted.

Reservations close the gap between serving and billing: the usage ledger is
written when a request settles, and a queued job (`/v1/image/*/queue`,
`/v1/audio/music/queue`) settles minutes later. Every paid route places a hold
(an upper bound of its cost) on the account's wallet before serving, keeps it
until the request settles or fails, and a queued job keeps it until it is
billed or expires. Those holds count as already spent. The check is repeated
when the hold is placed, and the room is reserved there with no await between
check and reservation, so parallel requests always see each other. The
consequences:

- the last request admitted can overshoot the cap by at most its own cost
  (its hold), and nothing else is admitted until it settles;
- the holds are the wallet's, whatever key placed them: an app request of the
  same account in flight also takes room from the browsers (stricter, never
  looser);
- holds live in memory, like the rest of the hold system: an operator restart
  drops them along with the requests they covered.

The bound holds whichever header carries the key (`Authorization` or
`x-api-key`), and an expired browser key authenticates nowhere, except
`POST /v1/keys/self/revoke`.

The rail stays pinned to `credits`, as for every partner key.

### CORS

The Sub Rosa site origins `https://subrosa.furetier.com`,
`https://furetier.com` and `https://office.subrosa.furetier.com` (the Office
add-ins' own origin) are allowed on `/partner/keys`, `/partner/keys/poll`,
`/partner/capabilities`, the routes listed in rule 3 above and the public
price list `GET /pricing`, and on nothing else. The site reads `/pricing`
without a key (a research plan's ceiling, a voice estimate); it is not a
browser-key path, so a browser key still cannot call it. Every other origin rule is unchanged. Preflights (`OPTIONS`) are
answered on those paths with the origin reflected, `Vary: Origin` and the
requested headers; streamed answers (SSE, written outside Fastify's reply
hooks) carry the same origin header; refusals (`429 KEY_DAILY_CAP` and the
others) carry it too, with `Retry-After` exposed. No credentials are ever
allowed (`Access-Control-Allow-Credentials` is never sent): the key travels in
`Authorization`, never in a cookie. The origins are fixed in the operator's
code (`SUBROSA_SITE_ORIGINS`, `services/browserKeys.ts`), not configuration:
adding one is a code change and a deployment. The site's own CSP allows
`connect-src` to `https://carpe-diem.xyz` and nothing else beyond itself.

## Changes from the v1 draft

Settled while implementing the operator; the other sides follow these.

1. `/partner/keys/revoke`: a replayed `jti` is `409`, so the account-service
   outbox signs a fresh assertion per attempt (the effect stays idempotent).
2. `/partner/capabilities` gains `blockedCountries`.
3. `/billing/tickets/redeem` tiers carry `micros` (decimal string); redeem can
   answer `403 PURCHASE_BLOCKED`.
4. Production refuses every non-`cs:` grant (`403 GRANT_REQUIRES_STRIPE`).
5. ~~`PURCHASE_LIMIT` / `STRIPE_MISMATCH` on a grant ⇒ the pay service refunds.~~
   Superseded (2026-10-05): the operator refunds; see "Refusals carry `permanent` and `refund`".
6. Revoke-all sets `consent_required` on the link; the next issuance goes
   through the code-and-mail consent even though the link exists.
7. Key names are prefixed with the partner's configured `name`.
8. Poll rate limit is per client IP (30/min).
10. At most 3 consent mails per address per hour (`429 ISSUANCE_LIMITED`).
11. A refund of a never-credited purchase is `200` with `uncredited: true`, no
    block, and tombstones the session (`409 GRANT_REFUNDED` on a late grant).
9. Test vector for the RFC 7638 thumbprint (P-256, RFC 7517 appendix A.1 key
   `x=f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU`,
   `y=x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0`):
   `oKIywvGUpTVTyxMQ3bwIIeQUudfr_CkLMjCE19ECD-U` (computed with `jose`).
13b. **Issuance needs a real mailer in production** (SMTP with `SMTP_HOST`, `SMTP_USER` and `SMTP_PASS`, or Resend with `RESEND_API_KEY`). Without one, `/partner/capabilities` reports `keyIssuance: false` and `/partner/keys` and `/partner/keys/poll` answer 404; `/partner/keys/revoke` stays open. The key notice and the consent mail are security controls, and in production a mail is never logged instead of sent (it carries sign-in or consent links).

### Security review (2026-09-30)

12. **Device tombstones.** `device_revoked` / `signed_out` with a `device_id`
    tombstones `(partner, subject, device_id)`: that device never receives a key
    again (`403 DEVICE_REVOKED`), even with an assertion obtained before the
    revocation. Partner device ids are never reused.
13. **Subject cutoff.** A revocation of all keys (`device_id: null`,
    `account_deleted`, or the owner's "revoke all" mail link) records a cutoff:
    any issue assertion with `iat ≤ cutoff` is refused (`403 ASSERTION_REVOKED`).
    The cutoff has one-second precision, so an assertion signed in the very
    second of the revocation is refused too; the partner signs a fresh one.
    Pending or confirmed link requests of the revoked device (or subject) are
    declined in the same transaction and never deliver a key.
14. `account_deleted` revokes **all** keys of the link, whatever `device_id` says.
15. `device_name` longer than 64 code points is truncated (by code point, not
    UTF-16 unit), never refused.
16. The partner path refuses any `email` that is not printable ASCII
    (`401 ASSERTION_INVALID`), so no Unicode normalization (NFKC, case folding)
    can merge two mailboxes (e.g. U+212A KELVIN SIGN). Elsewhere emails are
    normalized NFKC, then lowercased.
17. A link with `consent_required` whose wallet has no Carpe Diem email account
    fails closed (`409 CONSENT_UNAVAILABLE`); the asserted email is never mailed.
18. Stripe verification also requires no discount (`total_details.amount_discount`
    and the line item's `amount_discount` both `0`), session `amount_subtotal`
    equal to the tier, `amount_total ≥ amount_subtotal`, a charge with
    `amount_refunded = 0` and `disputed ≠ true`.
19. **Reconciliation inside the TEE.** Every `FIAT_RECONCILE_INTERVAL_MS`
    (15 min; off without `STRIPE_RESTRICTED_KEY`) the operator re-reads the
    `cs:` purchases of the last 35 days that are not fully taken back, one page
    at a time (cursor persisted, restart-safe), and applies missing revokes itself
    with the pay service's ids (`re:<refund>` for succeeded refunds, prorated on
    the charge amount; `dp:<dispute>` for the rest of the purchase). Whichever
    arrives first wins; the other is a replay. Admin trigger:
    `POST /admin/fiat/reconcile {pageSize}`.
20. **Id discipline.** A `revokeId` can never start with `cs:` and a `grantId`
    never with `re:`/`dp:` (400). An id already used by the other kind of
    operation is `409 ID_CONFLICT`, never a replay. In production a revoke needs
    a `re:`/`dp:` id and a `grantRef` that starts with `cs:`; a `grantRef` that
    exists must be a grant of the same wallet (else `404`), one that does not
    exist is the "never credited" case (item 11).
21. **An uncredited revoke needs Stripe's evidence.** A revoke whose `grantRef` names a purchase that was never credited tombstones that session (a later grant is `409 GRANT_REFUNDED`). So the operator first reads, with its restricted key, the refund (`GET /v1/refunds/<id>`, `status: succeeded`) or dispute (`GET /v1/disputes/<id>`) and requires it to name the session's own PaymentIntent; otherwise `422 STRIPE_MISMATCH` (`503` if Stripe is unreachable, in production without a key, or `503 STRIPE_NOT_FOUND` if Stripe does not know the object). Without this, whoever holds the HMAC secret could pre-empt any legitimate payment's credit.
22. **Issuance waits for the card rail in production.** `keyIssuance` is true only when a partner is configured, a real mailer is set **and** the fiat rail is armed (`fiatArmed()`). An account born at a partner has no wallet, so before card payments open it could never get credits: issuing earlier would hand out keys stuck at zero. Revocation stays open regardless.
23. **Catch-up of paid sessions never credited (TEE).** Each reconciliation
    pass also lists the Checkout Sessions `status=complete` created between 7 days
    and 15 minutes ago, and grants those that are paid, USD, `mode=payment`
    (`livemode` in production) with no `cs:` grant and no tombstone, through the
    same path as `/credits/grant` (re-verified at Stripe, same ceilings,
    idempotency and refunds). Wallet and micros come from the session metadata
    (`wallet`, `micros` or `tier`), so the pay service must keep setting them.
    Admin trigger: `POST /admin/fiat/reconcile {"catchUp":true}`.

### Account deletion (2026-10-09)

24. **A deleted Carpe Diem account is not recreated silently.** Deleting a
    Carpe Diem account erases its email and partner links but keeps
    `(partner, sub, closed_at)` for 10 years. `/partner/keys` then answers
    `410 ACCOUNT_CLOSED` until the app sends `{"reactivate": true}` after the
    user's explicit choice (section 3, "Deleted Carpe Diem account").

### Credits only, durable revocation (2026-10-14)

25. **A partner key pays in credits only**, also on a real wallet linked to the
    email account: no prepaid fallback, no prepaid registration, no rail change
    towards prepaid (`403 WALLET_SESSION_REQUIRED`). The same holds for keys
    created by an email session (`emailKey:<id>`).
26. **A key revoked from the dashboard stays revoked.** Revoking a partner key
    there sets `consent_required` on its link, so the next issuance asks for the
    code by mail.
27. Issuing a partner key counts as activity of the email account.
28. Request rate limits per client IP, and `403 DEVICE_REVOKED`,
    `403 ASSERTION_REVOKED`, `409 CONSENT_UNAVAILABLE` and the geoblock's `451`
    are listed with the other errors of section 3.

### Keys per device (2026-10-14)

29. `/buyer/api-keys/usage` carries `partner` and `partnerDevice` for each key
    (section 5, "Keys and their spend").

## Operator configuration

`PARTNERS_JSON` (sealed):

```json
[{"id":"subrosa","name":"Sub Rosa","issuer":"https://subrosa.furetier.com",
  "keys":[{"kid":"sr-2026-10","jwk":{"kty":"EC","crv":"P-256","x":"…","y":"…"}}],
  "maxIssuancePerHour":60}]
```

- Keys are pinned public JWKs; one carrying `d` is ignored. Rotation = add the
  new `kid`, deploy, switch the partner, then remove the old one.
- Invalid JSON, a bad issuer (https only; http only for loopback outside
  production) or no valid key ⇒ that partner is ignored; none left ⇒ `/partner/*` is 404.
- A tripped breaker is cleared by an admin: `POST /admin/partners/:id/resume`.
