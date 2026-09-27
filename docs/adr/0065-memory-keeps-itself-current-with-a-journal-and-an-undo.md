---
status: accepted
date: 2026-09-27
---

# Memory keeps itself current, with a journal and an undo

## Context

Cross-conversation memory (ADR-0009) adds facts and never corrects them:

- An extraction pass runs every third assistant reply. A fact said on the first
  or second turn of a short chat is lost, and two passes in three are paid for
  nothing.
- A candidate is dropped only when a stored memory has the same text, letter
  for letter. "Habite à Lyon" is stored next to "Habite à Paris". The same
  preference said in other words is stored twice.
- The injected block is the twenty memories with the best "importance", the
  same twenty whatever the conversation is about. Past twenty facts, what a
  message is about can be exactly what was left out.

The person could fix all of this by hand, in Settings › Memory, fact by fact.
Nobody does. The owner chose that Sub Rosa should keep its memory current
without asking. Every change it makes on its own must be visible and
reversible.

Reflexes (ADR-0064) make the three decisions cheap. They were measured live on
French examples before this was written:

- **The gate.** Messages that told something lasting about the person scored
  0.86 to 0.92. Requests, questions and thanks scored 0.03 to 0.13.
- **Consolidation.** Five cases were asked in one call of 1.4 s:
  - a move from Paris to Lyon (answered "replacement", confidence 1);
  - a preference repeated in other words ("same", 0.99);
  - a new fact next to a related one ("new", 1);
  - a change of employer ("replacement", 1);
  - a cat next to a remembered dog ("new", 0.98).

  Each named the right stored fact, or none, with 0.85 to 1.

## Decision

**Memory keeps itself current. A reflex decides; the app acts on its own
above a high bar, and records every such act in a local journal with its
undo.**

- **The gate replaces the cadence.** After every turn, a reflex reads the
  person's latest message and says whether it tells something lasting about
  them. An extraction pass runs when it does (at 0.5 or more). With no reflex
  answer, the every-third-reply cadence decides, as before.
  - The desktop now calls `memory_extract` after every turn and sends `turns`.
    Rust decides.
  - A caller that sends no turn count gets an unconditional pass.
- **Consolidation at write.** Each surviving candidate is shown next to its
  closest stored facts (by meaning, and by any shared word). One call asks two
  `choice` questions per candidate:
  1. Is it `new`, the `same`, or a `replacement`?
  2. Which stored fact does it concern? The fact's own words are the label,
     since the model follows an option's name.

  When both answers reach `ACT_AT` (0.8):
  - a **replacement** rewrites the stored memory in place;
  - a **repeat** is not stored.

  Anything less sure is added, as before, because a duplicate costs less than a
  lost fact. A stored memory is touched once per pass at most.
- **In place, never a new column.** `memories` is synchronised with a closed
  column list, and older versions reject a revision with an unknown column. So
  the changes use what exists:
  - a replacement rewrites `text`;
  - a later forgetting would set `disabled`.

  Both travel as ordinary revisions through the existing triggers.
- **The journal is local.** `autonomous_changes` (migration 035) keeps the
  kind, the memory, the state before and after, the probability, and when it
  was undone. It is never synchronised: it is the record of why on this
  device, not data.
  - Settings › Memory lists it on both shells ("Changed by Sub Rosa") with an
    Undo per change.
  - **An undo is a compare-and-set.** It restores the state before only while
    the memory still holds the state after. A memory edited since is left as it
    is, and the undo says so.
  - Undoing a repeat stores the candidate after all.
- **The turn's memories on the phone.** agent-lite's system prompt is rebuilt
  every turn. While everything remembered fits the static block of twenty,
  that block is sent and nothing is fetched. Past it, the block is:
  - the eight most important memories;
  - plus up to twelve that recall finds for the latest message and the
    relevance screen keeps.

  The recall has a 2.5 s budget, and falls back to the static block. The
  desktop keeps the block written at Hermes spawn. Its recall on demand
  already goes through the screened search (ADR-0064 addendum).
- **Never a deletion.** Nothing here deletes a memory. Deleting stays the
  person's explicit "forget" (ADR-0009).

## Consequences

- A move, a new job or a changed preference replaces the old fact instead of
  sitting next to it. Repeats stop piling up. A fact said on any turn is seen.
- Memory changes without a tap. The journal and the undo are what make that
  acceptable, and they are on the screen where people already look at their
  memory.
- The thresholds (0.5 for the gate, 0.8 to act) come from one measurement.
  Undo rates per kind are the first signal a calibration can use. A kind whose
  undos climb should raise its own bar.

## Alternatives considered

- **Propose the change and wait for a tap.** The owner asked for autonomy, and
  a queue of memory proposals nobody reviews is the state before, with extra
  steps.
- **A `superseded_by` column, keeping both facts.** It is cleaner history, but
  it breaks the synchronisation contract for every older install. The journal
  keeps the history locally without touching the synchronised shape.
- **Let the extraction model consolidate** (it already sees fifty stored
  memories). It rewrites rather than decides, it is paid on every pass, and its
  "don't repeat" instruction is exactly what failed.
- **Forget stale facts in the background now.** "Unused for a long time" is not
  "false", and a background pass needs its own durable row (ADR-0018). It is
  left for a later decision, with the same journal.
