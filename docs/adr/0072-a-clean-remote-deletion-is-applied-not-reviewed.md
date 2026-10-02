---
status: accepted
date: 2026-10-02
---

# A clean remote deletion is applied, not reviewed

## Context

Account synchronisation (ADR-0049) ships every local change as a revision of
an object, and a deletion as a tombstone revision. Until now the receiving
device treated every tombstone the same way: it wrote a review card ("deleted
on another device, version preserved"), moved its head to the tombstone, and
left the row alone. The comment at that spot gave the reason: deleting a note
cascades to its sessions, recordings and transcripts, and a cascade could erase
a child revised by a third device that the deleting device never saw.

Reported on 2026-10-02 with a screenshot: 79 such cards on one Mac, and the
sync panel saying the service was unavailable (that part is the file lane and a
storage allowance, settled separately). The cards came from three stacked
behaviours, each reasonable alone:

1. **Every tombstone was a card**, even when its parent was the local head and
   nothing waited in the outbox. That is not a disagreement: it is the other
   device saying what it did, after this one. A person asked to review it has
   one honest answer.
2. **Answering a card emitted a tombstone.** "Accept the deletion", and "keep
   this device's version" when the row no longer existed, both enqueued a
   fresh tombstone as a child of the one received. The service already held
   that deletion as the object's only head, so the new revision retired
   nothing there, and every other device received it as a new card to
   answer. The server showed the chain: 52 tombstones from one computer on
   2026-09-28, each the child of a tombstone from the phone, then 16 more
   from the phone, children of those.
3. **A reconnection replays the whole history.** A device signing in again
   starts at cursor zero. It applied the upsert of every object ever created,
   row and all, and then its tombstone, as a card. Everything the user had
   deleted on any device came back on the Mac as "deleted on another device".

The protection the card was meant to give (a child revised after the deletion)
was never checked; the card was written whether or not the danger existed.

## Decision

A remote deletion is **clean** when its parent revision is this device's head
for the object, nothing of the object or its children waits in the outbox, and
no child has a head revision later than the tombstone. A clean deletion is
applied locally the way this device's own delete would be, under `applying=1`
so nothing echoes back, and no card is written. Children are looked up by
their foreign key (`note_id` for a note's sessions, recordings and transcripts;
`task_id` for a conversation's messages); "later" compares the time-ordered
revision identifiers the service mints, so the check costs one indexed query
per child table and needs no clock of its own.

Any other deletion is **divergent** and stays a review card, exactly as before:
this device edited the object since, or holds an unsent change to it or to a
child, or a child was revised after the deletion was decided.

Answering a deletion card sends a revision only when it has something to
retire. If the tombstone is already the local head, accepting the deletion, or
keeping a local version that no longer exists, removes the row if it is still
there, marks the card settled, and writes nothing to the outbox. Keeping a
local version that does exist still sends it, as a child of the tombstone: that
is the one answer that changes what the service holds, and it is how a person
restores a note everywhere. If the local head is a live sibling, the previous
behaviour stands: the answer names the sibling it acknowledges.

Cards written before this rule, for deletions that would have applied
themselves, are settled on the next sync pass by the same test and the same
local delete, and send nothing. A card whose head is a live sibling is left
for the person.

A tombstone no longer waits for its parent row. A transcript's tombstone whose
note is already gone applies as "nothing to remove", instead of sitting in the
inbox for a dependency that will never arrive.

The apply path runs on a database connection and knows nothing of the app's
directories, so the files a deleted row pointed at are recorded in
`account_sync_removed_files` and removed by the file lane, which resolves the
recordings, gallery and references roots afresh on every pass (iOS moves its
container on reinstall).

## Consequences

- Deleting a note, a memory or a conversation on one device deletes it on the
  others, as the user expects, and a reconnection ends with the same set of
  rows it started from instead of a wall of cards.
- The one case the card was protecting, work on a child the deleting device
  never saw, is now actually detected, and only that case asks a person.
- The cascade risk moves from "always ask" to "ask when a child head sorts
  after the tombstone". A child revised on a third device *before* the
  deletion but synced *after* it is applied, so that revision is lost with
  the note: the deleting device had the same information this one has, and
  a note the user deleted is a note the user deleted. This is the same
  outcome a local delete has always had.
- Review cards for deletions become rare, so the French and English copy that
  names them stays, and the "keep this device's version for all" button keeps
  its meaning for divergent cards.
- Files a remote deletion orphans leave the disk within a sync pass. Before,
  nothing was deleted locally, so nothing was orphaned; the new table is the
  cost of applying deletions at all.

## Alternatives rejected

- **Keep writing a card for every tombstone, but stop the ping-pong.** Removes
  the chain but keeps the user reviewing their own deletions after every
  reconnection, and keeps resurrected rows on disk. The complaint was the
  cards, not only their number.
- **A trash for every synchronised table** (a `deleted_at` column, as folders
  have). Reversible, but it changes every synchronised row shape, every
  listing query, the memory prompt and the search index, for a product whose
  own delete has never had a trash. Too wide a change for the problem, and it
  would still need the clean/divergent test to decide what lands in the trash
  silently.
- **Let the service compact history for a reconnecting device** (serve only
  heads at cursor zero). Worth doing for speed, and left as a follow-up: it
  would have hidden the resurrection but not the ping-pong, and the client
  must stay correct for a service that does not compact.
- **Treat the time-ordered revision as a clock on every device.** It is only
  used to compare two revisions of the same account minted by the same
  service, where it is monotonic by construction. It is never compared with a
  device's own time.
