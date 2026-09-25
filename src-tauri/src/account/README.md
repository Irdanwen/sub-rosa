# Native accounts and encrypted synchronization

The account is optional. Local SQLite remains the working library; the account
service stores encrypted revisions and file chunks, and never executes inference.
The HTTP contract is in [accounts-sync-contract.md](../../../docs/accounts-sync-contract.md).
The protocol decisions are in ADRs 0049 and 0050. This module is shared by desktop
and iOS; every IPC command is registered in both handler lists.

## Identity and vault

New libraries use `https://subrosa.furetier.com` when the person chooses to sign
in or create an account. Merely opening the app or account settings does not
configure the service or contact it. Advanced settings retain custom HTTPS
services and device naming; existing libraries retain their configured origin.

`login.rs` opens the real sign-in page and the browser hands the session back
through `subrosa://auth/callback` (ADR 0055). The exchange needs two halves that
travel on two channels: the PKCE verifier, written to the keyring before the
browser opens and never sent until the exchange, and a 256-bit return code the
service creates only at the callback and delivers only in the deep link. A
stolen start link holds the first without the second; an application squatting
the scheme holds the second without the first. A link answering a request this
app did not start reports `account_login_unsolicited` and connects nothing. The
eight character code flow in `mod.rs` remains as a declared fallback, and apps
shipped before this send no `native` flag and are unaffected.

`mod.rs` keeps the session alive. Access tokens last 15 minutes; the keyring
stores the access and rotating refresh token as one JSON value. Refresh is
serialized, account/device identity is verified, and a durable in-flight marker
prevents replay after a lost response. Such a loss no longer requires a browser:
the `device` slot holds a 256-bit secret, handed back by the exchange, that
mints a new family through `/api/v1/session/renew` until the device is revoked
(ADR 0056). It is never rotated, and a renewal inherits the device's original
admission instant, so it can never satisfy the five minute step-up that guards
revocation and deletion. Renewals are stamped at most once every 30 seconds
(`renew_attempted_at`) so a restart loop cannot become a request loop. Signing
out uses `/api/v1/session/renounce`, which needs no step-up, instead of a bearer
revocation that quietly failed after five minutes. Credentials are never passed
through environment variables or returned to the webview. The configured root
must be HTTPS (debug builds also accept exact loopback HTTP), and redirects are
disabled.

`account_status` answers from SQLite and the keyring, never the network, and
reports `connection` as `none`, `connected` or `renewable`. A lapsed
session and a locked vault are different things: the vault key lives in the
keyring with no auto-lock, so a device whose session ran out is still unlocked.

The OS keyring contains separate account/server-scoped slots for sessions, the
device secret, the vault key, recovery material, and pending enrollment. A
sign-in with no account yet uses the literal `pending` in place of an account
id, which cannot collide with the UUIDs every other slot is keyed by. SQLite holds account
metadata and received ciphertext; ordinary document outbox snapshots remain
plaintext like the existing local library. Provider-secret snapshots are encrypted
before SQLite insertion. End-to-end encryption protects the service boundary, not
an unlocked device or its local working database. Logout disables synchronization and clears every secret
slot even offline, under the refresh lock, before best-effort remote revocation.
The library retains its account/server binding after logout and account deletion:
a different account cannot silently upload the previous person's local corpus.
There is currently no multi-account library/profile switcher.

`crypto.rs` uses AES-256-GCM with random 96-bit nonces. The JSON envelope is
`{v:1,nonce,ciphertext}` with unpadded base64url and the authentication tag appended
to ciphertext. The recovery kit is a random 256-bit secret, not a human password;
it encrypts `{v:1,key}` under AAD `subrosa:vault:v1:<account_id>`. Creation stages
both keys before the server request, so a lost acknowledgement is recoverable.
Content synchronization requires recovery confirmation or admission from an
already unlocked device. The deterministic WebCrypto interoperability fixture is
`../../tests/fixtures/account-vault-v1.json`; its key is public test material.

`pairing.rs` transfers the vault key through an opaque five-minute relay. The
requesting device generates a 256-bit secret included only in the out-of-band
transfer code. The approving device encrypts the key with that secret and AAD
`subrosa:pairing:v1:<account>:<request>`. The service never receives the secret.
A paired device need not hold the recovery kit. The code must travel through a
channel the user trusts; possessing it grants admission when an unlocked device
approves it. `account_pairing_resume` rebuilds a pending request locally, with
no network call, so a reloaded window no longer strands it until it expires. On
a locked device the requesting half is offered inside the vault card, above the
recovery key, because a recovery key is most likely to leak at the moment it is
taken out to be pasted (ADR 0057).

Carpe Diem credentials have their own encrypted settings object. Explicit restore
validates the proposed key using authenticated, free `/credits`, with a bounded
response, before activation. Public `/models` cannot validate a key. Native
activation stores the URL and key atomically in one keyring value. Readers and
legacy migration share a mutex; a keyring error or corrupt paired value fails
closed rather than falling back to an old key. The webview never receives the
provider key. Custom providers without the Carpe Diem credits contract cannot be
activated through this restore path.

## Durable revision and file protocol

`sync.rs` installs SQLite triggers alongside migration 023. Every local mutation
and its outbox snapshot commit in the same transaction. Pausing synchronization
stops networking but keeps recording edits once the library is account-bound.
The worker freezes an immutable encrypted operation before sending it, then
retries the same operation UUID and ciphertext after interruption. Own accepted
revisions are tracked to prevent false conflicts when the journal echoes them.

Object AAD is `subrosa:object:v1:<account>:<kind>:<object_id>`. The encrypted payload
also authenticates `v`, `operation_id`, `parent_revision`, `resolved_revisions`,
`deleted`, `table`, and row data. Decryption verifies server metadata against the
protected values. Incoming changes, dependency deferrals, and the pull cursor are
committed transactionally. Pending parents are replayed from the durable inbox.
Concurrent branches are retained for review; explicit resolution acknowledges all
known heads. A new concurrent branch remains a conflict. Resolution can keep the
current version, use the received version, or copy a note; finished note summaries
follow the selected note. A received deletion requires explicit review.

A durable `account_sync_issues` row isolates a rejected local object or file so
other objects keep moving. Later operations for the same object wait behind its
blocked revision. The account panel shows the outstanding count and lets the
person retry after correcting the content or file. A newer snapshot can replace
an oversized operation only when that operation was rejected locally before
HTTP. Transport failures and unauthenticated incoming revisions still stop the
run; silently skipping remote ciphertext would lose data or hide tampering.

For two note heads with one authenticated common parent, the native client tries
a three-way merge of independent row fields and non-overlapping edited-content
lines. It records the result as a new revision resolving the remote head. An
overlap, missing ancestor, concurrent edit to the same non-text field, deletion,
or pending local operation remains a conflict for review. Existing explicit
resolution choices remain available.

`files.rs` stores an immutable ciphertext chunk before uploading it. Chunks are
1 MiB, each with a random UUID, AES-GCM AAD `subrosa:blob:v1:<account>:<chunk_id>`,
and a SHA-256 plaintext digest authenticated by the encrypted manifest. Manifests
are bounded to 2 GiB and 2048 chunks. Download progress is durable after each
verified, flushed chunk; final rename happens only when all checks pass. Staging
is outside the gallery. Paths are generated locally, not taken from remote
payloads, and iOS gallery paths are reconstructed from relative filenames.
One upload and one download chunk are processed per sweep. Native timers, launch,
resume, and background sweep all resume durable work; no JavaScript polling
promise owns long-running synchronization. Account HTTP traffic uses the shared
client factory and records only destination, purpose, counts, status and duration.
It is excluded from the AI usage counters.

## What crosses devices

| Data | Behavior |
| --- | --- |
| Notes and folders | Body, title, metadata, folder membership and finished long-form summary |
| Transcripts and recordings | Transcript rows, finalized recording metadata and bounded audio files |
| User memory | Stored facts; no embeddings or provider authorization is transferred |
| Conversations | Portable visible user/assistant history; explicit continuation starts a new turn |
| Imports | Historical ingest metadata and resulting notes/transcripts; no remote download or paid execution |
| Studio | Completed gallery files and available prompt/model metadata; no remote job execution |
| Provider configuration | Encrypted URL/key, activated only after explicit authenticated validation |
| Usage | Observed request counts/bytes, available turn counters, and dated balance snapshots |

`conversations.rs` mirrors visible Hermes history into shared SQLite tables and
backfills ten changed desktop sessions per sweep. Runtime tool messages, system
instructions, approvals and runtime authorization are excluded. Imported tasks
are marked completed, never paused: mobile resume logic interprets a paused
last-user turn as pending paid work. Continuing portable history requires a new
user message and creates a branch; it cannot reuse an old tool approval.

In-progress recording, ingestion, long-form summaries and Studio jobs remain owned
by their originating device. They keep that device's existing durable resume
behavior. Receiving their history or eventual result never queues a duplicate
paid operation. A locally active long-form summary defers an incoming note until
its local work finishes. There is no execution-ownership transfer protocol.

Usage counters are not a provider invoice. `account_usage` is per device/day/model
and counts observed AI request attempts and bytes. `account_turn_usage` is the
latest cumulative snapshot per process-run UUID: keep the latest revision per ID,
then sum distinct IDs. Counters can lose the last unsampled interval on a crash;
financial coverage depends on reported turn data, and missing cost is null.
`account_billing` is refreshed at most every five minutes and stores a dated
provider balance per device: display a recent observation, never sum balances.

## Explicit remaining limits

- Studio workflow definitions, production bibles, arbitrary frontend preferences,
  Hermes profiles and runtime configuration, arbitrary note attachments, and local
  memory enable/auto-extract preferences are not synchronized.
- The shared vault root is not rotated on device revocation. Revocation blocks
  future service access, but cannot erase prior copies or make the already-known
  root unknown. Cryptographic exclusion from future ciphertext would require an
  authenticated per-device key distribution and epoch rotation protocol. A stolen
  provider key must also be rotated at its provider. No such guarantee is claimed.
- Files above the manifest limit are excluded with a durable synchronization error.
  Individual encrypted object revisions are limited to 1 MiB by the service; an
  oversized revision remains queued and reports a size error. Removing or changing a source during
  upload can defer its transfer. Abandoned encrypted chunks need service retention
  maintenance; the native client does not garbage-collect server blobs.
- Resolved conflict ciphertext is retained locally for preservation. There is no
  account-wide automatic retention policy or multi-account profile migration UI.
- Background delivery is subject to iOS scheduling; closing the app is not a
  promise of immediate transfer. Independent cryptographic audit, production load
  testing, real-device background QA and deployment remain release work.

## Verification

From `src-tauri`:

```sh
cargo fmt --check
cargo clippy --lib -- -D warnings
cargo test --lib
cargo test --test egress --test ipc_write_paths --test no_secret_in_logs --test no_secrets_in_process_env --test shared_commands --test sidecar_secrets_on_stdin
cargo check --target aarch64-apple-ios --lib
cargo check --target aarch64-apple-ios-sim --lib
```

The ignored live test uses two real on-disk SQLite stores and the real service,
without reading or modifying the user's keyring. It verifies note/summary
convergence, concurrent edit resolution, interrupted two-chunk WAV transfer with
receiver database reopening, a completed Studio PNG, and deletion versus an
offline edit. Its fixture contains disposable account sessions and a random test
vault key, never a provider key. Keep the JSON file mode 0600, pass only its path
in the environment, and remove it after testing. Access tokens expire, so create a
fresh fixture for a new run.

```sh
SUBROSA_TEST_FIXTURE=/absolute/path/to/protected-fixture.json cargo test --lib account::live_tests::two_durable_stores_converge_preserve_resolve_and_transfer_real_files -- --ignored
```

Backend test provisioning instructions and the repeatable local fixture generator
live under `subrosa-cloud/scripts/`. With the disposable local identity/API
harness running, create a fresh fixture with
`cd subrosa-cloud && python3 scripts/native-fixture.py --local-test-only`.
This refuses non-loopback APIs and any database other than the dedicated QA
database, and prints only the protected fixture path. These checks demonstrate implementation
behavior; they are not a security audit or proof of every mobile lifecycle.
