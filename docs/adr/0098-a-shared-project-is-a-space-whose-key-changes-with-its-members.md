# ADR-0098: A shared project is a space whose key changes with its members

Date: 2026-10-08. Status: accepted for a preview behind a switch, off by
default. Enabling it by default waits on an independent review of the
protocol (an external gate). Leaves the vault (ADR-0050), shares (ADR-0053)
and the browser device (ADR-0096) as they are.

## Context

The parity matrix (ADR-0078) has two rows no single-account design can close:
**shared projects** and **group chats**. Both mean several accounts reading and
writing the same content. Everything the account service held so far was
ciphertext for one account, under one vault root per account (ADR-0049,
ADR-0050), or for whoever holds a share link until its deadline (ADR-0053).

ADR-0050 names, as the protocol it deliberately did not build, "authenticated
per-device key distribution, epochs, rollback protection and an independently
reviewed migration protocol". Sharing between accounts needs most of that:
a key several accounts hold, a way to hand it to a newcomer that the service
cannot subvert, a way to stop handing it to someone who left, and a way to
notice when the service shows an older membership than the one already seen.

## Decision

**A shared project is a "space": content encrypted under a space key that
changes at every membership change (an epoch), sealed to each member's
account identity key, under a chain of signed heads the members verify. The
service carries it and authorizes by membership; it never holds a key that
opens it. The full protocol, threat model and review checklist are
[docs/security/spaces-protocol.md](../security/spaces-protocol.md).**

1. **An identity per account, kept in the vault.** X25519 for receiving keys,
   Ed25519 for signing, self-signed public bundle published on the service,
   private keys sealed under the vault key next to it. Every device that can
   open the vault can act as the account in a space; no new admission
   ceremony is needed. The service refuses to replace an identity while the
   account is in a space.
2. **A key per epoch, wrapped with HPKE, committed in a signed head.** Each
   epoch has a fresh key sealed to every member (RFC 9180, X25519 /
   HKDF-SHA256 / AES-256-GCM) and a head signed by its author, chained by hash
   to the previous one, carrying an HMAC commitment to the key. Only the owner
   changes membership; any member may rotate out members who signed a leave
   statement. Admission seals earlier keys to the newcomer, so a project's
   history is theirs to read.
3. **Objects are encrypted and signed.** Authenticated data binds the space,
   the epoch, the kind, the object, the revision and the author; the author's
   signature binds the ciphertext, so no member can write in another's name.
   The service accepts writes under the current epoch only.
4. **Invitations by link, trust by safety number.** The link's fragment
   carries a one-time secret; the payload it opens carries the inviter's
   identity, which anchors the invitee's verification of the whole chain. The
   invitee proves possession of the link with an HMAC the service relays but
   cannot forge, and the owner's device checks it. Both sides are shown a
   sixty-digit safety number to compare out of band before joining and before
   admitting.
5. **Rollback is detected, not prevented.** Each device keeps the last head it
   verified per space; an older or different head at the same epoch is
   refused. The service also refuses an epoch that is not the next one.
6. **Group chats are conversations in a space.** A message is an object. When
   a member asks the assistant, that member's device runs the turn with that
   member's Carpe Diem key (the sidecar on an app, the bounded browser key on
   the web, ADR-0096); the reply is that member's signed message with
   `paid_by` naming them, so everyone sees who paid. A reply waits as a
   durable row on the asking device (ADR-0018). Nothing new runs on the
   service.
7. **A preview behind a switch.** Off by default on every shell, labelled
   "Preview", with the sentence that the protocol has not been independently
   reviewed. Turning it on by default is gated on that review.

## What a removed member keeps

Everything already downloaded, and every key up to their last epoch: any
ciphertext from those epochs that reaches them by another route opens. They
cannot read anything written after their removal, and the devices never let
an object from an old epoch replace a newer one. This is printed where a
member is removed, and in the protocol document.

## Consequences

- `subrosa-cloud`: migration `0013_spaces.sql` (`identity_keys`, `spaces`,
  `space_members`, `space_epoch_heads`, `space_wrapped_keys`,
  `space_invitations`, `space_departures`, `space_objects`), routes under
  `/api/v1/identity`, `/api/v1/spaces` and `/api/v1/space-invitations`, and a
  PostgreSQL suite. The service learns who shares a space with whom and the
  shape of the traffic, never the content (protocol section 10).
- The app: `src-tauri/src/account/spaces/`, migration `071_spaces.sql`, 24
  shared commands, a card in Settings › Account on both shells and "Share
  with other people" in a project's settings. Sharing a project copies its
  name, instructions, file texts and notes into the space; the local project
  stays as it was.
- The web client: `website/src/client/spaces/`, the same protocol in
  WebCrypto, reading, writing, joining, leaving and asking the assistant.
  Inviting, admitting and removing stay in the app.
- Shared vectors (`src-tauri/tests/fixtures/spaces-v1.json`) hold the Rust and
  browser implementations together.
- An invitation's secret stays on the device that made the link; the owner
  admits from that device.
- The owner is fixed for the life of a space, and the owner's identity is the
  root of its membership. Ownership transfer and owner key recovery are not
  part of version 1.

## Alternatives considered

- **Share the vault key, or derive space keys from it.** Rejected: it would
  give every member everything, or tie every space to one account's root that
  ADR-0050 says is never rotated.
- **One key for the life of a space, membership enforced by the service.**
  Rejected: a removed member would read everything written afterwards the
  moment any ciphertext reached them, which is the exact limit ADR-0050
  records for the vault.
- **MLS (RFC 9420).** The standard for this problem, with forward secrecy and
  post-compromise security. Rejected for version 1: no implementation that
  runs identically in the Rust app and in WebCrypto without a large new
  dependency on each side, and its group sizes and update cadence exceed what
  a shared project needs. A version 2 can move to it; the epoch and head
  structure here does not prevent that.
- **libsodium sealed boxes.** XSalsa20-Poly1305 with a BLAKE2b nonce is not in
  WebCrypto. HPKE is an RFC built from primitives both sides already have.
- **The service runs the assistant for the group.** Rejected: it would see
  prompts and hold spending authority (ADR-0049, ADR-0069).
- **Trust on first use without safety numbers.** Kept as the default
  behaviour (a person may admit without comparing), but the numbers are always
  shown where trust is decided, and the link itself carries the inviter's keys
  outside the service.

## Addendum 2026-10-08: the owner's side runs in a tab too

The decision's last bullet of Consequences said inviting, admitting and
removing stay in the app. The web client now does all three, with the same
protocol and nothing new on the service
(`website/src/client/spaces/membership.ts`):

- **An invitation's secret stays where the link was made.** A link made in a
  tab keeps its secret in that browser's feature store, sealed under the vault
  key, and the acceptance it brings back is checked there, before the safety
  number is shown and the person admits. A link made in the app is admitted
  from the app, and the tab says so rather than admitting what it cannot
  check, as the app already did for a link made on another device.
- **Every membership change is one composition.** `client::compose_rotation`
  (Rust) and `composeRotation` (TypeScript) build the head, the key sealed to
  every member and, for a newcomer, the earlier keys; each applies the head
  rules to its own head before sending it. The shared vectors now include an
  admission, a removal and a member's rotation after a signed departure, with
  fixed ephemerals, so the two must produce the same request.
- **A tab rotates out a member who left** when it opens the space, under the
  same rule as the app: the owner rotates anyone out, any other member only
  those who signed themselves out.
- The Preview switch is unchanged: off by default in each browser, labelled
  "Preview", with the sentence that the protocol has not been independently
  reviewed. Creating a space still starts from a project in the app.


## Addendum 2026-10-08: a tab creates a space too

The last sentence above no longer holds. Behind the same Preview switch, the
web client shares one of the account's projects as a new space
(`createSpace` in `website/src/client/spaces/membership.ts`), as
`spaces_create` does in the app: the first head signed by its owner alone,
the first key sealed to that owner, then the project's name, instructions
and the text of its ready files, each written under epoch 1. The project
itself is untouched. `client::compose_creation` (Rust) and `composeCreation`
(TypeScript) build the request, and the shared vectors
(`operations.creation` in `spaces-v1.json`) hold them to the same bytes; the
created head is the chain's epoch 1. A tab carries no display name and no
notes into the space, since it holds neither for a project.


## Addendum (2026-10-10): only verified heads are used

A post-release audit found that a device checked only the heads newer than
the one it trusted, yet used every head the service returned, older ones
included, to check a key's commitment, to decide membership and to find the
key an author signs with. A dishonest service could therefore return a forged
epoch 1 naming a real member with a key it controls, seal a key to the reader
under that head, and have objects signed in that member's name accepted: the
"write in a member's name" line of the protocol's threat model did not hold.
Both implementations had the flaw, behind the Preview switch.

- **The invariant.** A head is used only if it is the trusted head, verified
  forward after it, or linked backwards from it
  (`hash(head_e) == head_{e+1}.prev`, down to the oldest returned). The chain
  check returns that set (`protocol::verify_chain` returns
  `VerifiedChain { latest, heads }`, `verifyChain` returns
  `{ latest, heads }`), and keys, membership and authors read only from it.
  The app completes it with the heads it kept in `space_heads`, each
  verified when written; where both hold a head for one epoch, the hashes
  must match. Backward linking matches history instead of re-judging it:
  every trusted head descends from a chain verified forward from epoch 1, so
  a head with the hash it names is that head.
- **A behavioural change.** A service that returns an older head below a
  missing epoch (heads 1, 3 and 4 to a device trusting 3), or one that does
  not link, is now refused with `space_rollback`, where it used to be
  accepted. Omitting old heads altogether is still accepted; a key for an
  omitted epoch then has no head and is refused in a tab, while the app uses
  the head it kept. The service in this repository always returns the whole
  chain, so no honest deployment is affected.
- **Shared vectors.** `chain_cases` in `spaces-v1.json` hold five answers to a
  device trusting epoch 3 (genuine, forged epoch 1, epoch 1 omitted, epoch 2
  mutated, epoch 1 below a gap), replayed by both implementations, beside a
  client-level test on each side where the service returns the forged head
  with a matching wrapped key and object: nothing is accepted and nothing is
  kept.
- **The Preview switch is the client's.** The browser's spaces client now
  holds the switch itself (`behindPreview` in
  `website/src/client/spaces/client.ts`): with it off, no call reaches the
  service, whichever component asks, as the app's commands refuse through
  `enabled_pool`. The panel only turns it on.
