# ADR-0108: A later deletion wins, and what it took can be restored

Date: 2026-10-11. Status: accepted. Supersedes the "divergent deletion"
rule of [ADR-0072](0072-a-clean-remote-deletion-is-applied-not-reviewed.md)
(the clean-deletion rule stands) and builds on
[ADR-0049](0049-accounts-synchronise-ciphertext-without-hosting-inference.md).

## Context

Reported on 2026-10-11: things deleted on one device did not disappear on the
other, and the synchronisation "took time". The deletion half has four causes,
each visible in `src-tauri/src/account/sync.rs` as it stood:

1. **A pass sent before it received.** A phone that had been suspended came
   back, the person deleted a note, and the tombstone left with the parent
   the phone remembered, not the revision the Mac had pushed meanwhile. The
   service kept both as heads. Under ADR-0072 the Mac then saw a tombstone
   whose parent was not its head, wrote a card, and kept the note; the phone
   saw the Mac's edit over its own tombstone and wrote a card too. Nothing was
   deleted anywhere.
2. **A row set aside by an issue counted as "unsent work"**, so a deletion
   of an object with one oversized snapshot parked months ago always became a
   card.
3. **A revision this build could not read stopped the stream.** An unknown
   table or column, written by a newer build on the other device, failed the
   page without advancing the cursor. That device received nothing after that
   sequence, deletions included, until it was updated.
4. **A desktop chat deleted elsewhere came back from the runtime's copy.**
   `mirror_history` recreated the `agent_tasks` row from Hermes on the next
   read, queued it as a child of the tombstone, and every device applied the
   resurrection.

The person's expectation is simple: deleted is deleted, everywhere, and a
mistake can be undone.

## Decision

1. **Receive before sending.** `synchronize` pulls first. While it pulls, a
   live revision of an object whose outbox holds an **unsealed** tombstone is
   *absorbed*: the head moves to it, nothing is written (the row is gone
   here), no card, and the object's open cards are marked resolved. A
   tombstone that arrives while an unsealed local tombstone waits replaces
   it. The tombstone is then sealed against the head the service holds.
2. **A tombstone seals what it knows.** At seal time its `resolved_revisions`
   are every unresolved sibling this device has a card for (at most 64), and
   those cards are resolved in the same transaction. One deletion retires
   every head this device knows of, inherited siblings included.
3. **A later deletion wins.** A tombstone applies when nothing of the object
   or its children waits to leave this device (rows parked by an issue do not
   count), no child has a head later than the tombstone, and the tombstone
   is at least as recent as the local head: it is the head, or its parent is
   the head, or it acknowledged the head, or it was minted after it. The
   service mints time-ordered revision identifiers, so the last test is one
   string comparison. When a deletion applies, the object's parked outbox
   rows go with it (retried later, they would come back as children of the
   tombstone), and the inbox rows of its children still waiting are history.
   `settle_clean_deletions` applies the same rule to cards written under the
   old one, and moves the head to the tombstone when it does. A card remains
   for unsent local work, or for an edit minted after the deletion.
4. **What a deletion took can be restored.** The journal this device keeps
   holds the last live revision before a tombstone. Notes and memories
   deleted in the last thirty days are listed from it (the deletion time is
   read from the tombstone's identifier) and "Restore" writes that revision
   back as a live child of the tombstone, which every device applies because
   the tombstone is its head. Text comes back; recordings, transcripts and
   files do not, as a local delete has never kept them. No synchronised table
   changes for this.
5. **An unreadable revision parks; the stream goes on.** Each inbound
   revision is admitted under a savepoint. One this build cannot read
   (`sync_format_invalid`) is rolled back to the savepoint, kept in the inbox
   unapplied and recorded as an issue in lane `inbox`, in the page's own
   transaction; the cursor advances. A revision whose parent is still
   waiting, parked or not, waits behind it instead of becoming a card.
   "Retry blocked items" after an update re-admits them in sequence order.
   An authentication failure still stops the page: that is the service, or
   the key, being wrong, not the build being old.
6. **A deleted chat stays deleted.** The Hermes mirror refuses to recreate a
   task whose head is a tombstone; applying such a deletion queues the
   runtime session id for the file lane, which asks the desktop workspace to
   forget the session.

## Trust boundary

The service already decides which revisions a device sees and in which
order; the client authenticates the content and the parent of each one but
not the identifier the service minted. Decision 3 relies on that identifier's
order once more. What a dishonest service gains from it is bounded: it cannot
forge a deletion or an edit (both need the vault key), it can only present a
person's own deletion as later than that person's own edit, and the edit is
then listed under "Recently deleted" and restorable on every device. That is
the same bound ADR-0049 accepts for every other reordering, and it is why
decision 4 is not optional.

## Consequences

- A note deleted on a phone that was away is deleted on the Mac, without a
  card, and the person can get its text back from either device.
- Two devices deleting the same thing leave one tombstone on the service.
- A build that lags its sibling keeps receiving everything it can read, and
  the account panel says how many items wait for the update.
- A review card now means one thing: this device holds work the other one
  never saw, or edited after the deletion. Both are questions for a person.
- The savepoint is the invariant that lets a page continue: without it, a
  failed apply could leave `applying=1` behind and every trigger in the
  library silent.

## Alternatives rejected

- **Keep asking (ADR-0072 as it was).** Correct for a concurrent edit, wrong
  for the common case, which is a device that was simply away. The person
  reported the cards as the bug.
- **A trash column on every synchronised table.** Rejected by ADR-0072 for
  its width; the journal already holds what a trash would, so the list is
  derived rather than stored.
- **Authenticated timestamps in every body**, to compare deletion and edit by
  clocks the service cannot touch. It needs every client to write them before
  any can rely on them, and compares clocks of different devices; the bound
  above is accepted instead.
- **Freezing a lagging device**, as the assistant codec note in the contract
  intended, so an old build never half-applies a newer object. Parking one
  revision gives the same protection for that object and keeps every other
  object moving.
