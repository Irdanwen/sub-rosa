/**
 * The `subrosa:canvas` chat block: its shape and its parser (ADR-0087).
 *
 * Kept apart from `canvas.ts`, which opens canvases and so reaches the notes
 * and the chat-block module; `chat-blocks.ts` imports this file to parse the
 * fence, and must not import its own importers back. Shared with the web
 * client; the fallback title is each surface's own word.
 */

/** A title from the first line of some markdown, without its markers. */
export function firstLineTitle(markdown: string, max = 80): string {
  const line =
    markdown
      .split("\n")
      .map((value) =>
        value
          .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)]|>|`{3,}\S*)\s*/, "")
          .replace(/[*_`~=]/g, "")
          .trim(),
      )
      .find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export type CanvasKind = "document" | "code";

export type CanvasChatBlock = {
  kind: "canvas";
  title: string;
  canvasKind: CanvasKind;
  language?: string;
  content: string;
  /** A canvas the reply proposes a new version of. Untrusted: checked against
   * the notes on the device before anything is shown. */
  noteId?: string;
};

const MAX_TITLE = 120;
const MAX_LANGUAGE = 32;
/** The note rewrite's own ceiling (`note_ai::MAX_SELECTION_CHARS`): a canvas
 * longer than that could be opened but never edited by the assistant. */
export const MAX_CANVAS_CHARS = 24_000;

/** Parses a `subrosa:canvas` payload (already JSON-decoded, `v` checked). */
export function parseCanvasPayload(
  payload: Record<string, unknown>,
  fallbackTitle = "Canvas",
): CanvasChatBlock | null {
  const content = typeof payload.content === "string" ? payload.content : "";
  if (!content.trim() || content.length > MAX_CANVAS_CHARS) return null;
  const title =
    typeof payload.title === "string" && payload.title.trim()
      ? payload.title.trim().slice(0, MAX_TITLE)
      : firstLineTitle(content) || fallbackTitle;
  const canvasKind: CanvasKind = payload.kind === "code" ? "code" : "document";
  const language =
    canvasKind === "code" &&
    typeof payload.language === "string" &&
    /^[\w+#.-]{1,32}$/.test(payload.language.trim())
      ? payload.language.trim().slice(0, MAX_LANGUAGE).toLowerCase()
      : undefined;
  const noteId =
    typeof payload.noteId === "string" && /^[\w-]{1,64}$/.test(payload.noteId)
      ? payload.noteId
      : undefined;
  return {
    kind: "canvas",
    title,
    canvasKind,
    ...(language ? { language } : {}),
    content,
    ...(noteId ? { noteId } : {}),
  };
}

/** One fenced block, its fence one backtick longer than any run inside it. */
export function codeFence(code: string, language?: string): string {
  let longest = 2;
  for (const run of code.match(/^`{3,}/gm) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(longest + 1);
  return `${fence}${language ?? ""}\n${code.replace(/\n+$/, "")}\n${fence}`;
}

/** What a canvas block puts in the note. */
export function canvasMarkdown(
  block: Pick<CanvasChatBlock, "canvasKind" | "language" | "content">,
) {
  return block.canvasKind === "code" ? codeFence(block.content, block.language) : block.content;
}
