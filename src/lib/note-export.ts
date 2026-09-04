import { invoke } from "@tauri-apps/api/core";

export type ExportNoteMarkdownResult = {
  /** Where the file went, or null when the dialog was dismissed. */
  path: string | null;
  bytes: number;
};

/** Save a note as a Markdown file where the native dialog points (desktop). */
export async function exportNoteMarkdown(noteId: string): Promise<ExportNoteMarkdownResult> {
  return invoke<ExportNoteMarkdownResult>("export_note_markdown", { request: { noteId } });
}
