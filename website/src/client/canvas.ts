/**
 * The canvas in the browser (ADR-0087): a canvas is a note, opened beside the
 * chat. The assistant proposes, the person applies (ADR-0038):
 *
 * - a `subrosa:canvas` block opens as a new note only when the person taps
 *   it; with the `noteId` of a note this account has, it is a proposed new
 *   version, shown for review in place of the document until accepted or
 *   discarded (an id it does not know is a new draft, never trusted);
 * - an instruction under an open canvas runs the note rewrite of kind
 *   `canvas` over the whole document, Rust's prompt (`agent-lite.json`
 *   `editing.canvas`), streamed into the same review, and lands only on
 *   Accept, as one write.
 */
import {
  type CanvasChatBlock,
  canvasMarkdown,
  firstLineTitle,
} from "@subrosa/chat-core/canvas-block";
import { type Operator, streamCompletion } from "./carpe-diem";
import { AGENT_LITE, timestamp } from "./codec";
import { createNote, listNotes, type Note } from "./library";
import type { SyncClient } from "./sync";

/** A note the block may propose a version of, or null for a new draft. */
export function canvasTarget(sync: SyncClient, block: CanvasChatBlock): Note | null {
  if (!block.noteId) return null;
  return listNotes(sync).find((note) => note.id === block.noteId) ?? null;
}

/** Opens a block as a new canvas: an ordinary note, made on this tap. */
export async function openCanvas(sync: SyncClient, block: CanvasChatBlock): Promise<string> {
  const note = await createNote(sync, block.title, canvasMarkdown(block));
  return note.id;
}

/** Writes an accepted version: one write of the whole document. */
export async function applyCanvas(
  sync: SyncClient,
  noteId: string,
  content: string,
  title?: string,
) {
  const note = sync.objects.get(noteId);
  if (!note || note.deleted || note.table !== "notes") throw new Error("This canvas is gone.");
  await sync.write("notes", {
    ...note.row,
    ...(title?.trim() ? { title: title.trim().slice(0, 200) } : {}),
    edited_content: content,
    updated_at: timestamp(),
  });
}

export class CanvasError extends Error {
  constructor(public code: "empty" | "too_long" | "no_instruction") {
    super(code);
  }
}

/** The request of `note_ai::rewrite` for a canvas: Rust's rules, the task,
 * the instruction kept apart from the document it applies to. */
export function canvasRewriteBody(model: string, document: string, instruction: string) {
  const words = AGENT_LITE.editing.canvas;
  const chars = Array.from(document).length;
  if (!document.trim()) throw new CanvasError("empty");
  if (chars > words.maxChars) throw new CanvasError("too_long");
  if (!instruction.trim()) throw new CanvasError("no_instruction");
  const message = words.message
    .split("{instruction}")
    .join(instruction.trim())
    .split("{document}")
    .join(document);
  return {
    model,
    temperature: words.temperature,
    max_tokens: Math.min(16_000, Math.max(2048, chars * 2)),
    messages: [
      { role: "system" as const, content: words.system },
      { role: "user" as const, content: message },
    ],
  };
}

/** Streams a proposed version; nothing is written. */
export async function rewriteCanvas(
  operator: Operator,
  key: string,
  model: string,
  document: string,
  instruction: string,
  onText: (sofar: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  let sofar = "";
  const reply = await streamCompletion(
    operator,
    key,
    canvasRewriteBody(model, document, instruction),
    (fragment) => {
      sofar += fragment;
      onText(sofar);
    },
    signal,
  );
  return reply.content;
}

export { firstLineTitle };
