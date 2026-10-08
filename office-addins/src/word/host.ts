/**
 * The Word calls the pane makes (WordApi 1.1), behind a small adapter the
 * tests replace. Nothing here runs before the person confirms a proposal,
 * except reading the selection.
 */

export interface WordRange {
  text: string;
  load(properties: string): void;
  insertText(text: string, location: "Replace" | "Start" | "End" | "Before" | "After"): unknown;
}
export interface WordContext {
  document: { getSelection(): WordRange };
  sync(): Promise<void>;
}
export interface WordApi {
  run<T>(batch: (context: WordContext) => Promise<T>): Promise<T>;
}

export function wordGlobal(): WordApi | null {
  return (globalThis as { Word?: WordApi }).Word ?? null;
}

/** Paragraphs as Word inserts them: one break between paragraphs, since a
 * blank line in the reply would become an empty paragraph. */
export function wordText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .join("\n");
}

export type ReplaceOutcome = "replaced" | "changed";

export function wordHost(word: WordApi) {
  return {
    async readSelection(): Promise<string> {
      return word.run(async (context) => {
        const range = context.document.getSelection();
        range.load("text");
        await context.sync();
        return range.text ?? "";
      });
    },
    /**
     * Replaces the selection with `text`, only if it is still the passage the
     * proposal was written for: a selection moved or edited since would
     * otherwise be overwritten with a rewrite of something else.
     */
    async replaceSelection(expected: string, text: string): Promise<ReplaceOutcome> {
      return word.run(async (context) => {
        const range = context.document.getSelection();
        range.load("text");
        await context.sync();
        if ((range.text ?? "") !== expected) return "changed";
        range.insertText(wordText(text), "Replace");
        await context.sync();
        return "replaced";
      });
    },
    /** Adds `text` at the cursor, or after the selection when there is one. */
    async insert(text: string): Promise<void> {
      await word.run(async (context) => {
        const range = context.document.getSelection();
        range.load("text");
        await context.sync();
        range.insertText(wordText(text), range.text ? "After" : "End");
        await context.sync();
      });
    },
  };
}
export type WordHost = ReturnType<typeof wordHost>;
