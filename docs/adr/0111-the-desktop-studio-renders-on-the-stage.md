# ADR-0111: The desktop Studio renders on the stage, with five tabs

Date: 2026-10-12. Status: accepted. Builds on the Stage, Veil and Dock
entries of [CONTEXT.md](../../CONTEXT.md) (shipped on the phone in PR #254
and #255), [ADR-0018](0018-ios-background-work-is-durable-rows.md),
[ADR-0020](0020-the-gallery-is-the-studio-exchange-format.md) and
[ADR-0073](0073-the-gallery-is-organised-in-synchronised-marks-apart-from-its-files.md).

## Context

The 2026-10-12 design audit gave the desktop Studio 3.5/10 while the phone
Studio had moved on. The desktop had eleven tabs (Projects, Explore, Image,
Retouch, Compose, Video, Audio, Assemble, Bible, Workflows, Gallery), three
of them duplicates of a section of another (Image › Edit next to Retouch and
Compose, the Bible tab next to Projects › Bible, Assemble next to Projects ›
Montage). Each generation tab was a two-column form (`GenerationLayout`):
about fifteen controls visible at once on Image › Generate, the result
landing in a strip under the form rather than where the eye waits for it,
the price shown four different ways and not at all for speech and music, and
a wait drawn by `Darkroom` on one tab, grey skeletons on another and the
stage `Veil` on Retouch only. None of the phone's changes since 2026-10-03
(the stage, the dock, the blocker that says why send is disabled and what
unblocks it, the direction filters, the renders in flight in Recent, Reuse
prompt) had reached the desktop, because the two shells had their own
components for the same thing.

## Decision

1. **Five tabs: Image, Video, Audio, Projects, Gallery.** Retouch, Compose,
   Upscale and Cutout are tools of Image. Bible, Montage (what Assemble did)
   and Workflows live in Projects. Explore is replaced by the idle canvas and
   its suggestions. A saved tab from the old set resolves to its new home, so
   nobody lands on nothing after the update.
2. **Every generation surface is a stage, a dock and an inspector.** The
   stage holds the last result at its true ratio, the veil while the next one
   renders, and the reveal. The dock, centred under the stage, holds the
   prompt, the chips that matter on every render (model, ratio, resolution,
   duration), one round button that spends with its price beside it, and the
   blocker line. Every other setting moves to an inspector on the right that
   can be folded away: the desktop has the width the phone lacks, so what the
   phone hides behind "More options" sits beside the work instead of in front
   of it.
3. **One wait.** `Veil` replaces `Darkroom` and the skeleton tiles; a render
   in flight shows in the filmstrip under the stage from its durable row
   (`useRunningMediaJobs`), whichever tab started it.
4. **Shared components, not shared CSS only.** The stage, the dock and their
   chips move into `src/components/studio/stage/` and both shells render
   them. Each shell keeps its own form logic where the desktop does more
   (shot chains, compare, frame capture), but a pattern drawn twice is a
   pattern that drifts twice.

## Consequences

- The phone and the desktop now read the same CONTEXT.md nouns on screen:
  a change to the dock is a change on both, and `stage-css.test.ts` covers
  both shells.
- `GenerationLayout` disappears with its last caller. `FilmStudio.tsx`, dead
  since ADR-0029, is deleted first.
- The desktop loses the one-shot multi-edit form under Image › Edit. Retouch
  already does everything it did (up to three images combined, every version
  kept), which is the decision the phone made on 2026-10-03.
- Deep links and window events that opened a removed tab
  (`OPEN_RETOUCH_EVENT`, `OPEN_COMPOSE_EVENT`, the chain hand-over to
  Assemble) open the tool or the project section that replaced it.

## Rejected

- **Render the phone panels on the desktop as they are.** They carry phone
  behaviour (bottom sheets, the keyboard inset, haptics) and they lack what
  the desktop forms do (compare, chains, frame capture). Sharing the
  presentational pieces gets the consistency without regressing either.
- **Keep the form and only move the result above it.** The result would be in
  the right place, but fifteen controls would still sit in front of the one
  that matters, and the price and the wait would still be drawn four ways.
