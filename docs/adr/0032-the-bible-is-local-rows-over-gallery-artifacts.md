---
status: accepted
date: 2026-08-24
---

# The bible is local rows over gallery artifacts

## Context

Nothing carries over between separately generated clips. Shot twelve knows
nothing about shot one. A character stays the same character only because two
things are repeated on every single shot: their reference images, in the same
order, and their invariant traits, restated in the prompt.

The Studio could always attach references to *a render*. Nothing made them
survive it. So the same character was re-uploaded by hand every session, in
whatever order the file picker happened to offer, and drifted a little each
time. The remote studio solved this with a server-side asset pack, which went
away with it.

## Decision

**Persistent identities are local rows, and a reference is a pointer at a
gallery artifact.** Characters, locations, props and the look, in
`bible_entries` and `bible_refs` (migration 017).

Four choices worth stating.

**A reference points, it never copies.** The gallery is already the exchange
format of the Studio ([ADR-0020](0020-the-gallery-is-the-studio-exchange-format.md))
and is already reconciled against the disk. Storing bytes here would be a
second copy to keep in step and a second thing to delete.

**A pointer is allowed to aim at nothing.** The gallery index is capped, halved
under quota pressure, and adopts files it does not recognise, so entries come
and go legitimately. A reference whose artifact is gone is *reported*, on the
Bible tab, where the user can do something about it - never repaired, never
deleted on their behalf. Elsewhere it is simply not offered, because a tile
that does not work in the middle of somebody's shot is worse than its absence.

**Order is the contract.** The first image is what a reference-to-video model
treats as the identity to hold. Which angle reads as the identity is a
judgement, so it is reorderable, and it is stored rather than derived.

**Entries belong to the install, not to a production.** A workflow run is over
when it is over. A character outlives every film they are in.

## Consequences

- Every reference slot in the Studio offers the bible, for free, because they
  all go through the shared gallery picker.
- A face picked out of the bible brings its traits into the prompt, once. That
  restating is the whole point; without it the picker just hands over a picture.
- The invariant traits are bounded (600 characters) because they are re-sent on
  every shot of every film, where a runaway paste would eat the prompt budget
  silently.
- A character's voice is a reference too, in the `voice` role: a speech
  artifact chosen by audition, which then rides as the voice donor. It is an
  ordinary gallery artifact, not a special case.
