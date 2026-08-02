---
status: accepted
date: 2026-08-02
---

# A shot chain is parent links on durable rows, not a stored sequence

## Context

Every video model caps a clip at a handful of seconds (4 to 15 across the
families the catalog offers). The only way to a longer sequence is to chain:
take a frame near the end of one clip, start the next one from it. Sub Rosa now
does that from a "Continue this shot" gesture on any clip in the gallery, and
the question is what a *chain* is made of.

Three things constrain the answer.

**A render outlives the session that queued it.** Studio generations are durable
rows re-driven by `crate::background::sweep`
([ADR-0018](0018-ios-background-work-is-durable-rows.md)): the app can be closed
mid-render and the file still lands in the gallery. So a chain held in React
state loses its link exactly when the render is slowest — the case the feature
exists for.

**Artifacts are immutable.** Nothing is ever edited in place: continuing the
same clip twice produces two new files, not a replacement. Any structure that
assumes "the shot after this one" is a single, editable slot is lying.

**The gallery is reconciled against the disk.** Its index lives in
localStorage, is capped at 200 entries, is halved under quota pressure, and
adopts files it does not recognise. Entries disappear routinely and legitimately;
files get deleted from other surfaces.

## Decision

**A chain is not stored. Each shot records only the clip it continues, and the
chain is derived by walking those links.**

Two fields ride the durable `media_jobs` row and are copied onto the gallery
entry when the file is indexed:

- `parent_artifact_id` — the clip this render continues.
- `parent_handoff_seconds` — where in that parent the handoff frame was taken.

`src/lib/studio/chain.ts` derives everything else: `chainOf` walks up to the
first shot and back down the most recent branch, `chainCuts` turns the chain
into a cut list where each shot is trimmed at the point its successor took over,
`alternativeCount` surfaces the takes a branch left behind.

The handoff point is recorded rather than recomputed because it is what makes
the seam clean: the frame is deliberately taken ~0.5 s before the end (cutting
on movement, and escaping the blurred final frame), and assembly trims the
parent's tail to exactly that instant so the half second is not played twice.

## Consequences

**A chain survives everything the artifacts survive.** A render that finished
overnight joins its chain the moment it is indexed, because the link came off
the row, not from the UI that started it.

**Deleting a clip in the middle breaks the chain in two instead of corrupting
it.** A dangling `parent_artifact_id` simply ends the walk: the chain starts at
the oldest shot still on disk. There is no list to repair, no orphan to garbage
collect, and no migration when the index is rebuilt from the disk listing.

**Re-generating a shot forks rather than replaces.** Continuing the same clip
twice creates a branch; the derived chain follows the most recent one and the
UI shows a count of the takes not followed. There is deliberately no
"invalidate the descendants" flow — with immutable artifacts there is nothing to
invalidate, only branches to choose between.

**Chains are cheap to display anywhere.** Any surface holding the artifact list
can derive a chain with no extra state, which is how the video studio's ribbon
and the Assemble hand-off both work.

**The cost of a chain is only as complete as its rows.** `cost_credits` is
recorded per render from the quote, so shots generated before this shipped (or
adopted from disk without an index entry) have no figure. `chainCost` returns
what is known alongside the total, so the UI says "at least N credits" rather
than under-reporting.

## Alternatives considered

**A `shot_chains` table with an ordered list of members.** Rejected: it needs a
migration, it needs repair logic for every way a member can vanish (deletion,
index eviction, reinstall), and re-generating a shot means editing a list that
two surfaces may hold open. The parent link expresses the same structure with no
authority to keep consistent.

**Keeping the chain in the video studio's React state.** Rejected outright by
ADR-0018: it is lost precisely when a render outlives the foreground session.

**Deriving chains heuristically (same prompt prefix, adjacent timestamps).**
Rejected: it guesses, and it guesses worst exactly where chains are most useful
(several takes of the same shot, rendered minutes apart).

**Anchoring the look by adding `reference_image_urls` to image-to-video
requests.** The quote endpoint accepts the field there, but a pricing validator
accepting a field does not prove the model receives it, and confirming it would
cost a real render per model. Anchoring instead routes through the family's
reference-to-video model, whose multi-photo contract is documented and probed —
the handoff frame still opens the clip, the anchor frame holds the look.
