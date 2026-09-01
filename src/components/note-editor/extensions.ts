/**
 * The note body's editing vocabulary, in one place.
 *
 * It lives outside `NotePreview` so the round-trip test can build the exact
 * same schema the editor runs on. A converter tested against a schema that has
 * drifted from the editor's proves nothing, and the failure it would miss —
 * a node the editor can create and the file cannot hold — is silent data loss.
 *
 * `underline` is off on purpose. StarterKit binds it to Cmd-U, markdown has no
 * underline, and a mark the editor accepts and `docToMarkdown` cannot write is
 * exactly the class of bug this pair of modules exists to remove. Highlight,
 * which does have a representation, is the emphasis offered in its place.
 *
 * The task list is the one thing worth copying wholesale from a notebook app:
 * a meeting note is mostly things somebody has to do, and a box you can tick
 * is the difference between a record and a list you work from.
 */

import Highlight from "@tiptap/extension-highlight";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import StarterKit from "@tiptap/starter-kit";
import { MAX_HEADING_LEVEL } from "../../lib/note-markdown";
import { BlockPalette } from "./blockPalette";

/** Heading levels the note styles define, and the only ones markdown carries
 * back. Derived from the converter's ceiling rather than restated, so the
 * editor and the file cannot disagree about how deep a heading goes. */
export const NOTE_HEADING_LEVELS = Array.from(
  { length: MAX_HEADING_LEVEL },
  (_unused, index) => index + 1,
) as (1 | 2 | 3 | 4 | 5 | 6)[];

export function noteStarterKit() {
  return StarterKit.configure({
    heading: { levels: NOTE_HEADING_LEVELS },
    underline: false,
    link: {
      openOnClick: false,
      autolink: true,
      // Restricting the schemes is `isAllowedUri`, not `protocols`. The latter
      // *registers additional* schemes with linkify, so listing the three
      // built-in ones both fails to restrict anything and makes linkify warn
      // that it is already initialised. A note is text a model and a transcript
      // can write into, so `javascript:` and `data:` have no business becoming
      // a clickable link in it.
      isAllowedUri: (url, ctx) =>
        ctx.defaultValidate(url) && /^(https?:|mailto:)/i.test(url.trim()),
    },
  });
}

/** Every extension the note editor runs, minus the placeholder (which needs
 * copy the caller owns). This is what the schema is derived from. */
export function noteSchemaExtensions() {
  return [
    noteStarterKit(),
    TaskList,
    // `nested` widens a task item from `paragraph+` to `paragraph block*`, so
    // a checklist can hold a sub-checklist. A flat one is not how anybody
    // plans anything.
    TaskItem.configure({ nested: true }),
    Highlight,
  ];
}

/**
 * The schema, plus the surfaces that only make sense in a live editor. The
 * round-trip test derives its schema from {@link noteSchemaExtensions} alone,
 * so a palette cannot quietly widen what a note can hold.
 *
 * The `/` palette is desktop-only, and that is a decision rather than an
 * omission: it is a popover anchored to the caret, and on a phone the caret
 * sits just above a keyboard covering half the screen, which is exactly where
 * the popover would open. The docked toolbar offers the same blocks somewhere
 * the thumb can actually reach.
 */
export function noteEditorExtensions({ palette }: { palette: boolean }) {
  return palette ? [...noteSchemaExtensions(), BlockPalette] : noteSchemaExtensions();
}
