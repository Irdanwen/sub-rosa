# Sub Rosa accounts and synchronization contract

Protocol v1, implemented 14 September 2026. The service is the `subrosa-cloud/` Rust workspace; it is separate from the authenticated loopback sidecar and does not proxy Carpe Diem inference. Endpoint schemas are in [`subrosa-cloud/openapi.json`](../subrosa-cloud/openapi.json), deployment and restore procedures in its [README](../subrosa-cloud/README.md).

JSON field names are snake_case. Successful JSON responses are `{ "data": T }`; failures are `{ "error": { "code": string, "message": string } }`. Redirects and encrypted blob downloads are the explicit non-JSON exceptions. Do not log secrets, cookies, Authorization headers, request bodies or OIDC query strings. Account ownership is always derived from a live session, never from a caller-supplied account ID.

## Identity and browser sessions

| Method and route | Contract |
| --- | --- |
| `GET /auth/login?intent=signin\|signup&return_to=/account` | Starts external OIDC. Allowed return paths: `/account`, `/account/`, `/account/devices`, `/account/library`, `/account/provider`, `/account/security`, `/account/usage`, and `/account/devices/verify?code=XXXXXXXX` with a valid device code. No external return URLs. `signin` and `signup` share the configured identity provider; account creation/passkey UX belongs to it. |
| `GET /auth/callback?state=...&code=...` | Consumes a ten-minute login attempt bound to its browser cookie; verifies code, S256 PKCE, signed ID token, exact issuer/audience, nonce, verified email and fresh `auth_time`. Maps `(issuer, subject)` to an internal UUID, never merges by email. Returns a 303 redirect with browser cookies. |
| `POST /auth/logout` | Invalidates the current session. Native logout also revokes its refresh family. Clears browser cookies when present. |
| `GET /api/v1/me` | `{ id, email, created_at }`. Dates are RFC3339. |
| `DELETE /api/v1/me` | Requires authentication within five minutes. Persists independent signed deletion intent before deleting account rows, authorizations, sessions and encrypted-data references. Blob removal is a durable retry queue. Returns `{ deleted: true }` only after database erasure commits. |
| `GET /api/v1/devices` | Array of `{ id, name, created_at, last_seen_at, revoked_at }`. This list contains native device authorizations. |
| `POST /api/v1/devices/{id}/name` | Renames a device you own. A browser session and CSRF, but no step-up: a label change alters nothing the device may do, and a name you cannot correct is how the list became unreadable. `{ name }`, at most 80 characters, no control characters. |
| `DELETE /api/v1/devices/{id}` | Requires authentication within five minutes. Revokes the device's sessions/refresh families and pairing requests. Returns `{ revoked: true }`. Past downloaded data and provider credentials cannot be remotely erased. |

The server uses confidential-client OIDC, exact registered callback, `client_secret_basic`, `openid email`, PKCE S256 and `max_age=0`. ID tokens must use RS256 or ES256 with a matching trusted discovery JWKS key. The OIDC client secret exists only at the service. Passkeys are supplied by the production identity provider and do not implicitly decrypt the vault.

Browser sessions last twelve hours. Production session cookie: `__Host-subrosa_session`, `Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax`, no Domain attribute. The readable host-only `subrosa_csrf` cookie is bound to that session token. Every authenticated browser mutation must include the exact configured `Origin` and an `x-csrf-token` header equal to both its cookie and the server's derived value. A token for native bearer authentication cannot authenticate as a browser cookie or vice versa. No durable browser bearer token belongs in localStorage.

Authenticated routes accept an optional `x-subrosa-account-id: UUID` context assertion. After deriving identity from the real cookie/bearer session, the service compares that account with the assertion and rejects a mismatch with **409 `account_mismatch`**, before returning or mutating account data. The header never grants access or selects a tenant. The website sends the account associated with its unlocked vault on every authenticated request: another tab changing the shared session cookie must not cause this tab to encrypt under account A's key and upload into account B. A mismatch locks the client vault and requires an explicit account refresh/unlock. Native clients may omit the header for compatibility; when present it is enforced for bearer sessions too. Malformed or duplicate account assertions fail closed.

HTTP is permitted only with explicit development configuration and loopback origins. Development cookie names omit the `__Host-` prefix. The website proxies `/auth` and `/api` on its own origin; credentialed wildcard CORS is not supported.

## Native authorization and rotating refresh tokens

| Method and route | Request | Response data |
| --- | --- | --- |
| `POST /api/v1/device-login` | `{ challenge, device_name }` | `{ request_id, verification_uri, user_code, expires_at, interval_seconds }` |
| `POST /api/v1/device-login/approve` | Browser session + CSRF, `{ user_code }` | `{ approved: true }` |
| `POST /api/v1/device-login/exchange` | `{ request_id, verifier }` | Token bundle below, or `authorization_pending` / `slow_down` |
| `POST /api/v1/session/refresh` | `{ refresh_token }`; does not use cookies | Rotated token bundle below |

A token bundle is `{ access_token, refresh_token, expires_at, refresh_expires_at, device_id, account }`, where `account` has the `/me` shape. Tokens are independent, opaque, random 256-bit values; PostgreSQL stores only SHA-256 hashes. Access lifetime is fifteen minutes. Refresh families expire absolutely after thirty days; rotation does not extend that deadline or make authentication recent again.

The native client generates a random verifier, 43 to 128 RFC7636 characters, and submits `challenge = base64url_without_padding(SHA256(verifier))`. Requests last ten minutes and have a forty-bit human code. Poll interval is five seconds. Approval is an explicit POST from a recently authenticated browser, never an automatic side effect of opening the verification URL. Device exchange checks the verifier in constant time and consumes the request once.

Refresh consumes its token once and stores the next hash in the same transaction. The server retains consumed hashes until the family expires. Reusing any consumed refresh token, including concurrent duplicates, revokes the entire family and every issued access generation. Clients serialize refresh, renew within two minutes of access expiry and atomically replace the complete bundle in the OS keyring. A lost refresh response requires browser reauthentication; do not blindly retry the old token. Invalid, expired or revoked sessions return 401. Revocation is checked in PostgreSQL on every request.

## Encrypted journal

`POST /api/v1/sync` accepts:

```json
{
  "operations": [{
    "operation_id": "UUID",
    "object_id": "UUID",
    "parent_revision": null,
    "resolved_revisions": [],
    "kind": "note",
    "ciphertext": "opaque encrypted envelope string",
    "deleted": false
  }]
}
```

`resolved_revisions` is optional and defaults to `[]`. A push has 1 to 100 operations, at most four MiB of ciphertext in total and at most one MiB of ciphertext per operation. Unknown kinds, invalid UUIDs or more than 64 resolution acknowledgements are rejected. Kinds are `note`, `folder`, `transcript`, `memory`, `conversation`, `settings`, `usage`, `artifact`, `tombstone`, `errand`; `kind` is a routing class, never a title. `errand` is the one kind whose object is an instruction rather than a record: one device asking another of the same account to fetch a link ([ADR 0054](adr/0054-an-errand-runs-on-the-device-that-has-the-means.md)). It is opaque here like every other kind, the service never runs it, and the device it names ignores it unless that machine's owner switched errands on.

The result is `{ results: [{ operation_id, revision, sequence, conflict }] }`. The server assigns a revision UUID and per-account monotonic sequence. The entire batch is atomic. An identical retry of `(account, operation_id)` returns its original result; changing its authenticated body/ciphertext under that ID returns 409. Freeze the encrypted payload, nonce, parent and operation ID durably before first transmission.

Parents and explicit `resolved_revisions` must belong to this account and object. An operation retires only its parent and explicitly acknowledged revisions. A stale edit creates a sibling head; it never overwrites another head. `conflict` is true if any current head was not acknowledged. A user-approved resolution acknowledges all heads they actually reviewed; an unseen concurrent head survives. An omitted/empty resolution array preserves the original operation-hash serialization for retries from earlier clients.

`GET /api/v1/sync?after=0&limit=100&kind=settings` returns:

```json
{
  "changes": [{
    "sequence": 1,
    "operation_id": "UUID",
    "object_id": "UUID",
    "revision": "UUID",
    "parent_revision": null,
    "resolved_revisions": [],
    "kind": "settings",
    "ciphertext": "opaque encrypted envelope string",
    "deleted": false,
    "device_id": null
  }],
  "cursor": 1,
  "has_more": false
}
```

`kind` is optional and allowlisted. `limit` ranges from 1 to 500. Each page is also capped below eight MiB of actual serialized JSON, including escaping. The database streams rows rather than buffering a matching corpus. Count/byte-limited pages advance only through delivered changes. A completed filtered scan advances to the account watermark in the same repeatable-read snapshot; concurrent commits are observed next time. Maintain an independent cursor **per filter**. Do not reuse a settings-only cursor for notes. A cursor beyond the current account watermark is invalid.

Clients authenticate decrypted metadata before committing an inbound revision. Commit inbox rows and cursor together; a transient apply failure stays durable for replay. Outbound local edits and their outbox row commit together. Tombstones and revision history remain retained and count toward the quota; no implicit expiration can strand an offline device. Journal compaction and a negotiated minimum retained cursor are not part of v1.

## Vault and cryptographic envelope v1

`GET /api/v1/vault` returns `{ version, envelope }` or 404. `PUT /api/v1/vault` accepts `{ expected_version, envelope }` and returns `{ version }`. First creation requires `expected_version: 0`; subsequent versions compare-and-swap, returning 409 on mismatch. `envelope` is a **nonempty string**, bounded to 256 KiB serialized JSON, not an embedded object.

The string contains a strict envelope:

```json
{ "v": 1, "nonce": "base64url", "ciphertext": "base64url" }
```

Native Rust AES-256-GCM and browser WebCrypto AES-GCM use a uniformly random 32-byte key, a fresh random 12-byte nonce and a 128-bit authentication tag appended to ciphertext. Nonce, ciphertext, keys and digests use URL-safe base64 **without padding**. The envelope parser rejects unknown fields, unsupported versions and incorrect nonce/key lengths. Never derive a key directly from a human password. The recovery secret is separately generated 256-bit randomness.

Associated data is the exact UTF-8 string:

| Context | Associated data |
| --- | --- |
| Vault, encrypted under the recovery secret | `subrosa:vault:v1:{account_uuid}` |
| Synced object, encrypted under the vault key | `subrosa:object:v1:{account_uuid}:{kind}:{object_uuid}` |
| File chunk, encrypted under the vault key | `subrosa:blob:v1:{account_uuid}:{blob_uuid}` |
| Pairing envelope, encrypted under transfer secret | `subrosa:pairing:v1:{account_uuid}:{request_uuid}` |
| Share piece, encrypted under a key generated for that share | `subrosa:share:v1:{share_uuid}:{position}` |

A share context names no account, and that is deliberate. Its key is generated for one share and travels in a URL fragment, so there is no account for a reader to learn and nothing to confuse with another share: a different identifier or a different position fails to authenticate. Position 0 is the sealed head, which names every other piece and carries its digest.

The decrypted recovery-vault and pairing bodies are `{ "v": 1, "key": "base64url_vault_key" }`. Recovery and admission are independent of login. The service receives neither recovery nor vault keys. The current v1 uses the vault key with separate authenticated contexts; it does not claim independently rotated content/provider/statistics subkeys or forward secrecy after revocation.

An object body contains `{ v: 1, operation_id, parent_revision, deleted, resolved_revisions?, ...payload }`. The client compares these fields against server metadata after AEAD verification. The server-generated revision is unavailable when encrypting a new operation, so it is deliberately not the AEAD identity; the authenticated operation ID is. Native row payloads use `{ table, row }` with an explicit table/column codec allowlist in [`account/sync.rs`](../src-tauri/src/account/sync.rs). A peer cannot send SQL identifiers or arbitrary local paths. Sensitive Carpe Diem settings use the reserved settings object `00000000-0000-4000-8000-000000000001`; they are still encrypted.

## Physical device pairing

1. The requesting device creates a request UUID and a random 32-byte transfer secret. It persists its pending secret in the keyring before the first network request.
2. `POST /api/v1/pairing` with `{ request_id }` creates an account-bound five-minute request; at most five may be pending per account. Returns `{ request_id, expires_at }`.
3. The device displays a QR/manual transfer code: `srpair1.` followed by base64url UTF-8 JSON `{ request_id, account_id, secret }`. This complete code travels between the user's devices, **never through the relay service**. It is strictly size/UUID/key checked.
4. An unlocked trusted client validates the account in the transferred code and encrypts the vault-key body under its transfer secret with the pairing AAD above. `POST /api/v1/pairing/{id}/approve` sends only `{ envelope }`, capped at 16 KiB. A distinct same-account session/device may approve once.
5. `GET /api/v1/pairing/{id}` returns `{ envelope: null|string, expires_at }` only to the original browser session or requesting native device identity. Native access-token rotation retains that identity. Other accounts and other devices cannot read it.
6. The recipient decrypts and installs the key only after context/version validation, then `DELETE /api/v1/pairing/{id}` acknowledges. Losing that acknowledgement is harmless; the server entry expires and the recipient discards its transfer secret.

The transferred secret authenticates admission independently of the relay. A compromised relay cannot substitute an envelope encrypted with a secret it does not know. Revoking an account session does not retract a vault key or Carpe Diem credential already copied to a device.

## Encrypted files

`PUT /api/v1/blobs/{uuid}` accepts `application/octet-stream`, maximum 32 MiB, returning `{ id, bytes }`. IDs are immutable within an account. A same-size, same-digest retry succeeds; different bytes under the same ID return 409. `GET` returns owned ciphertext only, as `application/octet-stream` with attachment disposition. There are no public signed download URLs or plaintext filename parameters.

The native v1 file codec in [`account/files.rs`](../src-tauri/src/account/files.rs) uses one-MiB plaintext chunks and a two-GiB file limit. Each chunk is an encrypted envelope string encoded as UTF-8 bytes for blob upload. Its `{ id, bytes, sha256 }` manifest entry contains the **plaintext** byte length and base64url SHA-256 digest inside an encrypted `artifact` object. Manifests contain no persisted absolute path. They validate total lengths, duplicate chunk IDs and at most 2048 chunks. The receiving device authenticates/decrypts each chunk, verifies digest/length, persists progress and renames the staged file only after completion. Upload IDs and ciphertext are durable before PUT, so response-loss retries send identical bytes. Audio and Studio file formats/source kinds remain local codec allowlists; the service does not decode imported or generated files.

The service reserves quota through a committed blob intent before object storage I/O. An account lock protects upload/finalization against account deletion. A crash after PUT leaves a durable intent, so retry or erasure can locate the ciphertext. Default quota is five GiB across encrypted history, vault and blobs. Storage/quota policy is operator-configured, not a financial billing API.

## Shares

A share publishes blobs the account already uploaded as one object anybody
holding the link may read. See [ADR 0053](adr/0053-a-share-is-a-dated-envelope-the-server-cannot-open.md).

| Method and route | Contract |
| --- | --- |
| `POST /api/v1/shares` | `{ id, expires_at, blob_ids }`. `expires_at` is mandatory and must fall between one minute and thirty days from now. One to 2049 blob ids, each owned by this account, each distinct, and none already claimed by another share: a repeat is `409 conflict`, an unknown or foreign id is `404 not_found`. At most 200 live shares per account. Returns `{ id, created_at, expires_at, blobs, bytes }`. |
| `GET /api/v1/shares` | The account's live shares, newest first. Nothing in a row says what was shared. |
| `DELETE /api/v1/shares/{id}` | Stops the service answering immediately. No step-up: revoking only ever takes something away. |
| `GET /api/v1/shares/{id}/preview` | **No session.** `{ v: 1, blobs, bytes, expires_at }` for a live share, `404 not_found` otherwise. Never a title, a file name or an account. |
| `GET /api/v1/shares/{id}/blobs/{position}` | **No session.** The sealed piece at that position, `application/octet-stream` with attachment disposition. Positions are resolved against this share, so no blob id can be named by a caller. |

These are the only two routes that answer without a session. The key that opens
what they return lives in the URL fragment and never reaches the service.

Expired and revoked shares are released by maintenance: their storage keys join
the durable deletion queue, their rows are removed, and their bytes are returned
to the account quota. A share's blobs are exclusive to it, so a share of a file
stores a second copy of that file rather than pointing at the library's.

## Errors, operational boundaries and verification

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Malformed/unsupported request or cursor. |
| 401 | `unauthorized` | Missing, expired, revoked or replayed authorization. |
| 403 | `forbidden` | Origin/CSRF/authorization check failed. |
| 403 | `recent_auth_required` | Sign in again before a sensitive action. |
| 404 | `not_found` | Missing or invisible item. |
| 409 | `account_mismatch` | The session account changed relative to the client vault context; lock and refresh explicitly. |
| 409 | `conflict` | Version, idempotency, immutable-ID or pairing approval conflict. |
| 413 | `quota_exceeded` | Storage or body-size bound exceeded. |
| 428 | `authorization_pending` | Browser device approval still required. |
| 429 | `slow_down` | Throttle; honor `Retry-After: 5`. |
| 503 | `unavailable` | Infrastructure failure, with no sensitive provider detail. |

Independent signed erasure records are persisted in a separate production bucket and replayed before serving traffic. `restore-sanitize` invalidates restored sessions/refresh families and replays that ledger while the identity provider may be offline. Bucket retention/Object Lock, signing-key backup separation and the production restore rehearsal remain operator responsibilities. Details and threat boundaries are in the cloud README.

Local verification includes real PostgreSQL, signed OIDC/JWKS fixtures, negative nonce/audience/signature/browser-binding cases, CSRF, PKCE, refresh replay including concurrent rotation, tenant isolation, CAS, retained siblings and explicit resolution, bounded filtered pagination, immutable blobs, quota, pairing across token rotation, restored-session invalidation and authenticated deletion replay after a simulated database restore. These tests do not claim a production passkey tenant, live S3 conditional-write/retention validation, independent security audit, load test, notarized app release or public deployment.
