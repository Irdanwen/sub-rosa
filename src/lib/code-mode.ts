/**
 * Code mode (ADR-0090), desktop only: a chat with a working folder (ADR-0014)
 * whose file changes are reviewed one by one, each kept or reverted. Rust
 * holds the record of where the folder started (`src-tauri/src/code_review/`)
 * and is the only thing that touches the folder; this module asks it and
 * tells the agent, with each message, that it is working on code there.
 */

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { messageFromError } from "./errors";

export type CodeReviewStatus = {
  active: boolean;
  folder?: string | null;
  base?: "git" | "snapshot" | null;
  startedAt?: string | null;
};

export type FileChange = {
  path: string;
  status: "added" | "modified" | "deleted";
  /** Unified diff; absent for a binary file. */
  diff?: string | null;
  additions: number;
  deletions: number;
  binary: boolean;
  revertible: boolean;
  truncated: boolean;
};

export type CodeReviewChanges = {
  status: CodeReviewStatus;
  changes: FileChange[];
  truncated: boolean;
};

export const CODE_MODE_CHANGED_EVENT = "subrosa:code-mode-changed";
const CONTEXT_MARKER = "--- Attached Context ---";

function changed(sessionId: string) {
  window.dispatchEvent(new CustomEvent(CODE_MODE_CHANGED_EVENT, { detail: sessionId }));
}

export async function startCodeMode(sessionId: string, folder: string): Promise<CodeReviewStatus> {
  const status = await invoke<CodeReviewStatus>("code_review_start", {
    request: { sessionId, folder },
  });
  changed(sessionId);
  return status;
}

/** Turns Code mode off. The record goes; the folder is left as it is. */
export async function stopCodeMode(sessionId: string): Promise<void> {
  await invoke<void>("code_review_stop", { request: { sessionId } });
  changed(sessionId);
}

export function codeModeStatus(sessionId: string): Promise<CodeReviewStatus> {
  return invoke<CodeReviewStatus>("code_review_status", { request: { sessionId } });
}

export function codeReviewChanges(sessionId: string): Promise<CodeReviewChanges> {
  return invoke<CodeReviewChanges>("code_review_changes", { request: { sessionId } });
}

export function keepChange(sessionId: string, path: string): Promise<void> {
  return invoke<void>("code_review_keep", { request: { sessionId, path } });
}

export function revertChange(sessionId: string, path: string): Promise<void> {
  return invoke<void>("code_review_revert", { request: { sessionId, path } });
}

/** The session's Code mode, kept current across the components showing it. */
export function useCodeMode(sessionId: string | null | undefined) {
  const [status, setStatus] = useState<CodeReviewStatus>({ active: false });
  const refresh = useCallback(() => {
    if (!sessionId) {
      setStatus({ active: false });
      return;
    }
    void codeModeStatus(sessionId)
      .then(setStatus)
      .catch(() => setStatus({ active: false }));
  }, [sessionId]);
  useEffect(() => {
    refresh();
    const onChange = (event: Event) => {
      if ((event as CustomEvent<string>).detail === sessionId) refresh();
    };
    window.addEventListener(CODE_MODE_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(CODE_MODE_CHANGED_EVENT, onChange);
  }, [refresh, sessionId]);
  return { status, refresh };
}

/** What the agent is told with each message of a chat in Code mode. Model
 * instructions, not copy a person reads. */
export function codeModeBlock(folder: string): string {
  return [
    `Code mode is on for this chat. The working folder ${folder} is a code project, and the user wants you to work on it.`,
    "Make changes by editing the files in place there, with your file tools, or by driving the user's installed Claude Code or Codex CLI when they ask for it or the task is large.",
    "Read the code before changing it, keep changes to what was asked, and run the project's tests or build when there is one.",
    "Every file you change is listed for the user in a review panel where they keep or revert each one, so do not revert, stash or commit unless asked, and end with a short list of the files you changed and why.",
  ].join(" ");
}

/** Adds the Code mode block to a message when the chat is in Code mode on
 * the folder it works in. Never fails a send. */
export async function withCodeContext(
  text: string,
  sessionId?: string | null,
  workingDir?: string | null,
): Promise<string> {
  if (!sessionId || !workingDir) return text;
  try {
    const status = await codeModeStatus(sessionId);
    if (!status.active || status.folder !== workingDir) return text;
    const separator = text.includes(CONTEXT_MARKER) ? "\n\n" : `\n\n${CONTEXT_MARKER}\n\n`;
    return `${text}${separator}${codeModeBlock(workingDir)}`;
  } catch {
    return text;
  }
}

/* ------------------------------------------------------------------ *
 * Code mode chosen before a chat exists
 *
 * A new chat has no session id until its first message creates one, and the
 * record of where the folder started is filed under that id. So the choice
 * made in the new-chat composer is held here, for the folder it was made on,
 * and taken up the moment the session exists, before the first message
 * reaches the agent: the start is recorded before anything can change.
 * ------------------------------------------------------------------ */

let draftFolder: string | null = null;
const draftListeners = new Set<() => void>();

function draftChanged() {
  for (const listener of draftListeners) listener();
}

/** Turns Code mode on (a folder) or off (null) for the chat about to start. */
export function setCodeModeDraft(folder: string | null): void {
  if (draftFolder === folder) return;
  draftFolder = folder;
  draftChanged();
}

/** Whether the new chat will start in Code mode on `folder`. */
export function codeModeDraftFor(folder: string | null | undefined): boolean {
  return Boolean(folder) && draftFolder === folder;
}

/** The folder the new chat will start Code mode on, kept current. */
export function useCodeModeDraft(): string | null {
  return useSyncExternalStore(
    (listener) => {
      draftListeners.add(listener);
      return () => draftListeners.delete(listener);
    },
    () => draftFolder,
  );
}

/** The first message of a new chat, with the Code mode block when the chat
 * starts in Code mode on its folder. */
export function withCodeDraftContext(text: string, folder?: string | null): string {
  if (!folder || !codeModeDraftFor(folder)) return text;
  const separator = text.includes(CONTEXT_MARKER) ? "\n\n" : `\n\n${CONTEXT_MARKER}\n\n`;
  return `${text}${separator}${codeModeBlock(folder)}`;
}

/** Why the last chat that should have started in Code mode did not, by
 * session, for the session bar's button to say. */
const draftFailures = new Map<string, string>();

export function codeModeStartFailure(sessionId: string): string | undefined {
  return draftFailures.get(sessionId);
}

/**
 * The new chat's session now exists: records where its folder starts when
 * Code mode was chosen for that folder, then clears the choice (the next new
 * chat starts without it). Never fails a send; a refusal is kept for the
 * session bar's Code button, which stays off.
 */
export async function adoptCodeModeDraft(
  sessionId: string,
  folder: string | null | undefined,
): Promise<void> {
  const chosen = codeModeDraftFor(folder);
  setCodeModeDraft(null);
  if (!chosen || !folder) return;
  try {
    await startCodeMode(sessionId, folder);
  } catch (cause) {
    draftFailures.set(sessionId, messageFromError(cause));
    changed(sessionId);
  }
}

/** One line of a unified diff, for colouring. */
export function diffLineKind(line: string): "add" | "remove" | "hunk" | "header" | "context" {
  if (line.startsWith("+++") || line.startsWith("---")) return "header";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}
