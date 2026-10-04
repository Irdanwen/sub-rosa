// What is being written about an assistant survives leaving the screen: a
// tab switch unmounts it (the shell keys screens by tab and depth), and the
// phone may drop the whole webview while it is in the background. The
// drafts live in this device's storage only: they are a convenience, never
// the assistant (which is saved, and synchronised, by the Rust process).

import type { AssistantDefinition } from "./assistants";

const PREFIX = "subrosa:assistant-draft:";

/** An editor's unsaved definition, and the revision it was written against. */
export type EditorDraft = {
  definition: AssistantDefinition;
  /** The saved revision the edits started from; 0 for a new assistant. */
  baseRevision: number;
};

/** The guided creator's answers so far. */
export type CreatorDraft = {
  idea: string;
  /** -1 on the idea, then the index of the question on screen. */
  step: number;
  answers: Record<string, string[]>;
  freeAnswers: Record<string, string>;
};

function keyOf(id: string): string {
  return `${PREFIX}${id || "new"}`;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be full or unavailable; the screen still holds the edits.
  }
}

function remove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to forget.
  }
}

/**
 * The unsaved edits of an assistant (`""` for a new one), when they still
 * apply: edits written against an older revision are dropped, since the
 * assistant has been saved since (here or on another device) and restoring
 * them would silently undo that save.
 */
export function readEditorDraft(id: string, savedRevision: number): EditorDraft | null {
  const draft = read<EditorDraft>(keyOf(id));
  if (!draft?.definition || typeof draft.baseRevision !== "number") return null;
  if (draft.baseRevision !== savedRevision) {
    remove(keyOf(id));
    return null;
  }
  return draft;
}

export function writeEditorDraft(id: string, draft: EditorDraft) {
  write(keyOf(id), draft);
}

export function clearEditorDraft(id: string) {
  remove(keyOf(id));
}

const CREATOR_KEY = `${PREFIX}creator`;

export function readCreatorDraft(): CreatorDraft | null {
  const draft = read<CreatorDraft>(CREATOR_KEY);
  return draft && typeof draft.idea === "string" && typeof draft.step === "number" ? draft : null;
}

export function writeCreatorDraft(draft: CreatorDraft) {
  write(CREATOR_KEY, draft);
}

export function clearCreatorDraft() {
  remove(CREATOR_KEY);
}
