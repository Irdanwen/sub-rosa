---
status: accepted
date: 2026-10-08
---

# A canvas is a note the assistant proposes versions of

## Context

The parity matrix (ADR-0078) left the canvas open: a draft or a file of code
that opens beside the chat, that the person and the assistant both work on,
with "ask about this passage" going the other way. Three things already
existed that a canvas could be built from, or around:

- **The note editor and its markdown seam (ADR-0037).** A note is stored as
  markdown and edited as a ProseMirror document, and a round-trip property test
  guards the seam. It could not hold a table: a pasted table survived as
  literal text and nothing more.
- **Note rewrites (ADR-0038).** A model returns a revision of a selected
  passage, and nothing lands in the note without the person accepting it.
- **Chat blocks (ADR-0024).** A reply carries fenced JSON the app renders as a
  card, persisted in the message text itself.

The obvious alternative was a canvas document type: its own table, its own
editor (a code editor for code), its own sync and export, and an agent tool
that writes into it directly, the way the canvas features people know behave.

## Decision

**A canvas is a note.** There is no canvas table and no canvas format. Opening
a draft in a canvas creates an ordinary note (title and body) and opens it in
the note editor, beside the chat on the desktop (a split view wrapping the
agent workspace, `CanvasHost`) and as a screen of its own on the phone. A code
canvas is a note whose body is a single fenced code block; the pane names its
language and copies the code alone. Everything a note already has, a canvas
has: search, the assistant's read tools, export, the archive, sync.

**The assistant proposes; the person applies.** ADR-0038 is extended from a
selected passage to the whole document, in two ways, and neither writes:

- A reply may carry a `subrosa:canvas` block `{v, title, kind, language?,
  content, noteId?}`. Without `noteId` its card opens the draft as a new canvas
  (a note is created only on that tap). With the `noteId` of a canvas on this
  device it is a *proposed new version*, shown for review in place of the
  document until it is accepted or discarded. An id the device does not know is
  treated as a new draft, never trusted.
- Under an open canvas, an instruction runs a note rewrite of kind `canvas`
  over the whole document (`note_ai`, prompt `note-rewrite-v2`), which may
  change the structure as asked. It streams into the same review and lands
  only on Accept, as one write.

**The file decides what the editor may hold, tables included.** Tables were
added converter first (spec/note-controls-must-serialize): GFM pipe tables,
columns padded so the file reads as a grid, a cell restricted to one
paragraph in the schema (a pipe table cell is one line), pipes escaped in
cells, a code span read whole, a paragraph line starting with `|` escaped like
`- not a list`. The normalizations a table forces (one line per cell, first row
the header, a column's alignment its header's, `|` in a link target written
`%7C`) are reimplemented in the round-trip test, which generates tables
alongside every other block. Only then was "Table" added to the `/` palette.

**"Ask Sub Rosa" carries a quote, not a reference.** The selection toolbar
dispatches the selected passage as markdown; each shell brings the chat
forward and its composer takes the quote once (`lib/ask-selection`), whether it
was on screen or mounts afterwards.

## Consequences

- No new table, no migration, no sync rule, and no new command beyond a rewrite
  kind: the canvas inherits every guarantee notes already have.
- A canvas the assistant edits is still only as large as a rewrite may be
  (24,000 characters), and an agent cannot write into it unattended. That is
  the point, and it means a long canvas edit costs a full-document rewrite.
- A canvas opened from a block is remembered per device (a convenience in
  local storage), so opening the same card twice returns to the same note. If
  that memory is lost, the next open makes a second note; nothing else breaks.
- A code canvas is edited in the note editor's code block, not a code editor:
  no syntax highlighting or line numbers. Copy, the language label and the
  assistant's whole-file versions are what it offers.
- A temporary chat (ADR-0083) offers no "Open in canvas": a canvas is a note,
  and a note is one more way out.

## Alternatives rejected

- **A canvas document type with its own store.** It would duplicate notes
  (search, export, sync, archive, the agent's read tools) and still need the
  same proposal rule, since a canvas is text the person wrote.
- **Letting the agent write the canvas through a tool.** It is exactly what
  ADR-0038 refuses: text the person wrote replaced because a model was
  confident.
- **Diff-based proposals.** A model's line diff against a document the person
  may have edited since is fragile; a whole version reviewed whole is not.
- **Tables as an HTML block.** Spec/note-controls-must-serialize rules it out:
  it would leak into search, the PDF and what the assistant reads.
