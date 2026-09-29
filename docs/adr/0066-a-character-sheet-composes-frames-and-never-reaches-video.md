---
status: accepted
date: 2026-09-29
---

# A character sheet composes frames and never reaches video

## Context

A character stays the same character across shots because the same reference
images ride with every shot, in the same order (ADR-0032), and the first is the
identity the model holds. Until now those references were drawn one at a time:
a portrait, then a profile, each from text. Two text-to-image draws of "Marie,
short red hair, green coat" are two different women who share a description.

Image models can now draw a character sheet: one image with the same person
from nine angles and expressions, consistent because it is one generation. It
is the tool people use to hold a character steady, and the owner asked for it.

The obvious move is to add it to the reference stack as the strongest anchor
there is. That is the move this ADR rejects.

## Decision

The sheet is a bible reference role, `sheet`, offered for characters. Its uses
are fixed:

- **It is drawn from the portrait when there is one.** The sheet then goes
  through an image-edit model with the portrait as its input, so the face it
  repeats nine times is the face the person already chose. Without a portrait it
  is drawn from text, and the surface says so.
- **It composes frames.** Image composition (`/image/multi-edit`) takes at most
  three inputs. A sheet puts a whole character into one input and leaves two
  for the place and an object.
- **It is cut into a portrait and a profile.** The layout is fixed
  (`SHEET_LAYOUT`): the middle row's first cell is a front view, its last cell a
  profile. `bible/sheet.ts` crops those two by position, in the webview, for
  free, and they join the entry as ordinary references.
- **It never rides to a video model.** `referenceStack` does not list the role.
  A reference-to-video model treats its references as what the shot should look
  like: a grid there is an invitation to film a grid, or to cut between nine
  people.

## Consequences

- **The layout is a contract between three places.** `SHEET_LAYOUT` in
  `portrait.ts`, `SHEET_CUTS` in `sheet.ts`, and `SHEET_RULE` in
  `studio_ai/prompts.rs`, which tells an AI rewrite of the prompt it may
  describe the person better but must not move, merge or drop a panel. Change
  one, change the three.
- **A cut is by position, after trimming the margin.** A real sheet
  (seedream-v5-lite, 2026-09-29) followed the nine-panel layout exactly but drew
  a plain margin around the grid. Thirds of the whole image then landed on
  borders. `gridBounds` trims rows and columns that match the corner colour, and
  the grid inside is split in thirds. Detecting faces or individual gutters was
  rejected: it is more code than the feature, for a failure the person sees at
  once and removes.
- **Prompts are now kept per role** (`imagePrompts` on a project bible entry).
  The old single `imagePrompt` still applies to every role but the sheet: a
  prompt written for one view would draw a sheet as a single view.
- **The global library accepts the role too** (`bible.rs::ROLES`), so a sheet
  copied from a project into the library, or the other way, is not refused.

## Alternatives rejected

- **The sheet as the first reference of the video stack.** Rejected for the
  reason above. The two views cut from it do that job instead.
- **Nine references cut from every sheet.** Only the portrait and profile have
  a role in the stack. Nine would crowd out the location and the other
  characters under the nine-image cap, for angles no shot asked for.
