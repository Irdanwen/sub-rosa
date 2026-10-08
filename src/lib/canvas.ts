import { type CanvasChatBlock, canvasMarkdown } from "./canvas-block";
import { chatBlocksToClipboardText } from "./chat-blocks";
import { t } from "./i18n";
import { replyTitle } from "./chat-library";
import { markdownToDoc } from "./note-markdown";
import { createNote, getNote, updateNote } from "./tauri";

export type { CanvasChatBlock, CanvasKind } from "./canvas-block";
export { canvasMarkdown, codeFence, parseCanvasPayload } from "./canvas-block";

/**
 * The canvas: a note opened beside the chat (ADR-0087).
 *
 * There is no canvas document format. A canvas *is* a note, edited by the
 * note editor and stored by the markdown seam (ADR-0037), so it is searchable,
 * readable by the assistant and exportable like every other note, and it
 * survives the chat that opened it. A code canvas is a note whose body is one
 * fenced code block.
 *
 * The assistant reaches it two ways, both proposals (ADR-0038): a
 * `subrosa:canvas` block in a reply, which the person opens; and, once a
 * canvas is open, an instruction typed under it, which comes back as a whole
 * new version to accept or discard. Nothing the model writes lands in the
 * note without that gesture.
 */

/** A code canvas is a note that is one code block and nothing else. */
export function codeOfCanvas(markdown: string): { code: string; language?: string } | null {
  const doc = markdownToDoc(markdown);
  const blocks = doc.content ?? [];
  if (blocks.length !== 1 || blocks[0].type !== "codeBlock") return null;
  const block = blocks[0];
  const language =
    typeof block.attrs?.language === "string" && block.attrs.language
      ? block.attrs.language
      : undefined;
  return { code: block.content?.[0]?.text ?? "", ...(language ? { language } : {}) };
}

/* ------------------------------------------------------------------ *
 * Opening one
 * ------------------------------------------------------------------ */

/** Each shell's root answers this: the desktop opens the canvas beside the
 * chat, the phone pushes it as a screen. */
export const OPEN_CANVAS_EVENT = "subrosa:open-canvas";

export type OpenCanvasDetail = {
  noteId: string;
  /** A whole new version the assistant proposes, shown for review. */
  proposal?: string;
};

export function openCanvas(detail: OpenCanvasDetail) {
  window.dispatchEvent(new CustomEvent<OpenCanvasDetail>(OPEN_CANVAS_EVENT, { detail }));
}

const OPENED_KEY = "os-june:canvas-notes";
const MAX_REMEMBERED = 200;

/** Which note a block or a reply was opened into, so opening it again goes
 * back to the same canvas instead of making a second note. A convenience: if
 * it is lost, the next open makes a new note and nothing else breaks. */
function rememberedNote(key: string): string | undefined {
  try {
    const map = JSON.parse(localStorage.getItem(OPENED_KEY) ?? "{}") as Record<string, string>;
    return typeof map[key] === "string" ? map[key] : undefined;
  } catch {
    return undefined;
  }
}

function rememberNote(key: string, noteId: string) {
  try {
    const map = JSON.parse(localStorage.getItem(OPENED_KEY) ?? "{}") as Record<string, string>;
    map[key] = noteId;
    const entries = Object.entries(map).slice(-MAX_REMEMBERED);
    localStorage.setItem(OPENED_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage is a convenience here.
  }
}

async function noteExists(noteId: string) {
  try {
    await getNote(noteId);
    return true;
  } catch {
    return false;
  }
}

/** Makes the note a canvas lives in. */
export async function createCanvasNote(title: string, markdown: string): Promise<string> {
  const note = await createNote();
  await updateNote({ noteId: note.id, title, editedContent: markdown });
  return note.id;
}

async function openAs(key: string, title: string, markdown: string) {
  const remembered = rememberedNote(key);
  if (remembered && (await noteExists(remembered))) {
    openCanvas({ noteId: remembered });
    return remembered;
  }
  const noteId = await createCanvasNote(title, markdown);
  rememberNote(key, noteId);
  openCanvas({ noteId });
  return noteId;
}

/**
 * Opens a `subrosa:canvas` block. A block naming a canvas that exists on this
 * device is a proposed new version of it, opened for review; any other block
 * becomes a new canvas note.
 */
export async function openCanvasBlock(block: CanvasChatBlock): Promise<string> {
  const markdown = canvasMarkdown(block);
  if (block.noteId && (await noteExists(block.noteId))) {
    openCanvas({ noteId: block.noteId, proposal: markdown });
    return block.noteId;
  }
  return openAs(`block:${block.title}:${markdown}`, block.title, markdown);
}

/** "Open in canvas" on a reply: the reply, cards turned to plain lists. */
export async function openReplyInCanvas(input: {
  text: string;
  conversationId?: string;
  messageId?: string;
}): Promise<string> {
  const markdown = chatBlocksToClipboardText(input.text).trim();
  const key = input.messageId
    ? `reply:${input.conversationId ?? "chat"}:${input.messageId}`
    : `reply-text:${markdown}`;
  return openAs(key, replyTitle(markdown) || t("Canvas"), markdown);
}
