# Spaces protocol, version 1

Shared projects and group chats between Sub Rosa accounts, end-to-end
encrypted. Decision record: [ADR-0098](../adr/0098-a-shared-project-is-a-space-whose-key-changes-with-its-members.md).
Implementations: Rust in [`src-tauri/src/account/spaces/`](../../src-tauri/src/account/spaces/)
(`protocol.rs`, `hpke.rs`), TypeScript in
[`website/src/client/spaces/protocol.ts`](../../website/src/client/spaces/protocol.ts).
Service: [`subrosa-cloud`](../../subrosa-cloud/) migration `0013_spaces.sql`,
routes in `crates/api/src/spaces.rs`. Shared vectors:
[`src-tauri/tests/fixtures/spaces-v1.json`](../../src-tauri/tests/fixtures/spaces-v1.json).

**Status: preview.** This protocol has not been reviewed by anyone independent
of its authors. It ships behind a "Preview" switch, off by default, on every
shell. An independent review is an external gate before it is enabled by
default; the list of what that review must check is at the end of this
document. Nothing here should be read as a claim stronger than the tests in
the repository support.

## 1. What it is for

A **space** is a project several accounts share: its name and instructions,
notes, the text of files, and **group chats** in which every member's messages
and the assistant's replies reach every member. When a member asks the
assistant, that member's own device runs the turn through that member's own
Carpe Diem key; the reply is signed by that member and names them as the one
who paid.

The account service ([ADR-0049](../adr/0049-accounts-synchronise-ciphertext-without-hosting-inference.md))
carries a space and decides who may fetch it. It never holds a key that opens
it, and nothing a member's device accepts depends on trusting it.

## 2. Notation and encodings

- `b64(x)`: base64url without padding. Keys are 32 bytes (43 characters),
  signatures 64 bytes (86 characters).
- `T(label, f1, f2, ...)`: a **transcript**: for the label and then each field,
  a 4-byte big-endian length followed by the field's UTF-8 bytes. Every
  signature and hash below is over a transcript, never over JSON, so no
  canonical JSON is needed and no two purposes share an input. Numbers enter a
  transcript as decimal strings; keys as their `b64` strings.
- `HMAC(k, m)`: HMAC-SHA256. `HKDF(ikm, info)`: HKDF-SHA256 (RFC 5869) with an
  empty salt and 32 bytes of output.
- `AEAD(k, aad, m)`: AES-256-GCM, a fresh random 96-bit nonce, a 128-bit tag,
  in the account **envelope** `{"v":1,"nonce":b64,"ciphertext":b64}` of the
  [accounts contract](../accounts-sync-contract.md). `aad` is a UTF-8 string.
- `Sign(sk, m)` / `Verify(pk, m, s)`: Ed25519 (RFC 8032). Rust verifies with
  `verify_strict`.
- UUIDs are lowercase and hyphenated; anything else is refused.

## 3. Identity

Each **account** (not each device) has an identity:

- an X25519 key pair for receiving space keys;
- an Ed25519 key pair for signing.

The private halves are two random 32-byte seeds. They are sealed under the
account's vault key, `AEAD(vault_key, "subrosa:identity:v1:{account}",
{"v":1,"x25519_secret":b64,"ed25519_seed":b64})`, and stored on the service
next to the public half (`PUT /api/v1/identity`, compare-and-swap like the
vault). Any device that holds the vault key (every admitted device and an
unlocked browser device, [ADR-0050](../adr/0050-vault-admission-uses-an-out-of-band-secret.md),
[ADR-0096](../adr/0096-a-browser-is-a-device.md)) can open them; the service
cannot. A device keeps a copy in its keyring after first use.

The public half is a self-signed **bundle**:

```
{ v: 1, account_id, x25519: b64, ed25519: b64, created_at,
  signature: Sign(ed25519_sk, T("subrosa:identity:v1", account_id, x25519, ed25519, created_at)) }
```

The self-signature only proves that whoever holds the Ed25519 key endorses the
X25519 key. It does not prove who that is: that is what safety numbers and the
invitation link are for (sections 7 and 8). The service refuses to replace an
identity while the account belongs to any space, so keys cannot change under a
space without its members noticing a broken head.

Two devices creating an identity at once meet at the service's
compare-and-swap; the loser reads and uses the winner's.

## 4. Spaces, epochs and heads

A space has an id (a random UUID v4), an **owner** (the account that created
it, fixed for the life of the space), and a sequence of **epochs** starting at
1. Each epoch has:

- a fresh random 32-byte **space key** `K_e`, never derived from another;
- a signed **head** naming the members of that epoch.

```
head_e = { v: 1, space_id, epoch: e, prev, owner, members, key_commitment,
           author, departures, created_at, signature }
members     = [{ account_id, role: "owner"|"member", x25519, ed25519 }]  sorted by account_id
departures  = [{ account_id, signature }]                                 sorted by account_id
key_commitment = b64(HMAC(K_e, "subrosa:space-key-commit:v1:{space_id}:{e}"))
prev        = "" for e = 1, else hash(head_{e-1})
signature   = Sign(author.ed25519_sk, T_head)
T_head      = T("subrosa:space-head:v1", space_id, e, prev, owner, |members|,
                for each member: account_id, role, x25519, ed25519,
                key_commitment, author, |departures|,
                for each departure: account_id, signature,
                created_at)
hash(head)  = b64(SHA-256(T_head || lp(signature)))
```

`lp(signature)` is the signature as one more transcript field, so two
signatures over one transcript give two different hashes.

**Every membership change is a new epoch**: admitting someone, removing
someone, a member leaving, an account that disappeared. A new epoch always has
a new key.

### 4.1 Head validity

A device accepts `head_e` after `head_{e-1}` (or as the first head) only if
all of these hold:

1. Shape: `v = 1`; UUIDs well formed; 1 to 50 members, sorted, distinct;
   exactly one member has role `owner` and it is `owner`; keys are 32 bytes;
   the commitment is 32 bytes.
2. First epoch: `e = 1`, `prev = ""`, `author = owner`, no departures, signed by
   the owner's key as listed in the head itself.
3. Later epochs: same `space_id`, `e = e_prev + 1`, `prev = hash(head_{e-1})`,
   same `owner`; the author is a member of `head_{e-1}` and the signature
   verifies under the Ed25519 key `head_{e-1}` lists for them.
4. Each departure names a member of `head_{e-1}` other than the owner who is
   not in `head_e`, and carries their signature
   `Sign(T("subrosa:space-leave:v1", space_id, e-1, account_id))` under the key
   `head_{e-1}` lists for them.
5. If the author is the owner, anything else is allowed (the owner admits,
   removes, and may re-key a member). If the author is anyone else, the
   departures must be non-empty, must not include the author, and the member
   list must be exactly `head_{e-1}`'s minus the departed, entry for entry.

### 4.2 Verifying a chain, and rollback

A device keeps the last head it verified for each space. When the service
answers with a list of heads:

- with a trusted head `H` already kept: the latest returned epoch must be at
  least `H.epoch`, any returned head at `H.epoch` must hash to `hash(H)`, and
  every later head must verify after the previous one starting from `H`.
  Anything else is a **rollback** (or a fork) and is refused with
  `space_rollback`: nothing is changed and the error is shown;
- with nothing trusted yet: the chain must start at epoch 1, verify throughout,
  and the owner entry of `head_1` must equal the **anchor**: this account's own
  bundle for a space it created, the inviter's bundle carried in the link for
  a space it joined (section 7).

The service also refuses an epoch that is not `current + 1`, so two devices
racing to rotate meet at a conflict, and the loser reads the winner's epoch.

## 5. Wrapping a space key

`K_e` reaches each member of epoch `e` as an HPKE single-shot seal (RFC 9180,
base mode, suite DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM, ids
`0x0020, 0x0001, 0x0002`) to that member's X25519 key:

```
info   = "subrosa:space-key:v1:{space_id}:{epoch}:{account_id}"
aad    = ""
sealed = {"v":1,"enc":b64(enc),"ct":b64(ct)}
```

A sealed box says nothing about who sealed it: the service could seal a key of
its own choosing to any public key. So after opening, a member checks
`HMAC(K, "subrosa:space-key-commit:v1:{space_id}:{epoch}") = head_e.key_commitment`
and refuses the key otherwise. The commitment is inside a head signed by an
authorised member, which is what binds the key.

**History.** When the owner admits a newcomer, it also seals every earlier
epoch key it holds to the newcomer (with each earlier epoch's `info`), so a
project's history is readable to whoever joins. The service accepts earlier
keys only for accounts the epoch adds. The commitment check applies to each.

## 6. Objects

Everything in a space is an object: `project` (name and instructions; its id
is the space id), `note`, `file` (name, format and extracted text), 
`conversation`, `message`, `profile` (a member's display name; its id is the
UUID v5 of the account id in the space id's namespace). Any other kind is
refused by both the devices and the service.

A write is a **revision**: a random UUID chosen by the writer before the first
send and kept through retries.

```
body = { v: 1, kind, object_id, revision, parent_revision, author, created_at, deleted, data }
aad  = "subrosa:space-object:v1:{space_id}:{epoch}:{kind}:{object_id}:{revision}:{author}"
ciphertext = AEAD(K_epoch, aad, JSON(body))
signature  = Sign(author.ed25519_sk,
                  T("subrosa:space-object-signature:v1", aad, b64(SHA-256(ciphertext))))
```

A reader opens an object only if:

1. its epoch's head and key are held, and the author is a member of **that**
   epoch's head (someone who was not a member then cannot have written then);
2. the signature verifies under the key that head lists for the author (any
   member holds `K_e`, so without this any member could write in another's
   name);
3. it decrypts under `K_epoch` with exactly this `aad`;
4. every field of the decrypted body equals what the service said (kind, id,
   revision, parent, author, deleted);
5. the data has the kind's shape and size bounds, and for an assistant
   `message`, `paid_by` equals the author: the member whose device ran the
   reply is the one who signed it, and the one the group sees as having paid.

The service accepts a write only under the **current** epoch and only from a
current member, and assigns a per-space sequence. A device keeps the latest
revision of each object by sequence, and never lets a revision under an older
epoch replace one under a newer epoch.

Size bounds: one object at most 1 MiB of ciphertext, a batch at most 100
objects and 4 MiB, a space at most 256 MiB, project instructions 8 000
characters, a note 200 000, a file's text 400 000, a message 100 000.

## 7. Invitations

Only the owner invites. An invitation is a 32-byte random **link secret** `s`
and a random UUID `i`. The link carries both in its fragment, which a browser
never sends:

```
{site}/app#join=srspace1.{i}.{b64(s)}
token       = HKDF(s, "subrosa:invite-token:v1:{i}")
token_hash  = b64(SHA-256(token))                         stored by the service
payload_key = HKDF(s, "subrosa:invite-payload:v1:{i}")
payload     = AEAD(payload_key, "subrosa:invite:v1:{i}",
                   { v: 1, space_id, space_name, inviter: bundle, expires_at })
```

The payload carries the **inviter's bundle**. Because it travels inside the
link, outside the service, it is what the invitee anchors the space's chain to
(section 4.2): a service that substitutes keys has to have the link too.

**Accepting.** The invitee shows the token to read the payload
(`POST /api/v1/space-invitations/{i}/open`), checks it, sees a safety number
(section 8), and accepts with its own bundle and a proof that it holds the link:

```
proof = b64(HMAC(HKDF(s, "subrosa:invite-accept:v1:{i}"),
                 T("subrosa:space-accept:v1", i, space_id, account_id, x25519, ed25519)))
```

The service checks the token, that the bundle is the account's published one,
that the invitation is neither expired, revoked, claimed nor admitted, and
records one claim. It cannot check the proof, and it cannot forge one.

**Admitting.** The owner's device (the one that made the link and kept `s`)
recomputes the proof. A proof that does not hold, or an invitation made on
another device, is shown as "cannot be verified" and cannot be admitted. A
valid one shows the safety number between the owner and the invitee, then a
new epoch adds the invitee; the service marks the invitation admitted in the
same transaction and refuses to admit it twice.

Invitations last at most seven days; at most 20 are open per space. An
invitation's secret stays on the device that made it: it is not synchronised.

## 8. Safety numbers

For an identity:

```
d_0 = SHA-256(T("subrosa:safety:v1", account_id, ed25519, x25519))
d_{k+1} = SHA-256(d_k), k < 1024
digits(bundle) = six groups: for each 5-byte chunk c of d_1024[0..30], (big-endian c) mod 100000, zero-padded to 5 digits
```

The safety number of two identities is both 30-digit strings, the smaller
first: sixty digits, shown as twelve groups of five, the same on both devices.
Two people compare them out of band (in person, on a call). Matching numbers
mean the keys each device uses for the other are the keys the other holds.
The invitee sees the number before accepting; the owner sees it before
admitting; any member can open it for any other and mark it compared (a local
mark, not synchronised).

The 1024 iterations add cost to grinding a key whose 30 digits collide with a
target's; 30 decimal digits are about 99.7 bits.

## 9. Leaving and removal

**Removal.** The owner makes a new epoch without the member. The service
deletes their membership and their sealed keys in the same transaction. From
that moment they cannot fetch anything, and every object written afterwards
is under a key never sealed to them.

**Leaving.** A member signs a leave statement for the current epoch
(section 4.1, rule 4) and sends it. The service removes their membership at
once and keeps the statement. The next pass of any remaining member's device
makes the rotation with the departure in the head; the service accepts that
rotation from a non-owner only when it removes exactly the members with a
pending statement and adds no one. Until a rotation happens, new objects are
still written under the epoch the leaver knew; the leaver can no longer fetch
them from the service.

The owner cannot leave; the owner deletes the space, which deletes it on the
service for everyone. An account deleted from the service drops out of every
space it was in; the owner's next pass rotates it out.

### What a removed member keeps

Said plainly, because no protocol can take it back:

- everything their devices already downloaded and decrypted;
- every space key up to the last epoch they belonged to, and therefore the
  ability to read any ciphertext from those epochs that reaches them by any
  other route (a leak of the service's database, a copy someone sends them);
- their own signing key, so with a dishonest service's help they could insert
  objects **attributed to themselves** under epochs they belonged to. Devices
  never let such an object replace a revision under a newer epoch, and the
  honest service refuses any write that is not under the current epoch.

They cannot read anything written after they were removed, and they cannot
write anything other members accept as written after it.

## 10. The service's role

It stores, per account, the published bundle and the sealed private keys; per
space, the owner, the current epoch, members and roles, every head, every
sealed key, invitations (token hash, sealed payload, claim, acceptance),
pending departures, and objects (ids, kind, epoch, author, ciphertext,
signature, sequence). It authorizes by membership, keeps its rows consistent
with the heads it is given (members, roles, published keys, one current key
per member), and answers `404` to anyone who is not a member, so the existence
of a space leaks nothing to strangers.

It learns: who shares a space with whom, roles, when membership changes, the
number, kinds, sizes and timing of objects, who wrote each one, and who
claimed which invitation. It does not learn: names, instructions, notes, file
contents, messages, display names, or any key that opens them.

## 11. Threat model

Assets: the content of a space; who said what in it (attribution); who pays for
an assistant reply; the membership as the members believe it to be.

| Adversary | Can | Cannot |
| --- | --- | --- |
| Honest but curious service | read metadata (section 10) | read content, names, keys |
| Malicious service | withhold objects or heads; replay an older state to a device that has never seen the space; refuse writes; delay delivery; serve a different but valid-looking set of objects to different members; drop a member's departure | substitute a member's keys undetected after the first verified head (heads are signed); give a member a key that passes the commitment check; show a device an epoch older than one it verified (rollback is detected); admit an invitee without the link (no proof); write in a member's name (no signature) |
| Network attacker | see TLS metadata | anything the service cannot |
| A member | read everything in the space while a member, including history; write as themselves; ask the assistant at their own expense | write as someone else; add or remove anyone unless they are the owner; remove anyone but members who signed themselves out |
| A removed member | see section 9 | read objects written after the removal |
| A removed member colluding with the service | read old-epoch ciphertext; insert old-epoch objects attributed to themselves | read new-epoch content; make old-epoch objects replace newer ones on a device |
| Someone who obtains an invitation link before it is used | claim it once, as their own account | be admitted without the owner seeing their safety number; use it after it was claimed, revoked, admitted or expired |
| A compromised web deployment | everything an unlocked tab can do: read the vault key, the identity keys, every space it opens ([ADR-0050](../adr/0050-vault-admission-uses-an-out-of-band-secret.md), [ADR-0096](../adr/0096-a-browser-is-a-device.md)) | anything on devices that do not use the website |
| Code running as the person on their device | everything (out of scope, [threat model](../threat-model.md)) | |

Explicitly **not** provided in version 1:

- **Forward secrecy within an epoch, and post-compromise security.** One key
  per epoch; a key that leaks opens its whole epoch. Keys change only when
  membership changes.
- **A globally consistent view.** The service can show different members
  different subsets of objects (it cannot forge or alter them). There is no
  transparency log and no cross-member consistency check.
- **Freshness for a first read.** A device that has never seen a space trusts
  the longest chain the service shows from the anchor; it can be shown an older
  one at first sight (not afterwards).
- **Owner key compromise recovery.** The owner is fixed. Whoever holds the
  owner's identity keys controls membership. There is no transfer of ownership.
- **Deniability.** Messages are signed.
- **Metadata protection** beyond what section 10 says.
- **Erasure.** Nothing removes a copy a member already has.

## 12. Test vectors and tests

`src-tauri/tests/fixtures/spaces-v1.json` is generated by
`src-tauri/src/account/spaces/protocol_tests.rs` from fixed seeds, ephemeral
keys and nonces (`SPACES_VECTORS_WRITE=1` regenerates it after a deliberate
change). It contains HKDF, HPKE (with a fixed ephemeral), three identities
with their bundles and fingerprints, a sealed identity, a safety number, a
four-epoch chain (create, admit, admit, a member leaves and another rotates)
with its hashes, a leave statement, a wrapped key, every object kind sealed
and signed, an invitation (code, token, token hash, sealed payload, acceptance
proof) and a profile id. Its `operations` section holds the membership
changes as the app composes them (`client::compose_rotation`, with fixed keys,
times and HPKE ephemerals): an invitation's request to the service, Carol's
acceptance, the owner admitting her (her earlier keys sealed to her), the
owner removing Bob (no key for him), and Carol rotating Bob out after he
signed a leave statement. The browser implementation reproduces every value
byte for byte (`src/test/website-spaces-protocol.test.ts`,
`src/test/website-spaces-membership.test.ts`), and the Rust HPKE
seal is opened by an independent RFC 9180 implementation (the `hpke` crate) in
`hpke.rs`'s tests.

Behaviour tests:

- Rust protocol (`protocol_tests.rs`): chains, forks and rollbacks, a member
  adding someone, a forged or replayed departure, a tampered head, a
  substituted wrapped key, a removed member against later objects, objects
  moved or re-attributed, the payer rule, acceptance replay and substitution,
  damaged invitation codes, the sealed payload, identity sealing, safety
  numbers.
- Rust store (`store_tests.rs`): ordering, the epoch rule, the outbox.
- Service (`subrosa-cloud/crates/api/tests/support/spaces.rs`, real
  PostgreSQL): membership authorization, epochs one at a time, writes only
  under the current epoch, idempotent retries, single-use invitations, leaving
  and non-owner rotation, identity immutability while in a space, deletion.
- Browser (`src/test/website-spaces-client.test.ts`): a whole share, invite,
  admit, write, ask and read cycle, rollback detection, removal, invitation
  replay, against an in-memory service; and the owner's side from a tab
  (2026-10-08): a link made and admitted from the tab after the safety number,
  an acceptance the tab cannot check refused, a link withdrawn, a removal, and
  a member rotating out someone who left.

## 13. For the independent review

The review is an external gate. Before shared projects are enabled by
default, someone outside the project should check at least:

1. **The construction as a whole**: that the composition of identity
   bundles, signed heads, HPKE wraps, key commitments, signed objects and
   HMAC-proved invitations gives the guarantees of section 11 and no weaker
   ones, and that the "not provided" list is complete.
2. **HPKE**: the hand-written RFC 9180 derivation in `hpke.rs` and
   `protocol.ts` (labels, suite ids, key schedule, nonce use for a single
   seal), the empty `aad`, the low-order point check, and the WebCrypto X25519
   behaviour on a low-order input in every browser engine.
3. **Key commitment**: that HMAC under the space key is a sufficient
   commitment against a service choosing keys (including AES-GCM's
   non-committing nature for objects: a key that passes the commitment is the
   only key that can open, but an object ciphertext is not itself committing).
4. **Transcripts**: unambiguity of the length-prefixed encoding, the domain
   separation of every label, and that no field an attacker controls is
   missing from a signed transcript (in particular `created_at`, roles and
   departures in heads).
5. **Head validity rules**: the non-owner rotation rule, owner re-keying a
   member, the fixed owner, and any way to add or remove a member that the
   rules let through.
6. **Rollback and freshness**: the first-read gap, the per-device trusted
   head, forks across a member's own devices (each device verifies
   independently), and whether a signed, monotonic head is enough without a
   transparency log.
7. **Objects**: the epoch rule for replacement, the "author is a member of
   the object's epoch" rule, what a removed member colluding with the service
   can still do, and whether objects should carry the head hash rather than
   only the epoch number.
8. **Invitations**: link secret entropy and lifetime, the token and proof
   derivations, replay across invitations and spaces, and the owner-device
   binding of the secret.
9. **Safety numbers**: the fingerprint construction, the iteration count, the
   digit extraction bias (40-bit values modulo 100 000), and the user flow
   that relies on them.
10. **Ed25519 verification differences** between `ed25519-dalek`
    `verify_strict` and WebCrypto (malleability, small-order keys).
11. **Identity storage**: sealing under the vault key, the keyring copy, the
    compare-and-swap creation race, and the refusal to replace an identity
    while in a space.
12. **The service's authorization and consistency rules** in
    `subrosa-cloud/crates/persistence/src/spaces.rs`, including concurrency
    (row locks, sequences) and what it reveals through status codes.
13. **The implementations**: constant-time comparisons, zeroization of keys,
    error paths that could leak an oracle, and the shared vectors' coverage.

Until that review, the switch says "Preview", the settings card says the
protocol has not been independently reviewed, and nothing suggests relying on
it for anything sensitive.
