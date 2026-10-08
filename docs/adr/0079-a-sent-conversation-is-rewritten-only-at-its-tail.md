---
status: accepted
date: 2026-10-07
---

# A sent conversation is rewritten only at its tail

## Context

The phone chat (agent-lite) gained the everyday controls of the chat apps
people know: stop a reply, ask for it again, edit a question, branch from a
reply (P1-WP1 of the parity plan, ADR-0078). Each of them changes a
conversation that already exists, and three facts constrain how:

- The transcript is durable rows in `agent_messages`, read by the resume
  sweep (ADR-0018) and synchronised as encrypted revisions to the user's
  other devices (ADR-0049), where a deleted row travels as a tombstone.
- A reply the resume sweep finds unanswered is re-run, which is paid work.
- The vendor's design keeps every version of an edited question inside one
  thread, with arrows to move between versions. That needs a tree of messages
  (a parent per message, a selected child) that neither the schema, the
  sync wire format nor the desktop's Hermes transcripts have.

## Decision

1. **Only the tail is rewritten in place.** Regenerate deletes the replies
   after the last question; editing the last question updates that row and
   deletes what followed. Both happen in one transaction that leaves the task
   `queued`, under the turn's claim, which the command hands to the run, so
   the resume sweep can never answer the rewound question a second time.
2. **Anything earlier is branched, never rewritten.** Editing an earlier
   question creates a new chat holding everything before it and ending on the
   edited question, committed `queued` in the same transaction and answered in
   the background. "Branch from here" copies the thread up to and including a
   reply. The original conversation is left exactly as it was.
3. **A stopped reply keeps what it showed and is never resumed.** The partial
   text becomes the assistant message and the task becomes `cancelled` in one
   transaction; `cancelled` is outside what the resume sweep selects, so a
   stopped reply is neither re-run nor billed again. Whether a turn is live is
   answered by an in-process stop signal registered with its claim, never by
   the database.
4. **Deletions and edits travel as ordinary row changes.** No new sync kind:
   the existing outbox triggers turn the deletions into tombstones and the
   edit into a new snapshot, and a receiving device removes a tombstoned
   message without a review card when it holds no newer change to it.

## Consequences

- Nothing a user has read disappears except the replies they asked to replace
  and the tail of the question they rewrote, which is what they asked for.
- An edited earlier question shows up as a second chat in the history rather
  than as a version arrow. That is the visible cost of not adding a message
  tree, and it is the same branch the model picker's fork already makes.
- Adding version arrows later means a schema and wire-format change (a parent
  id per message) and a supersession of point 2, not an extension of it.

## Alternatives considered

- **A version tree inside one thread** (the vendor's design): rejected for
  now, for the schema and sync change above and because the desktop's
  transcripts live in Hermes, which has no such tree to mirror.
- **Rewriting an earlier question in place and deleting everything after
  it**: rejected. It silently destroys answers the user read, on every device
  the conversation is synchronised to.
- **Discarding a stopped reply's text**: rejected. The user saw it; losing it
  makes Stop feel like an error, and the tokens were already paid for.
