---
status: accepted
date: 2026-10-02
---

# A retouch is a lineage of artifacts, and its zone merge is native

## Context

The Studio gets a Retouch tab: one image fills the surface, an instruction is
typed under it, and the result replaces it, step after step, with undo, redo,
branches, variants and edits limited to a drawn zone. Ideogram 4.5's editor
(`ideogram-v4-5-edit`) is the default model. A retouch takes 12 to 45 seconds and
is billed per job (10.8 credits, measured), so it is paid work a person cannot
recreate for free, and on iOS it routinely outlives the foreground session.

Three questions had real alternatives.

1. Where does the version tree live?
2. How does a result that lands while the webview is frozen, or after a cold
   launch, find its place in the tree?
3. Who merges a zone result back into its source?

Measured against the operator on 2026-10-02, and binding for the request:

- `/image/multi-edit` takes `resolution` and `quality`. `/image/edit` refuses
  `quality`. A retouch therefore always uses multi-edit, which also accepts a
  single image and honors `aspect_ratio`.
- The operator caps `images` at three, whatever the catalog advertises
  (`maxInputImages: 5`). A fourth image is refused at queue time.
- An unsupported ratio or resolution is accepted by the queue and refused at
  retrieve, so the app sends only values the catalog lists.
- Each image must stay under 5 MB (413).
- The output may be JPEG whatever was asked. Rust already names files by
  their signature.
- A crop edited and merged back through a feathered mask leaves no visible
  seam. Without the merge, the model drifts by about 8 levels on average over
  pixels it was not asked to touch.

## Decision

**The tree is lineage on the artifact.** A version's generation metadata
carries `edit: {of, root, op, n, jobId, elapsedMs, …}`. That metadata is the
opaque JSON `studio_artifact_metadata` already stores. The tree is derived
(`retouch/lineage.ts`), the way shot chains are (ADR-0019), but through its own
field: `parentId` stays the video chain's, and `chain.ts` must never walk a
retouch. A version is an immutable file, so a parent pointer cannot go stale.
Deleting a version needs no cleanup. A branch survives a deleted middle
version through `root`.

**The job carries its lineage.** `media_jobs` gains `client_context`, an
opaque JSON the queuing surface gets back with the result, bounded at 64 KB.
Every retouch, variants included, is queued through `media_job_queue` with
source `retouch:<root>`, and is filed by the observer that already recovers
standalone images. There is one path, whether the person watched the result
arrive or opened the app the next morning. The elapsed time shown on a
version comes from the row's own timestamps.

**The zone merge is native and happens at delivery.** A zone retouch also
carries `composite: {parentFileName, crop, maskPngBase64}`, stored in its own
column and never sent back to the webview. `jobs.rs` resamples the result to
the crop and blends it into the parent (`carpe_diem/zone.rs`, the `image`
crate) *before* saving, so the gallery and the encrypted file queue only ever
see the merged version. If the parent is gone, the paid result is saved as it
came back and the context says `compositeFailed`. The version is then marked
unmerged rather than lost.

## Consequences

- No new table and no new command. The two columns are additive
  (`ensure_column`), and an older build ignores them.
- The merge works while the webview is frozen and keeps clear of the iOS
  webview's canvas limit, which a 4x upscale would exceed.
- A parent is named by file name, never path, because the iOS container moves
  across reinstalls.
- Instructions typed while a retouch renders are not paid yet. They stay in
  the session and are never re-run by themselves after a restart: incoming
  execution state is history, not an order to buy work again.
- The cap of three inputs is a constant (`MULTI_EDIT_OPERATOR_CAP`) to raise
  when the operator follows its catalog.

### Why durable here when a note rewrite is not (ADR-0038)

A rewrite is transient because replaying it onto a paragraph edited since
would silently corrupt it. A retouch has no such hazard: its inputs (the
parent file and the mask) are immutable, and its output is a new file beside
them, never a change to anything the person edited. What durability protects
here is the paid result.

## Alternatives rejected

- **A `retouch_sessions` table.** It would duplicate what the artifacts
  already say, need its own deletion and sync rules, and would still have to
  learn about versions filed while the app was closed.
- **Merging in the webview.** It cannot run while iOS freezes the webview, it
  exceeds the canvas limits on large images, and it would land a loose crop in
  the gallery first.
- **Sending the full image and asking the model to "change only the marked
  area".** Measured: the model re-renders everything, and the pixels outside
  drift.

## Addendum, 2026-10-03: the model belongs to the retouch

Ideogram 4.5 was the default, but the chosen model was stored once per
device (`os-june:retouch-settings`). A model picked for one photo therefore
became the model of every later retouch, and a new retouch stopped opening on
the default without the user ever choosing that. The model is now kept per
retouch (`os-june:retouch-session-models`, keyed by the root, capped like the
cursors); the resolution, ratio and tries per send stay device-wide. A new
retouch always opens on `ideogram-v4-5-edit` while the catalog offers it, and
the phone picks the model in the same sheet as every other Studio picker,
with the default pinned first and marked as recommended.
