# 39. The database is not encrypted at rest

Date: 2026-09-01

## Status

Accepted

## Context

A September 2026 security audit noted that the app's SQLite database carries
every note, transcript, memory and agent message in plaintext on disk, and that
SQLCipher is absent. It observed, correctly, that this is coherent with the
threat the product is built around — the network, not the disk — and then made
the sharper point: the question had never been *asked*. There was no record of
a decision, only an absence.

That is the part worth fixing. A confidentiality product that has not written
down what it does not protect is asking to be read generously, and the first
person to read it ungenerously will be a user who assumed otherwise.

The facts the decision rests on:

- The API key is the one secret that is genuinely protected at rest today. It
  lives in the OS keychain, and the app's own data directory does not contain
  it in any form.
- Everything else — notes, audio, generated media, the memory table — is
  ordinary files in the app data directory, readable by anything running as the
  user.
- Every desktop platform Sub Rosa ships on has full-disk encryption available
  and on by default on current hardware: FileVault, BitLocker, and hardware
  encryption on iOS tied to the passcode.
- The app has no server, no sync, and no account. Nothing leaves the machine
  except a request to the configured endpoint.

## Decision

The database stays unencrypted, and the threat model
([docs/threat-model.md](../threat-model.md)) says so out loud, in the "out of
scope" section, next to the platform mechanism that does cover it.

SQLCipher is rejected for now, on three grounds.

**It would protect against an attacker the app cannot beat anyway.** The
realistic scenario is a machine that is stolen, or code running as the user.
Against the first, full-disk encryption is the answer, and it is already there.
Against the second, a SQLCipher key would have to be readable by the app
without a passphrase prompt — which means the keychain — and an attacker
running as the user can ask the keychain, with the app's own identity, for
exactly that key. The encryption would be real and the protection would be
theatre.

**A passphrase would be a different product.** Encryption that actually resists
same-user code execution needs a secret the user supplies and the app does not
store. That means a prompt at every launch, a recovery story for a forgotten
passphrase, and an answer for the background work this app depends on: the
sweep on cold launch, the BGTask handlers, and the durable rows of ADR-0018 all
run with no user present. Sub Rosa records meetings and processes them later;
a database it cannot open without a person in front of it is a different
application.

**It is not free.** SQLCipher means a different `libsqlite3-sys`, a build
change on three platforms plus iOS, a migration path for every existing
install, and a permanent divergence from upstream June's storage layer, which
`upstream-sync.yml` re-merges on every sync.

## Consequences

The user gets a plain answer instead of an implied one. Settings › Privacy
names what is protected and by what, and the threat model gives the same answer
in more detail for anyone auditing the app from outside.

Encrypted **export** stays open and is a better use of the same effort: it
covers the case a person actually has — an archive leaving the machine — with
no launch-time cost and no migration. It is not part of this decision.

The answer changes if any of these become true, and this ADR should be
superseded rather than amended:

- Sub Rosa ships on a platform without full-disk encryption available by
  default;
- a sync or backup feature moves the database off the machine;
- the product takes on a user for whom same-device compromise is the expected
  threat rather than the worst case, at which point the passphrase product
  described above is the honest thing to build.

## Alternatives considered

**SQLCipher with a keychain-held key.** Rejected above: real encryption,
theatrical protection, and a permanent cost on every platform.

**Encrypting only the `memories` table.** Considered because memory is the most
personal thing the app stores. Rejected as worse than either extreme: it
implies the rest is protected, and a transcript usually contains everything the
memory extracted from it.

**Saying nothing.** What the code did before this ADR. Rejected: on a
confidentiality product, an unanswered question reads as a claim.
