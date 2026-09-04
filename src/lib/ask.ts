import { invoke } from "@tauri-apps/api/core";

/** A passage that was sent to answer a question, and can be cited. */
export type AskSourceDto = {
  index: number;
  noteId: string;
  title: string;
  kind: string;
  excerpt: string;
};

export type AskAnswerDto = {
  answer: string;
  citations: AskSourceDto[];
  sent: AskSourceDto[];
  invented: number[];
  promptVersion: number;
};

/** Ask your notes: an answer from the corpus, every claim cited. */
export async function askNotes(question: string): Promise<AskAnswerDto> {
  return invoke<AskAnswerDto>("ask_notes", { request: { question } });
}
