# ADR-0050: vault admission uses an out-of-band secret

Date: 2026-09-14. Status: accepted for this implementation, subject to independent review before public launch.

## Context

Account login must not automatically grant access to the Carpe Diem key or notes.
A second device should not require another provider key entry. The design
considered signed per-device public-key admissions and rotating content-key
epochs. An incomplete trust graph would provide misleading guarantees if an
attacker can replace keys in the server database.

## Decision

Generate a random 256-bit vault key on the client. Protect the recovery envelope
with a separate random 256-bit recovery secret, confirmed by the user. Use
AES-256-GCM, fresh 96-bit nonces and explicit account/object/purpose contexts.
The versioned envelope and shared Rust/WebCrypto fixture are specified in the
[wire contract](../accounts-sync-contract.md).

For pairing, the receiving device generates a one-use 256-bit secret and request
UUID. The QR/code transfers them out of band to an already unlocked device. That
device explicitly confirms and encrypts the vault key under the pairing secret,
binding the account and request ID as authenticated context. The relay stores
only this ciphertext and expires the request after five minutes. A login without
the physical code cannot substitute a decryptable envelope. Requester and
approver have distinct authenticated sessions belonging to the same account.

Browser keys live only in memory and lock on inactivity; native keys live in the
platform keyring scoped to the server and account. Recovery by email restores
identity access only. A support operator cannot reconstruct a lost recovery key.

## Limits accepted explicitly

- One vault root protects all object kinds with separate authenticated contexts,
  not independent per-purpose compromise domains.
- Revocation is enforced by online session and device checks. It prevents further
  service access, but does not rotate the cryptographic root. A revoked device
  obtaining future ciphertext through a separate leak can still decrypt it.
- Rotating a new key under the old shared root does not fix that limitation and
  is deliberately not presented as a security feature. True post-revocation
  cryptographic isolation requires authenticated per-device key distribution,
  epochs, rollback protection and an independently reviewed migration protocol.
- Previously downloaded data cannot be erased remotely. A lost Carpe Diem key
  must also be replaced at Carpe Diem; revoking a Sub Rosa session does not revoke
  provider spending credentials.
- A compromised web deployment can serve code that steals an unlocked key.
  CSP and absence of third-party scripts reduce exposure but do not remove this
  web delivery trust boundary. Native local storage still follows ADR-0039.
- The server can withhold or replay valid older content to a fresh client. GCM
  authenticates content and metadata; it is not a globally witnessed journal.

## Consequences

This is a bounded first protocol with testable admission, recovery and tamper
rejection. It does not claim the stronger signed-device/epoch guarantees of the
initial design. Keep these limitations in security documentation and require
the stronger protocol before promising confidentiality from a revoked device
colluding with a compromised server.
