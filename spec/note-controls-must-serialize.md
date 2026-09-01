# A note control must survive the file

**Rule.** Do not add a control, a keyboard shortcut, an input rule or a node to
the note editor unless `docToMarkdown` can write what it produces and
`markdownToDoc` can read it back. The converter comes first, then the control.

**Why.** A note is stored as markdown and edited as a ProseMirror document, so
everything the editor can hold has to cross that seam on every blur. Whatever
the serializer has no branch for is not preserved and not rejected — it is
silently deleted the moment the caret leaves the editor, and the user finds out
much later, if ever.

This is not hypothetical. It is exactly the bug ADR-0037 was written to remove:
the editor's schema already contained ordered lists, nested lists, quotes, code
blocks, rules, links and strike, and the converter knew five constructs, so all
of it disappeared on blur. It stayed invisible for as long as the toolbar
happened not to offer any of it.

**How to apply.**

- Add the node or mark to `noteSchemaExtensions()` in
  `src/components/note-editor/extensions.ts` — the one list the editor and the
  round-trip test both derive their schema from. Never restate it.
- Add its row to `src/lib/note-markdown.ts`, both directions.
- Add an entry to the document corpus in `src/test/note-markdown.test.ts`, and
  to the generator if it can nest or carry marks. The suite fails if the node
  can be built and not written back.
- Only then wire the button, the shortcut or the input rule.

**Exceptions.** A construct markdown genuinely cannot express — underline is
the standing example. Then the answer is to **switch the capability off**
(`underline: false` in StarterKit) rather than to ship a control whose output
evaporates, and to offer the nearest thing the file can hold. An HTML escape
hatch is not an exception: it leaks into search, into the PDF, and into what
the assistant reads.
