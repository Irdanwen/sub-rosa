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

/** Deltas of an answer on the way: `{ requestId, phase: "delta", text }`. */
export const ASK_EVENT = "june://ask";

export type AskDeltaEvent = { requestId: string; phase: "delta"; text: string };

/**
 * Ask your notes: an answer from the corpus, every claim cited. With a
 * request id the words arrive as ASK_EVENT deltas while the whole answer,
 * citations resolved, is still the returned value.
 */
export async function askNotes(question: string, requestId?: string): Promise<AskAnswerDto> {
  return invoke<AskAnswerDto>("ask_notes", { request: { question, requestId } });
}

/** Stop an answer on the way; a request already finished is not an error. */
export async function askCancel(requestId: string): Promise<void> {
  return invoke<void>("ask_cancel", { request: { requestId } });
}

export type AskSettingsDto = {
  /** Cut and embed passages so questions match by meaning (ADR-0046). */
  semantic: boolean;
};

export type AskIndexStatusDto = {
  settings: AskSettingsDto;
  /** Passages cut from the notes so far. */
  passages: number;
  /** Of those, the ones that carry a vector. */
  embedded: number;
};

export async function askIndexStatus(): Promise<AskIndexStatusDto> {
  return invoke<AskIndexStatusDto>("ask_index_status");
}

/** Turning it off forgets every passage and vector. */
export async function setAskSettings(settings: AskSettingsDto): Promise<AskIndexStatusDto> {
  return invoke<AskIndexStatusDto>("set_ask_settings", { request: settings });
}
