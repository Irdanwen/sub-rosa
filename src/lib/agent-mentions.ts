/**
 * `@` mentions: pointing the agent at a document it can already reach.
 *
 * Distinct from an attachment, and deliberately so. `/file` (and drag-drop)
 * *imports*: the file is copied into the agent's workspace and the copy is
 * what gets worked on. A mention *refers*: the file is already in the
 * session's working folder, so the agent opens the real file, in place, and
 * edits land where the user will look for them. No duplicate, no drift.
 *
 * Two rules hold this together:
 *
 * 1. **A mention never carries the document's content.** It carries a path (or
 *    a note id) and the agent reads it with its own tools if it needs to.
 *    Inlining the text would blow the context on a large file and would pin a
 *    snapshot that goes stale the moment the agent edits it.
 * 2. **Mentions stay inside the session's root**, which is the one folder the
 *    sandbox re-grants for writes. Offering a file outside it would advertise
 *    something the agent can read but never modify.
 *
 * And one rule the runtime imposes on us:
 *
 * 3. **Every path is written inside backticks.** The runtime scans the prompt
 *    text for bare absolute paths ending in an image extension and, finding
 *    one that exists on disk, attaches that file to the turn *at its native
 *    size* (`extract_image_refs` / `build_native_content_parts`). A mentioned
 *    image is already attached, resized to fit the request — so a bare path
 *    made the runtime attach the original a second time, un-resized, and two
 *    ordinary screenshots blew past every size gate on the way out. The
 *    runtime skips matches inside inline code, so backticks are the documented
 *    way to say "this is a name, not an attachment". They cost nothing: the
 *    agent still reads the path and can still act on it.
 */

export type ComposerMentionKind = "file" | "folder" | "note";

/** A row in the `@` palette. */
export type ComposerMentionItem = {
  kind: ComposerMentionKind;
  /** What the chip shows: a file name, a folder name, or a note title. */
  label: string;
  /** Secondary text in the palette row (the path relative to the root). */
  detail?: string;
  /** Absolute path, for a file or folder. */
  path?: string;
  /** Note id, for a note. */
  noteId?: string;
};

/** A mention as it survives in the composer document, and as the prompt
 * builder reads it back. */
export type ComposerMention = {
  kind: ComposerMentionKind;
  label: string;
  path?: string;
  noteId?: string;
};

/** Marks the block of resolved references appended to the runtime prompt.
 * Matched (not just written) so the transcript can hide it again — the user
 * typed "@report.md", not this. */
const MENTION_BLOCK_HEADER = "Mentioned in the message above:";
const MENTION_BLOCK_FOOTER =
  "Open these yourself when you need them: they are the real files, in place, so edits apply to the user's copy.";

/** Image extensions the runtime can actually look at. Mirrors `_IMAGE_EXTS` in
 * the pinned Hermes runtime's `agent/image_routing.py`, kept tight on purpose:
 * anything else is a document the agent opens with its file tools. */
const IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
  ".heic",
];

/**
 * True for a mention that points at an image.
 *
 * An image is the one case where a reference is not enough. Handed a path, the
 * agent has no way to know there are pixels at the other end worth looking at
 * — it reads what it can, finds bytes, and reports that it cannot see the
 * picture. A mentioned image is therefore *attached* to the turn as image
 * content (the same `image.attach_bytes` path a dragged-in photo takes), so
 * the model sees it directly.
 */
export function isImageMention(mention: ComposerMention): boolean {
  if (mention.kind !== "file" || !mention.path) return false;
  const lower = mention.path.toLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Writes a path as inline code, so the runtime reads it as a name rather than
 * as a file to attach (rule 3 in the module header). A path containing a
 * backtick would break out of the span, so those are stripped rather than
 * escaped - a filename with a backtick is vanishingly rare, and a slightly
 * wrong name the agent can still resolve beats a prompt that silently
 * re-attaches a multi-megabyte original.
 */
function quotedPath(path: string | undefined): string {
  return `\`${(path ?? "").replaceAll("`", "")}\``;
}

export function mentionItemToMention(item: ComposerMentionItem): ComposerMention {
  return {
    kind: item.kind,
    label: item.label,
    ...(item.path ? { path: item.path } : {}),
    ...(item.noteId ? { noteId: item.noteId } : {}),
  };
}

/**
 * Appends the resolved references to the text actually sent to the runtime.
 *
 * The message keeps reading as the user wrote it ("summarize @report.md");
 * the block below it turns each `@name` into something the agent can act on —
 * an absolute path, or a note id it can pass to the notes tool. Returns the
 * message untouched when nothing was mentioned.
 */
export function promptWithMentions(message: string, mentions: ComposerMention[]): string {
  if (!mentions.length) return message;
  const lines = mentions.map((mention) => {
    if (mention.kind === "note") {
      return `- Note "${mention.label}" (note id ${mention.noteId}) - read it in full with the get_note tool.`;
    }
    if (isImageMention(mention)) {
      // Say it plainly: the picture is on this turn. Without this the agent
      // sees a path ending in .png and starts looking for a way to open it.
      // The backticks are load-bearing, not cosmetic - see rule 3 above.
      return `- Image "${mention.label}": attached to this message, look at it directly. Saved at ${quotedPath(mention.path)}.`;
    }
    const what = mention.kind === "folder" ? "Folder" : "File";
    return `- ${what} "${mention.label}": ${quotedPath(mention.path)}`;
  });
  return [
    message || "Use the mentioned document(s).",
    "",
    MENTION_BLOCK_HEADER,
    ...lines,
    "",
    MENTION_BLOCK_FOOTER,
  ].join("\n");
}

/** Strips the reference block for display, so the transcript shows the message
 * the user actually typed. Mirrors the attachment block's treatment. */
export function stripMentionPromptBlock(content: string): string {
  return content
    .replace(
      new RegExp(
        `\\n+${escapeRegExp(MENTION_BLOCK_HEADER)}\\n[\\s\\S]*?\\n+${escapeRegExp(MENTION_BLOCK_FOOTER)}\\s*$`,
        "i",
      ),
      "",
    )
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** How many notes the palette offers next to the files. Files are what a
 * working folder is mostly made of, so notes stay a short tail. */
const MENTION_NOTE_LIMIT = 5;
const MENTION_FILE_LIMIT = 20;

/**
 * Builds the palette's rows for a query: files and folders under the session's
 * root, then matching notes.
 *
 * Both lookups are best-effort. A backend that cannot list the folder (no
 * session root yet) or a notes store that fails must not break the palette —
 * the user still gets whichever half answered.
 */
export async function composerMentionItems(params: {
  query: string;
  listEntries: (
    query: string,
    limit: number,
  ) => Promise<{ relativePath: string; name: string; path: string; kind: "file" | "folder" }[]>;
  listNotes: () => Promise<{ id: string; title: string }[]>;
}): Promise<ComposerMentionItem[]> {
  const query = params.query.trim();
  const [entries, notes] = await Promise.all([
    params.listEntries(query, MENTION_FILE_LIMIT).catch(() => []),
    params.listNotes().catch(() => []),
  ]);

  const fileItems: ComposerMentionItem[] = entries.map((entry) => ({
    kind: entry.kind,
    label: entry.name,
    // The row shows where it lives; a file at the root has nothing to add.
    detail: entry.relativePath === entry.name ? undefined : entry.relativePath,
    path: entry.path,
  }));

  const needle = query.toLowerCase();
  const noteItems: ComposerMentionItem[] = notes
    .filter((note) => !needle || note.title.toLowerCase().includes(needle))
    .slice(0, MENTION_NOTE_LIMIT)
    .map((note) => ({
      kind: "note" as const,
      label: note.title || "Untitled note",
      detail: "Note",
      noteId: note.id,
    }));

  return [...fileItems, ...noteItems];
}
