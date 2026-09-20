# ADR 0053: A share is a dated envelope the server cannot open

- Status: accepted
- Date: 2026-09-19

## Context

There was no way to show somebody a note. Export wrote a PDF or a Markdown
file ([`note_export.rs`](../../src-tauri/src/note_export.rs)) and left the
carrying to you, and there was no way at all to read your own notes on a
machine without the app installed. Both are ordinary things to want, and
neither had an answer.

The account service ([ADR 0049](0049-accounts-synchronise-ciphertext-without-hosting-inference.md))
already holds encrypted objects for exactly one reader: the account that wrote
them. A share has a different shape. The reader has no account, will not make
one, and must not be given anything that reaches the rest of the library. The
question was where the key for that reader lives, given that the service may
not have it.

## Decision

**A share is a fresh key, ciphertext on the service, and the key in the URL
fragment. The service stores an owner, a count, a deadline and opaque blob
ids, and can open none of it.**

- **A key per share, never the vault key.** `account/shares.rs` generates 32
  random bytes, seals the document under them with the context
  `subrosa:share:v1:{share_id}:{position}`, and puts the key in the fragment of
  the returned URL. A fragment is not sent with a request, so the bytes and the
  key that opens them meet only in the reader's browser. Nothing the key opens
  exists beyond that one share.
- **Two public reads, and only two.** `GET /api/v1/shares/{id}/preview` and
  `GET /api/v1/shares/{id}/blobs/{position}` are the service's first endpoints
  that answer without a session. The reader asks by **position**, never by blob
  id, so one share can never be walked into another's bytes, and the preview
  carries a count, a size and a deadline — never a title, a file name or an
  account.
- **The deadline is a column, not a convention.** `shares.expires_at` is `NOT
  NULL`, the API refuses anything outside a minute and thirty days, and the
  surface offers three choices with no "forever" among them. Revocation is
  immediate; release is a job.
- **Release is the garbage collection the service did not have.** Maintenance
  drains expired and revoked shares: the storage keys go on the same durable
  queue account deletion uses, the rows go, and the bytes come back off the
  quota. A share can cost quota precisely because something gives it back.
- **A share's blobs are exclusive, and fresh.** `share_blobs` holds a unique
  index on `(account_id, blob_id)`, and a share never reuses a blob the library
  already has. The service cannot read the manifests that would tell it who
  else is using a blob, so exclusivity has to be a constraint rather than a
  hope, and the cost is that sharing a file stores a second copy.
- **One decryptor, two doors.** The share viewer (`/s/{id}`) and the web
  reader (`/account/library`) are the same page, the same `vault.ts`, the same
  primitives. One door opens with a fragment key and shows one object; the
  other opens with the recovery secret and shows the library, read only. The
  browser's decryption surface is factored, not doubled.
- **Proposed, never applied.** Making a link is an outward-facing action, so
  the agent may propose it as an `agent_actions` row ([ADR 0024](0024-chat-blocks-are-in-band-fenced-json.md))
  and only a tap creates it.

## Consequences

- What revocation cannot do is printed where the link is made, not buried:
  *revoking stops the link working, it cannot erase a copy someone has already
  downloaded.* That is [ADR 0050](0050-vault-admission-uses-an-out-of-band-secret.md)
  read honestly at the moment it matters.
- The fragment is in the reader's history and in whatever message carried it.
  A share link is a bearer credential and is treated as one: short by default,
  revocable, and never reused.
- The web reader is **read only**, and not as a limitation to lift. Writing
  from a browser would put a second author on the journal with none of the
  app's conflict handling, on the surface `docs/threat-model.md` already names
  as outside its boundary.
- Sharing needs an account but not synchronisation and not an unlocked vault:
  you can show one note without having agreed to synchronise anything.
- A file share (a recording, a film) is the same shape with more positions, and
  the service already accepts it. The client does not do it yet: a multi
  hundred megabyte upload has to be a durable row ([ADR 0018](0018-ios-background-work-is-durable-rows.md)),
  not a command that runs for two minutes, and that row is not written.

## Alternatives rejected

- **A signed download URL.** It would put the service in the position of
  granting access to plaintext-shaped objects, and it needs the service to know
  which object is which. The fragment key needs neither.
- **Deriving the share key from the vault key.** One leaked link would then be
  evidence about every other one, and revocation would mean rotating the vault
  root, which ADR 0050 says does not happen.
- **Reusing library blobs instead of copying.** Cheaper in bytes, and it makes
  release unsafe: the service cannot tell whether a blob it is about to delete
  is still named by an encrypted manifest.
- **A server-side index so the web reader can search everything.** It would be
  an index the service can read, which is the thing it is built not to have.
  Search runs over what the tab pulled and decrypted.
