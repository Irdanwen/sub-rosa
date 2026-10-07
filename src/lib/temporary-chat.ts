/**
 * Temporary chats (ADR-0083), the webview side.
 *
 * A temporary chat is not saved and not remembered: Rust keeps it out of
 * every list, index, memory pass, title and synchronisation, and deletes it
 * when the person leaves it (or at the next launch). This module holds what
 * only the webview knows: whether the next new chat should be temporary,
 * which open chats are, and when one has been left.
 *
 * Kept out of `tauri.ts` (at its size ceiling); the commands live in
 * `src-tauri/src/temporary_chat/`.
 */

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import { t } from "./i18n";
import type { AgentTaskDto } from "./tauri";

type Listener = () => void;
const listeners = new Set<Listener>();
let draft = false;
/** Task ids (phone) and Hermes session ids (desktop) of temporary chats. */
const known = new Set<string>();
/** How many surfaces hold each open temporary chat right now. */
const holds = new Map<string, number>();
let version = 0;

function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the next new chat starts temporary. */
export function temporaryDraft(): boolean {
  return draft;
}

export function setTemporaryDraft(next: boolean) {
  if (draft === next) return;
  draft = next;
  changed();
}

export function useTemporaryDraft(): boolean {
  return useSyncExternalStore(subscribe, temporaryDraft, temporaryDraft);
}

export function isTemporaryChat(id: string | null | undefined): boolean {
  return Boolean(id && known.has(id));
}

export function useIsTemporaryChat(id: string | null | undefined): boolean {
  useSyncExternalStore(subscribe, () => version);
  return isTemporaryChat(id);
}

/** Records that `id` is a temporary chat, in this webview. */
export function markTemporaryChat(id: string) {
  if (known.has(id)) return;
  known.add(id);
  changed();
}

/** History lists leave temporary chats out, here as in Rust. */
export function withoutTemporaryChats<T extends { id: string }>(items: T[]): T[] {
  return known.size === 0 ? items : items.filter((item) => !known.has(item.id));
}

/** The same, except a temporary chat that is open right now: the surface
 * showing it still needs to find it in its own list. */
export function withoutLeftTemporaryChats<T extends { id: string }>(items: T[]): T[] {
  return known.size === 0
    ? items
    : items.filter((item) => !known.has(item.id) || holds.has(item.id));
}

/** The desktop sessions Rust knows to be temporary (including any an earlier
 * launch left for deletion), folded into the local set. Best effort. */
export async function loadTemporarySessions(): Promise<void> {
  try {
    const ids = await invoke<string[]>("temporary_chat_sessions");
    let added = false;
    for (const id of ids) {
      if (!known.has(id)) {
        known.add(id);
        added = true;
      }
    }
    if (added) changed();
  } catch {
    // Without the list, the sessions this webview made are still hidden.
  }
}

/** The phone's first message of a temporary chat. */
export async function createTemporaryChat(request: {
  prompt: string;
  model?: string;
}): Promise<AgentTaskDto> {
  const task = await invoke<AgentTaskDto>("temporary_chat_create", { request });
  markTemporaryChat(task.id);
  return task;
}

/** The desktop's new session, temporary from the moment Hermes names it. */
export async function registerTemporarySession(sessionId: string): Promise<void> {
  markTemporaryChat(sessionId);
  await invoke("temporary_chat_register", { sessionId });
}

/** What a new desktop session is called while the draft is temporary: it is
 * never titled from its first message. */
export function temporaryChatTitle(targetSessionId: string | undefined): string | undefined {
  return !targetSessionId && draft ? t("Temporary chat") : undefined;
}

/** Registers a session the desktop just created, when it was started as a
 * temporary chat. */
export async function registerIfTemporary(
  targetSessionId: string | undefined,
  storedSessionId: string,
): Promise<void> {
  if (!targetSessionId && draft) await registerTemporarySession(storedSessionId);
}

export type TemporaryChatKind = "task" | "session";

function discard(id: string, kind: TemporaryChatKind) {
  const request = kind === "task" ? { taskId: id } : { sessionId: id };
  void invoke("temporary_chat_discard", { request }).catch(() => {
    // Whatever is not deleted now is deleted at the next launch.
  });
}

/**
 * Holds an open temporary chat; the returned release deletes it once nothing
 * holds it any more. The deletion waits a moment, so a surface that remounts
 * (a re-render, React's development double mount) takes it back in time.
 */
export function holdTemporaryChat(id: string, kind: TemporaryChatKind): () => void {
  holds.set(id, (holds.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (holds.get(id) ?? 1) - 1;
    if (remaining > 0) {
      holds.set(id, remaining);
      return;
    }
    holds.delete(id);
    setTimeout(() => {
      if (holds.has(id)) return;
      discard(id, kind);
    }, 250);
  };
}

/** Deletes the temporary chat `id` when the surface showing it moves to
 * another chat or goes away. Does nothing for an ordinary chat. */
export function useTemporaryChatHold(id: string | null | undefined, kind: TemporaryChatKind) {
  const temporary = useIsTemporaryChat(id);
  useEffect(() => {
    if (!id || !temporary) return;
    return holdTemporaryChat(id, kind);
  }, [id, kind, temporary]);
}

/** Deletes the desktop temporary chats an earlier launch left behind, once
 * the runtime holding their sessions is up. Best effort. */
export function sweepTemporarySessions(): void {
  void invoke("temporary_chat_sweep").catch(() => undefined);
}

/** For tests. */
export function resetTemporaryChats() {
  draft = false;
  known.clear();
  holds.clear();
  changed();
}
