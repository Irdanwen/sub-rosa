---
status: accepted
date: 2026-08-04
---

# The gallery is the Studio's exchange format

## Context

Studio surfaces need to hand images to each other. An image generated in the
Image tab is the obvious opening frame for a clip; a still out of a rendered
clip is the obvious thing to rework, upscale, or hand to the Films crew as a
character reference.

Two things were in the way, and they looked like two features.

**Images only ever moved one way, to one place.** The gallery card carried a
"Send to edit" button whose handler hardcoded its destination
(`setEditSources(...)` then `setMode("edit")`). Every other image input in the
Studio — the video opening frame, the end frame, the reference photos, the Films
references — had a `<input type="file">` and nothing else. Serving a second
destination meant a second button on the card, and asking the user to find the
picture first and decide where it should land second.

**A frame pulled out of a clip was never a file.** `frames.ts` already did the
hard part for shot continuity (decode, sample six candidates near the end, keep
the sharpest), but the result was a data URL assigned to
`useState("")` in the video studio. It could not be exported, could not be
opened anywhere else, and vanished on a tab switch. "Save the last frame to
disk" therefore read as a third, separate feature with its own export path.

## Decision

**Every produced file is a gallery artifact, and the gallery is what surfaces
exchange through.** Two directions, one idea:

- **Into the gallery.** Capturing a frame writes a real image artifact
  (`saveArtifactFromBase64`, PNG) instead of returning a data URL to a form.
- **Out of the gallery.** A shared `GalleryPicker` dialog is reachable from
  every image input, so a slot pulls what it needs instead of waiting to be
  pushed at. Mobile already worked this way (the reference picker's "From
  gallery" sheet); this is that inversion on desktop.

Everything else falls out of paths that already existed. A captured still is
exportable because `exportArtifact` and the "Save a copy" button already work on
any artifact; it is reworkable because "Send to edit" already does; it is
reusable as a reference because the picker offers whatever is in the gallery.
No export path, no reuse plumbing, and no scratch area were written for it.

Two supporting choices this forced:

**Frame extraction has two encodings, not one.** `payload` (a JPEG downscaled
under the proxy's body cap) is what every generation path needs, because the
frame is about to ride inside a request. `capture` (the clip's native
resolution, PNG, no ceiling) is what a still kept for rework needs. The capture
dialog previews at `payload` quality while scrubbing — a drag costs one decode
per tick — and re-reads the chosen position at `capture` quality on save.

**Capture provenance gets its own fields.** A still records
`sourceArtifactId` / `sourceTimeSeconds`, deliberately not the
`parentId` / `parentHandoffSeconds` pair from
[ADR-0019](0019-shot-chains-are-parent-links.md). Those two mean "this shot
continues that one" and are what `chain.ts` walks to rebuild a chain and count
its branches. A still is an image, not a shot, and must never join a chain.

## Consequences

**One affordance per input, not one button per destination.** Adding an image
slot anywhere in the Studio now costs a `GalleryPicker` mount, and it inherits
the whole gallery. The old push button stays where it is — it is a genuinely
good shortcut from a picture you are already looking at — but it is no longer
how new destinations get served.

**"The last frame" is now something the user can actually ask for.** The
capture scrubber runs the whole clip and defaults to the sharpest frame near the
end (the same pick continuity makes). It stops one frame short of `duration`
and says so, because seeking to the exact end decodes past the final frame and
reads back black on most decoders — the constraint that made `frames.ts` avoid
the true last frame in the first place, now surfaced instead of silently
applied.

**Captures inflate the gallery, and that is fine.** They are ordinary artifacts:
capped by the same index limit, reconciled against the disk the same way,
deleted through the same button.

**Capture provenance is index metadata, not a durable row.** Unlike a chain
link, which rides `media_jobs` because a render outlives its session
([ADR-0018](0018-ios-background-work-is-durable-rows.md)), a capture is
synchronous and local: it cannot outlive anything. So its provenance lives only
in the localStorage index and is lost if the entry is evicted and the file
re-adopted from disk. Losing it costs a caption, not a feature.

## Alternatives considered

**A dedicated "export this frame" button, writing straight to a save dialog.**
This is what was literally asked for, and it is what the request was for the
*first* of the three things the user then wanted (export, rework elsewhere, use
as a reference). It would have delivered one and required inventing the other
two separately, each needing a path for a file that lives nowhere.

**Reusing `parentId` for capture provenance.** Tempting, since the shape fits
exactly. Rejected: it works only for as long as every caller keeps filtering the
artifact list down to videos before handing it to `chain.ts` — an invariant that
lives in the callers and that `chain.ts` can neither see nor enforce. A distinct
pair of fields costs three lines and removes the coupling.

**Extending the push model with a destination menu on each gallery card**
("send to → opening frame / references / Films"). Rejected: the menu grows with
every new slot, it has to know about surfaces the gallery has no business
knowing about, and it still makes the user navigate to the gallery before
knowing where the image is going.

**A separate scratch area for frames, outside the gallery.** Rejected: it is the
gallery with fewer features. Everything a scratch area would need — disk
persistence, disk reconciliation, export, delete, a grid — already exists once,
and a second one would have to be kept consistent with the first.
