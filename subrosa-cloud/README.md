# Sub Rosa account service

Optional identity, device authorization and end-to-end encrypted synchronization service. It is separate from the local `june-api` sidecar. The service never receives a vault key, Carpe Diem key, recovery code or decrypted note. Ciphertexts remain opaque. Email, account IDs, device labels, opaque object IDs, transport timing and sizes remain visible metadata.

The seven-crate workspace enforces the dependency boundary: domain contracts, typed configuration, PostgreSQL repositories, external providers, application services, HTTP API, composition root. PostgreSQL serializes journal changes on the account row; there is no process-local synchronization truth.

## Run and verify

Rust 1.95.0 and PostgreSQL are required. Production also needs an OIDC provider with verified email, passkeys configured at that provider, and private S3-compatible storage.

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
./scripts/test-integration.sh
```

The test runner creates and removes an isolated loopback PostgreSQL cluster. Override `SUBROSA_TEST_PORT` if 55439 is busy, or set `SUBROSA_TEST_DATABASE_URL` to a dedicated test PostgreSQL admin URL. Each integration fixture creates an independent database; never point this at a production database. The test suite does not silently skip when PostgreSQL is unavailable. Unit tests have no external I/O.

For browser QA against the real website, first start PostgreSQL on port 55439 and the website on `http://127.0.0.1:1430` with `/api` and `/auth` proxied to port 8088:

```sh
cargo run -p subrosa-api --example local_identity
```

This example serves the account API at 8088 and an explicit **local test identity** page at 8788. Click its confirmation button to sign in as `qa@example.test`. It verifies a real PKCE exchange and produces RS256 tokens that the production OIDC adapter validates against its JWKS. Each process generates an ephemeral RSA signing key in memory and derives its JWKS from that key. No private signing key is stored in the repository or written to disk. This issuer is test-only and excluded from the production binary and container. `SUBROSA_TEST_PUBLIC_URL` can override the website origin, restricted to HTTP loopback. The QA database (`subrosa_browser_qa`) and encrypted files are persistent so a browser refresh tests recovery rather than recreating fixtures.

## Reproduce the native two-device proof

Keep the local PostgreSQL cluster and `cargo run -p subrosa-api --example local_identity` running. After compiling the native test binary, generate a fresh disposable account with two native sessions:

```sh
# From subrosa-cloud/
python3 scripts/native-fixture.py --local-test-only
```

The command prints only an absolute temporary JSON path. The file is mode 0600 and contains disposable access/refresh tokens plus a random test vault key. It contains no user keyring entries or Carpe Diem credential. The generator requires an explicit local-test acknowledgement, permits only HTTP loopback API origins and the specifically named loopback `subrosa_browser_qa` database, disables HTTP proxies/redirects, inserts only locally generated fixture identifiers, then verifies both resulting sessions against the real API before returning the path. It is never part of the production binary or service routes.

Use the printed path immediately, because access tokens expire after fifteen minutes:

```sh
# From src-tauri/
SUBROSA_TEST_FIXTURE=/absolute/path/from/generator.json cargo test --lib account::live_tests::two_durable_stores_converge_preserve_resolve_and_transfer_real_files -- --ignored
```

The native test creates two on-disk SQLite stores and checks encrypted synchronization, concurrent/offline conflicts and their resolution, retries, restart recovery, note summaries and real audio/Studio file chunks against the local service. Generate a new account for each run so journals are independent; remove the protected fixture file when finished. Test data remains only in the disposable QA database and temporary ciphertext directory described above. Never point PostgreSQL arguments through a production tunnel.

## Production configuration

Copy `config.example.toml` to a secret-managed configuration file mounted read-only; replace every `.invalid` hostname and sample value. Variables prefixed `SUBROSA_CLOUD_` override fields, with `__` for nesting, e.g. `SUBROSA_CLOUD_OIDC__CLIENT_ID`. No secret is mutated into the environment or passed to child processes by the service. Secret types redact `Debug` and erase owned buffers on drop. SQL credentials and OIDC client secrets belong to the deployment secret manager, never the website bundle.

1. Provision private PostgreSQL in the chosen region, with TLS verification, PITR and separately protected backups. Create a least-privilege runtime role; use a separate migration credential in the deployment job.
2. Register a confidential OIDC client with exact callback `PUBLIC_URL/auth/callback`, authorization code, `client_secret_basic`, PKCE S256, signed RS256/ES256 ID tokens and scopes `openid email`. Require verified email. Enable passkeys and recovery in the identity provider. Discovery must return its exact configured issuer. `max_age=0` requests fresh authentication and the provider must return `auth_time`.
3. Provision a private S3 bucket and a separate protected deletion-ledger bucket. Give the service only object get/put/delete permissions for that bucket, preferably through workload identity. Turn off public ACLs and anonymous reads. Verify conditional create support on a compatible provider before launch. Configure encryption at rest, access logging with restricted retention, and explicit version-lifecycle deletion policy.
4. Run `subrosa-cloud migrate` once with migration credentials, then `subrosa-cloud serve` with runtime credentials. Production validation requires HTTPS origins and S3 storage. The binary fails closed if OIDC discovery or identity validation fails. It does not provide a fake production login.
5. Put the API behind the same account origin as the website using `deploy/Caddyfile.example`. Keep the public marketing origin separate when deployed. Native apps can call the account API with bearer sessions. Do not enable wildcard credentialed CORS.
6. Apply ingress request limits by actual client IP and request size. The API deliberately ignores untrusted forwarding headers. Its own counters are durable per connection peer, which may be your reverse proxy: configure an authenticated ingress limit appropriate to traffic before horizontal scaling. The API also bounds concurrent buffered requests to 16 and total request time to 30 seconds.
7. Run a migration, login, pair, revoke, two-device offline conflict, quota and restore rehearsal in staging. Validate live IdP passkeys and live S3 semantics before opening registration. No domain, identity tenant, storage account or deployment is provisioned by this directory.

Build from this directory with `docker build -t subrosa-cloud .`. The runtime is non-root, contains no toolchain, and does not contain test OIDC fixtures. The database migrations are embedded in the binary. Docker builds require a Docker runtime; the Rust service and real PostgreSQL suite can be validated without one.

## Authentication and authorization

The wire contract is `../docs/accounts-sync-contract.md`. Success returns `{data: ...}`, errors return `{error: {code, message}}`. Infrastructure errors do not return provider bodies, SQL details or secrets.

Browser sessions are random opaque 256-bit tokens, stored only as SHA-256 hashes in PostgreSQL. Production cookies are `__Host-subrosa_session`, `Secure`, `HttpOnly`, host-only, `Path=/`, `SameSite=Lax`. The readable `subrosa_csrf` value is cryptographically bound to the current session token; browser mutations require its exact header/cookie match and exact configured Origin. Native bearer tokens cannot be used as browser cookies and vice versa. Authorization is checked in PostgreSQL on every authenticated request. An optional `x-subrosa-account-id` assertion binds each request to the client's unlocked account context: mismatch returns 409 `account_mismatch` before any data access, preventing another browser tab's cookie change from mixing vaults. This header never selects or authorizes a tenant. Logout invalidates the server row.

Browser sessions expire after 12 hours. Native access tokens expire after 15 minutes. A device exchange also issues a refresh token; `POST /api/v1/session/refresh` consumes it exactly once and returns a new access/refresh pair. The refresh family has an absolute 30-day lifetime. Every refresh hash is retained until that family expires so reuse is detectable. Reusing any consumed refresh token, including a concurrent duplicate, commits revocation of the entire family and all access generations. Clients serialize rotation and atomically replace the complete pair in the keyring. Losing a refresh response requires browser reauthentication; blindly retrying an old refresh token intentionally revokes the family. Sensitive account deletion and device revocation require authentication within five minutes. OIDC authentication and E2EE unlock are separate operations.

Device login has a ten-minute lifetime, a 40-bit human code and 256-bit PKCE verifier. Approval requires a signed-in browser, fresh authentication and a deliberate POST; visiting the verification link does not approve. Exchange is verifier-bound, single-use and throttled. Device revocation deletes its sessions. It cannot erase ciphertext or provider credentials already copied to that device.

The five-minute pairing relay accepts only bounded encrypted envelopes and at most five pending requests per account. The requester session alone reads/acknowledges its envelope; a distinct same-account session can approve once. Native pairing binds to the device identity so a short access-token rotation does not interrupt it; browser pairing remains session-bound. Device revocation deletes its pending entries and all reads still require a live session. The native transfer code authenticates the secret independently of this relay; the server has no transfer secret.

## Journal, quota and storage semantics

Every account owns a monotonically increasing cursor. A push is atomic across up to 100 operations and four MiB of ciphertext. Retrying an operation ID with the same bytes returns its original revision and cursor; changing its body under the same ID returns a conflict. A stale parent creates a sibling revision, preserving all heads. A parent belonging to another object or account is rejected. A child retires its own parent. An explicit conflict resolution can additionally acknowledge up to 64 `resolved_revisions`; the server validates each belongs to this account/object and retires only those heads. Unseen concurrent heads survive, while a resolution that acknowledges every current head exits the conflict state. Deletion is a ciphertext-bearing revision, so deletion/edit races retain the competing revision.

Kinds are explicitly allowlisted in Rust and constrained by SQL. Object, revision, operation and device IDs are UUIDs; these fields must not contain titles. The app owns encryption, authenticates inner metadata, and resolves conflict copies. The service cannot tell whether a malicious authorized client submitted meaningful encryption, and does not claim to.

The default account quota is five GiB, including retained encrypted revision history, vault envelope bytes and encrypted blobs. Quota reservation, cursor allocation and revisions share account locks, preventing concurrent writes from overcommitting. History and tombstones do not expire automatically: offline clients cannot silently miss a deletion. History compaction and a negotiated minimum cursor are not implemented. Plan storage growth accordingly; raising a configured quota is currently an operator action. Shares are the one thing that gives bytes back: maintenance releases expired and revoked ones, queues their storage keys for deletion and returns their size to the quota.

Blob IDs are immutable within an account. Upload retry succeeds only for the same SHA-256 digest and size; the object store also uses conditional creation and checks an existing object's digest. Each blob is at most 32 MiB; clients must split larger artifacts into encrypted chunks. References are authenticated by the client. GET checks ownership before reading the store and never exposes a public object URL. A blob claimed by a share is additionally readable without a session, through that share and by position only; see the shares section of [the wire contract](../docs/accounts-sync-contract.md).

A committed blob intent reserves quota before object I/O. The account lock is held across PUT/finalization, so account removal cannot interleave an upload. If the process dies between the PUT and metadata commit, the intent still locates and accounts for the ciphertext; retry can finalize it. Account removal adds both complete blobs and pending intents to a durable deletion queue. The worker runs each minute and retries failures. The `maintenance` command also drives cleanup. The queue is never tied to a web request lifetime.

## Operations and recovery

`GET /livez` checks the process; `/readyz` checks PostgreSQL. Monitor availability, HTTP error counts at the ingress, pool saturation, storage quota rejection, oldest `blob_deletions.created_at`, pending intent age, S3 failures and database growth. Do not log cookies, Authorization headers, URL query strings (OIDC codes), request bodies or decrypted content at the proxy.

Back up PostgreSQL and the ciphertext bucket on compatible schedules. **The deletion ledger must remain outside that restore set.** Production requires a distinct S3 bucket with immutable account-deletion records containing only a random account UUID, protocol version and deletion time. Each record is signed with HMAC-SHA256 using a versioned signing-key ring held in an independently backed-up secret manager. The record is persisted before database erasure. The service authenticates and replays the full ledger before binding its public listener and during maintenance; it never trusts a restored database checkpoint. Tampered records, missing keys or unavailable ledger storage fail startup closed. A separate signing-key ID permits rotation while retaining old verification keys.

After restoring into a private environment, run `subrosa-cloud restore-sanitize` before reopening traffic. It invalidates all browser/native sessions, refresh families, pending authorizations and pairings, marks old device authorizations revoked, then replays deletion intent and drives blob cleanup. `subrosa-cloud maintenance` and `restore-sanitize` work while the OIDC provider is offline. The real PostgreSQL restore test recreates an erased account from an older database snapshot and proves the independent ledger erases it again; a tampered ledger is rejected.

Give the runtime ledger credentials create/read/list privileges only, **never delete**. Enable Object Lock or equivalent retention and block bucket/version deletion through independently controlled policies. Separate bucket configuration is enforced by the application; retention, account separation and disaster-recovery controls must be verified at the provider. A database restore must not roll back or replace the signing-key ring or ledger. Object-store administrators who can erase the complete ledger remain a trust boundary; signatures detect alterations, not suppressed records. Periodic full reconciliation favors recovery correctness over listing efficiency, so measure ledger scan time before high-volume deployment.

Confirm per-account cursors, retained heads, vault versions, blob digests and deletion records after restore. Account deletion cannot purge immutable historical backups immediately; publish the backup expiry and S3 version-retention policy. Retain opaque deletion records until every backup capable of resurrecting that account has expired; their lifecycle is an operator-controlled privacy decision, never automatic deletion by the app.

A suspected device compromise requires revoking its session and replacing the Carpe Diem credential through Carpe Diem where needed. A database compromise requires invalidating sessions, rotating service secrets, restoring integrity and reviewing metadata exposure. The encrypted vault does not make a compromised website's JavaScript trustworthy; deploy the account origin without third-party scripts, with CSP, protected build/deploy credentials and independent security review.

Completed local validation covers signed OIDC acceptance/rejection, state replay, browser binding, nonce/audience/signature/email freshness checks, CSRF and Origin, PKCE, session revocation, concurrent journal writes, idempotent retries, account isolation, vault CAS, quotas, immutable blob retries, durable deletion, and pairing ownership/replay/expiry, pairing across access rotation, consumed/concurrent refresh replay, explicit sibling resolution, signed deletion-ledger replay/tampering and restoration session invalidation. A production IdP, passkey UX, S3 service, disaster recovery rehearsal, container build, load test and independent security audit remain deployment acceptance tasks.

`GET /api/v1/sync` accepts an optional allowlisted `kind` filter. Clients keep a cursor **per filter** and must not reuse a settings cursor for notes. Pages are capped below eight MiB of actual serialized JSON (including escaping), even when `limit=500`; rows stream from PostgreSQL rather than buffering the entire matching corpus. A page stopped by byte/count limits advances only to the last returned revision. A completed filtered scan advances to the account watermark taken in a repeatable-read snapshot, so unrelated kinds do not force endless empty scans and concurrent commits are not skipped. `has_more` describes remaining matching revisions within that snapshot.
