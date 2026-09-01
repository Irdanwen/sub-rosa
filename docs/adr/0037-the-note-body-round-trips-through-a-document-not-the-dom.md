# 37. The note body round-trips through a document, not the DOM

Date: 2026-09-01

## Status

Accepted

## Context

A note is **stored as markdown** and **edited as a ProseMirror document**, so
every blur crosses a converter. The one that shipped
(`NotePreview.tsx`, `markdownToHtml` / `htmlToMarkdown`) understood five
things: `#` headings, flat bullets, paragraphs, `**bold**` and `*italic*`. Two
properties of it mattered more than its size.

It converted **markdown to an HTML string** and converted back by **walking the
rendered DOM**, collecting every list item with a single flat
`querySelectorAll("li")`. Nesting could not survive that walk, and neither
could any node it had no branch for.

And it **dropped what it did not recognise**. Not escaped, not preserved as
text: gone. Every heading level collapsed onto `h1`. An ordered list, a quote,
a code block, a rule, a link, a strike — all of which the StarterKit schema
already puts in the editor, and all of which arrive in markdown the note
generator and the assistant write — were deleted the moment the caret left the
editor.

The bug was invisible because the selection toolbar could only produce three of
the five things the converter knew. It was, in other words, a data-loss bug
armed and waiting for the first person to widen the toolbar. Widening the
toolbar is exactly what the work this ADR opens is about.

A third defect had no user yet but would have appeared immediately: text was
written **unescaped**. A paragraph reading `- not a list` serialized verbatim
and came back a bullet.

## Decision

**Rewrite the converter to serialize the ProseMirror document, escape what it
writes, and cover the whole schema. Do not adopt a CommonMark stack.**

Three parts, and the third is the one worth arguing about.

### Serialize the document, not the DOM

`docToMarkdown` walks `editor.state.doc`. A document is a tree, so the walk is
recursive by construction and nesting survives without special cases.
Decorations, placeholder pseudo-elements and ProseMirror's trailing-break
widget are not in it at all, so they can never leak into a note.

### Escape on the way out, unescape on the way in

Text is escaped for the inline specials and, in the first column, for the block
markers. This is what makes the round trip a *fixed point* rather than merely a
best effort, and it is the property the test suite is built on.

### Hand-written, table-driven, not `prosemirror-markdown`

The obvious move is `prosemirror-markdown`: it is written by the ProseMirror
authors, `@tiptap/pm` is already pinned, and its serializer solves the genuinely
hard parts. It was rejected for two reasons.

- **Its parser is `markdown-it`, a full CommonMark parser, and
  `MarkdownParser` throws on a token type it has no spec for.** A note
  containing a table — which the assistant can write today, and which the file
  already holds as ordinary paragraph text — becomes an exception instead of a
  note. Avoiding that means configuring `markdown-it` down to the subset we
  support, which is writing the table anyway, plus a dependency, plus a crash
  class that did not exist before.
- **We need a deliberate policy for what we cannot represent, not a general
  one.** Markdown that this app's schema has no node for stays literal
  paragraph text: not rendered as a table, but every character kept. That is a
  product decision about someone's notes, and it belongs in code we own.

The cost is that the emphasis rules are ours to get right. The mitigation is
below, and it is the reason this is defensible rather than reckless.

### Emphasis runs are never shared between two text nodes

This is the subtle part, and it was found by the property test rather than by
reasoning.

Sharing a delimiter across adjacent text nodes — keeping `**` open while only
`*` closes — produces *asymmetric* runs like `***x*y**`. Reading those back
correctly requires CommonMark's full delimiter-stack algorithm, which is
several hundred lines and a bug farm. So the serializer closes every emphasis
mark at every text-node boundary and reopens what the next node needs. Every
run it writes is then closed by a run of its own width, and a parser that
consumes runs greedily from the left splits a merged `*****` back into the
`***` and the `**` that made it.

Only the link is carried across a boundary, because it is bracketed and cannot
merge with anything.

The cost is a few extra characters in the rare note where bold and italic
partially overlap. The alternative was `__bold__` as a second spelling, which
buys nothing once runs are symmetric, and puts underscores in a file that a
person and a model both read.

### Four states are normalized rather than written and lost

A hard break at the edge of a block, two consecutive hard breaks, a hard break
in a heading, and trailing whitespace on a line have no spelling in markdown. A
block left empty is dropped, and two adjacent lists of the same kind read back
as one, because a blank line is how markdown separates blocks and cannot also
be one. Each rule is named in the module, and none of them loses a character a
reader could see.

### `underline` leaves the schema

StarterKit binds Cmd-U to a mark markdown cannot hold. A mark the editor
accepts and the file cannot write is precisely the bug this ADR removes, so it
is switched off rather than serialized to an HTML escape hatch that would leak
`<u>` into search, into the PDF, and into what the assistant reads. Highlight,
which does have a representation, takes its place in the writing surface.

## Consequences

- **The editor's vocabulary and the file's are one thing**, derived from one
  place: `noteSchemaExtensions()` builds the editor, and the test derives its
  schema from the same call. A converter tested against a drifted schema proves
  nothing.
- **The gate is a property, not a list of examples.** `note-markdown.test.ts`
  asserts that a document survives being written and read back, over a hand
  corpus and a thousand generated documents, and it reimplements the four
  normalizations from the module's prose rather than importing them — so it
  asserts those are the *only* difference a round trip can make. Every bug
  described in the Context section is a named test.
- **Existing notes need no migration.** Everything the old converter could
  write, the new one reads. Widening the reader is backward-compatible; what
  changes is that `##` now renders as a real `h2` instead of collapsing, and a
  quote or an ordered list already sitting in a note starts rendering as
  itself. The stylesheet grew the baseline rules those nodes need.
- **Trailing whitespace is trimmed and Cmd-U does nothing.** Both are visible
  behavior changes, and both replace a silent deletion with a stated rule.
- **The next widening is cheap.** Adding the task list and highlight means a
  node spec, a row in the converter, and a corpus entry. That was the point.
