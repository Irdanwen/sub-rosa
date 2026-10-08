import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";

/**
 * Study mode and the review (ADR-0089), for both shells.
 *
 * A chat is in study mode when the Rust side has a row for it
 * (`study_chats`), so a regenerated reply or a turn the background sweep
 * finishes reads the same mode the person chose. Before a chat exists, the
 * composer's switch is a draft: the first message is sent in study mode, and
 * the chat that message creates is marked as soon as its id is known.
 *
 * The phone's prompt reads the row every turn. The desktop's runtime has one
 * SOUL for every chat, so its messages carry the tutoring text after the
 * attached-context marker while the mode is on (the seam a project uses,
 * ADR-0085), which the transcript and memory extraction already strip.
 */

export type StudyCard = {
  id: string;
  front: string;
  back: string;
  deck?: string | null;
  ease: number;
  intervalDays: number;
  repetitions: number;
  lapses: number;
  dueAt: string;
  lastReviewedAt?: string | null;
  createdAt: string;
};

export type StudyStats = { total: number; due: number; nextDueAt?: string | null };
export type StudyGrade = "again" | "hard" | "good" | "easy";

const CONTEXT_MARKER = "--- Attached Context ---";
const DRAFT = "";

/* ------------------------------------------------------------------ *
 * The mode, per chat
 * ------------------------------------------------------------------ */

const modes = new Map<string, boolean>();
/** Chats switched on this screen: what the person chose wins over a read
 * that was already on its way. */
const chosen = new Set<string>();
const listeners = new Set<() => void>();
/** A message was sent in study mode before its chat had an id. */
let armed = false;
let prompt: string | null = null;

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a chat (or, without one, the new chat's draft) is in study mode. */
export function studyOn(chatId?: string | null): boolean {
  return modes.get(chatId || DRAFT) ?? false;
}

export async function setStudyMode(chatId: string | null | undefined, on: boolean): Promise<void> {
  const key = chatId || DRAFT;
  modes.set(key, on);
  chosen.add(key);
  notify();
  if (!chatId) return;
  try {
    await invoke<boolean>("study_mode", { request: { chatId, on } });
  } catch {
    // The switch still shows what the person chose; the next toggle retries.
  }
}

async function loadStudyMode(chatId: string): Promise<void> {
  try {
    const on = await invoke<boolean>("study_mode", { request: { chatId } });
    if (!chosen.has(chatId) && modes.get(chatId) !== on) {
      modes.set(chatId, on);
      notify();
    }
  } catch {
    // Unknown stays off.
  }
}

/** The new chat a draft in study mode created is in study mode too. Awaited
 * by the phone before its first turn runs, since that turn reads the row. */
export async function studyChatStarted(chatId: string): Promise<void> {
  if (!armed && !studyOn(DRAFT)) return;
  armed = false;
  modes.set(DRAFT, false);
  await setStudyMode(chatId, true);
}

/** The mode of the chat on screen, kept current. A draft that was sent in
 * study mode follows the chat it created (the desktop learns the id late). */
export function useStudyMode(chatId?: string | null): boolean {
  useEffect(() => {
    if (!chatId) return;
    if (armed) {
      void studyChatStarted(chatId);
      return;
    }
    void loadStudyMode(chatId);
  }, [chatId]);
  return useSyncExternalStore(subscribe, () => studyOn(chatId));
}

async function studyPrompt(): Promise<string> {
  if (prompt === null) prompt = await invoke<string>("study_prompt");
  return prompt;
}

/**
 * The desktop's message with the tutoring text attached while the chat is
 * in study mode. Never throws: a message must not fail for its mode.
 */
export async function withStudyContext(text: string, chatId?: string | null): Promise<string> {
  if (!studyOn(chatId)) return text;
  if (!chatId) armed = true;
  try {
    const block = await studyPrompt();
    const separator = text.includes(CONTEXT_MARKER) ? "\n\n" : `\n\n${CONTEXT_MARKER}\n\n`;
    return `${text}${separator}${block}`;
  } catch {
    return text;
  }
}

/* ------------------------------------------------------------------ *
 * The review
 * ------------------------------------------------------------------ */

export const STUDY_CARDS_CHANGED_EVENT = "subrosa:study-cards-changed";

function cardsChanged() {
  window.dispatchEvent(new Event(STUDY_CARDS_CHANGED_EVENT));
}

export async function addStudyCards(
  cards: { front: string; back: string }[],
  deck?: string,
  chatId?: string,
): Promise<{ added: number; already: number }> {
  const result = await invoke<{ added: number; already: number }>("study_cards_add", {
    request: { cards, deck, chatId },
  });
  cardsChanged();
  return result;
}

export function dueStudyCards(limit = 100): Promise<StudyCard[]> {
  return invoke<StudyCard[]>("study_cards_due", { limit });
}

export async function reviewStudyCard(id: string, grade: StudyGrade): Promise<StudyCard> {
  const card = await invoke<StudyCard>("study_card_review", { request: { id, grade } });
  cardsChanged();
  return card;
}

export async function deleteStudyCard(id: string): Promise<void> {
  await invoke<void>("study_card_delete", { id });
  cardsChanged();
}

export function studyStats(): Promise<StudyStats> {
  return invoke<StudyStats>("study_cards_stats");
}

/** For tests: forget every mode and the cached prompt. */
export function resetStudyModes() {
  modes.clear();
  chosen.clear();
  armed = false;
  prompt = null;
  notify();
}
