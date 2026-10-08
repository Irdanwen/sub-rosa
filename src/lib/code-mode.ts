/**
 * Code mode (ADR-0090), desktop only: a chat with a working folder (ADR-0014)
 * whose file changes are reviewed one by one, each kept or reverted. Rust
 * holds the record of where the folder started (`src-tauri/src/code_review/`)
 * and is the only thing that touches the folder; this module asks it and
 * tells the agent, with each message, that it is working on code there.
 */

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

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

/** One line of a unified diff, for colouring. */
export function diffLineKind(line: string): "add" | "remove" | "hunk" | "header" | "context" {
  if (line.startsWith("+++") || line.startsWith("---")) return "header";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}
