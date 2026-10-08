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

## Addendum 2026-10-08: saved items synchronise; a scan's PDF still does not

The decision to keep saved items on the device was rated as the weakest part
of the Library: the vendor's library follows the person to every device, and
"a list the person can rebuild with a tap" is not true of a reply saved from a
chat that only exists on the other machine. The additive registry entry the
consequences named is now made.

- **`saved_items` is a synchronised table**, routed as `artifact` like the
  gallery's marks (ADR-0073), on the generic row codec: the outbox triggers,
  the first inventory and a remote deletion are the registry's. Nothing is
  added to the wire contract (ADR-0049); `artifact` is an existing kind and the
  row is opaque to the service. The registry itself moved to
  `account/sync_tables.rs`, unchanged otherwise, because `sync.rs` had reached
  the file-size ceiling.
- **An item's id is derived from what was saved**, a name-based UUID of its
  `source_key` (`saved_items::item_id`), like a mark's (ADR-0073). Saving one
  link on two devices then makes one object, not two rows that the unique
  `source_key` would refuse to hold side by side. A received item that finds a
  row for the same thing under another id (only builds before this addendum,
  which drew ids at random, make one) replaces it.
- **The same item saved on two devices before either heard of the other is
  settled, not reviewed.** The two revisions differ only in when each device
  saved it and which chat it came from; a saved item is never edited, only
  saved and removed, so the same `source_key` is the same item. It joins the
  "identical content" rule of `auto_resolve_identical_conflicts`. A removal on
  one device against a save on another still stays for review, like every
  deletion that is not clean (ADR-0072).
- **A temporary chat's items never leave**, enforced twice: saving refuses them
  (unchanged), and the sync trigger refuses a row whose conversation is a
  temporary chat by task id or by Hermes session id (ADR-0083).
- Items saved before the account was bound, or before this build, leave when
  sync is turned on: `set_enabled` queues every saved item the server has not
  seen, since most accounts took their first inventory long ago.
- The Library re-reads its store when a sync applies changes, so an item saved
  on the phone shows on an open desktop Library without a reload.

A desktop item names its chat by the Hermes session id, which no other device
knows. Nothing navigates from that id (it is provenance, and part of a reply's
key), so the other device shows the item but cannot open the chat it came
from; translating it the way `account_session_folders` does (ADR-0080) is a
follow-up if the Library grows an "open the chat" action.

**The scanned PDF still stays on the device.** The file lane
(`account/files.rs`) carries three kinds of file, each tied to the row that
names it: a recording to its `audio_artifacts` row, a Studio file to its
gallery record, an assistant or project file to its reference. A note has no
attachment of its own to ride it, and a scan's PDF is deliberately named by its
note rather than by a row (see above). Carrying it would mean a fourth
`source_kind`, with its own staging, download destination and removal lane, and
older builds would hold its manifest waiting for a parent they cannot find.
That is a decision of its own, recorded here as not taken; the note and its
recognised text synchronise as before.
