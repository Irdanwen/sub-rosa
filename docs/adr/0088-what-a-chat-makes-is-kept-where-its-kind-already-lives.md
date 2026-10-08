---
status: accepted
date: 2026-10-08
---

# What a chat makes is kept where its kind already lives

## Context

The parity matrix (ADR-0078) left four rows of the same family open: a
**library** of everything a chat made plus what the person saved from it,
**image generation with thinking** (the model looks at its own picture and
fixes it), **document scanning**, and **virtual try-on**. Each produces
something that has to be kept somewhere: a picture, a version of a picture, a
scanned page and its text, a reply or a link someone wants to find again.

Each could have had its own store: a library table holding copies of chat
images, an attachments table for notes, a refine session table. The app
already had a durable home for most of these kinds: the gallery (ADR-0020)
with its lineage (ADR-0070) and its marks (ADR-0073), and the note.

## Decision

**Each output goes where its kind already lives, and is found from there.**

- **A picture made in a chat is a gallery file**, tagged in its generation
  metadata with `origin: {surface: "chat", taskId?}`. Every chat path files it:
  the desktop media tool (the `/v1/media/save` route forces the origin whatever
  the agent sends), an assistant proposal that renders at once, and a queued
  one when it lands. The Library's "Images" lists gallery files with that
  origin. No copy, no second table.
- **A refined version is a gallery file with lineage.** A refine pass is a
  vision critique against the prompt, then, unless the picture already does
  what was asked, one edit queued as a durable media job (`image_refine.rs`)
  carrying `edit: {of, root, op: "refine", n}`: the result is filed by Rust when
  it lands, watched or not, and shows as a version tree like a retouch. At most
  two passes; the extra price (edit price times passes) is shown before the
  person confirms, and the desktop agent is told to quote it and ask first. A
  pass cut short by a restart is history, never re-run.
- **A try-on is a gallery file.** `/image/multi-edit` with a tuned prompt, from
  a Studio template, the phone's image panel, or a `subrosa:tryon` card in a
  chat. The card carries no images and no price: the person picks both photos
  and the price comes from the catalog.
- **A scan is a note.** The recognized text is the body, written in the note's
  markdown dialect and escaped like the editor escapes it; the PDF is a file
  named by its note (`<app data>/scans/<note id>.pdf`), found from the note id
  alone, so no column points at it and no path is stored. The note
  synchronises; the PDF stays on the device.
- **What is saved from a chat that is not a file is a small local table.** A
  reply, a link row or a place, saved with "Save", is a `saved_items` row
  (migration 054) keyed by what it is (`reply:<chat>:<message>`, `link:<url>`,
  `place:<lat>,<lng>:<name>`), so saving twice keeps one row. Like reply
  ratings (ADR-0082) it has no sync trigger and travels only in an archive. A
  temporary chat (ADR-0083) refuses it in Rust, and the buttons are not shown.

The **Library** is then only a view over two sources: saved items, and gallery
pictures whose origin is a chat. Both shells show the same component.

## Consequences

- One migration, no new sync contract, and nothing the account service has to
  learn. Saved items do not follow the person to another device; synchronising
  them later is an additive registry entry.
- A picture made by an older build carries no origin, and the Library does not
  show it. The gallery still does.
- A scanned PDF is lost with the device, unlike the note. An archive with
  recordings does not carry it either; that is a follow-up if scans become a
  primary use.
- Gallery marks (ADR-0073) were not reused for saved items: marks name gallery
  files by their UUID stem, and a reply or a link is not a file.

## Alternatives rejected

- **A library table holding chat pictures.** Two homes for one file, and two
  deletions to keep in step.
- **Note attachments.** A general feature (storage, sync of bytes, UI) for one
  kind of file; a PDF named by its note gives the scan its original without it.
- **A refine session table.** The lineage on the artifact already is the tree,
  as it is for a retouch.
- **Synchronising saved items now.** It would add an object kind to the wire
  contract (ADR-0049) for a list the person can rebuild with a tap; local first
  keeps the boundary where it is.
