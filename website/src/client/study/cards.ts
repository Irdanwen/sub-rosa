/**
 * Study mode and the review in the browser (ADR-0089), kept in the study
 * feature's sealed store: which chats are in study mode, and the cards added
 * to review with their schedule. Like the app's `study_chats` and
 * `study_cards`, none of it is synchronised.
 */
import type { FeatureStore } from "../feature";
import { type CardState, type Grade, NEW_CARD, review, STUDY } from "./schedule";

export interface StudyCard extends CardState {
  id: string;
  front: string;
  back: string;
  deck: string | null;
  chatId: string | null;
  dueAt: string;
  lastReviewedAt: string | null;
  createdAt: string;
}
export interface StudyStats {
  total: number;
  due: number;
  /** When the next card not yet due comes back. */
  nextDueAt: string | null;
}

const stamp = (at: Date) => at.toISOString();

export async function isStudyChat(store: FeatureStore, chatId: string): Promise<boolean> {
  return (await store.get<boolean>(`chat:${chatId}`)) === true;
}

export async function setStudyChat(store: FeatureStore, chatId: string, on: boolean) {
  if (!chatId.trim()) throw new Error("Open a chat first.");
  if (on) await store.put(`chat:${chatId}`, true);
  else await store.delete(`chat:${chatId}`);
}

/** `study::card_key`: the same front and back, however spaced or cased, is
 * the same card. */
export async function cardKey(front: string, back: string): Promise<string> {
  const normal = (text: string) => text.split(/\s+/).filter(Boolean).join(" ").toLowerCase();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${normal(front)}\u001f${normal(back)}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const side = (text: string) => Array.from(text.trim()).slice(0, STUDY.maxSideChars).join("");

/** `study::add_cards`: new cards due now; a card already in review is not
 * added twice. Throws when there is nothing to add or too much at once. */
export async function addCards(
  store: FeatureStore,
  cards: { front: string; back: string }[],
  options: { deck?: string | null; chatId?: string | null } = {},
  now = new Date(),
): Promise<{ added: number; already: number }> {
  const clean = cards
    .map((card) => ({ front: side(card.front), back: side(card.back) }))
    .filter((card) => card.front && card.back);
  if (!clean.length || clean.length > STUDY.maxCardsPerAdd)
    throw new Error("These cards cannot be added to your review.");
  const deck =
    Array.from(options.deck?.trim() ?? "")
      .slice(0, STUDY.maxDeckChars)
      .join("") || null;
  let added = 0;
  let already = 0;
  for (const card of clean) {
    const id = await cardKey(card.front, card.back);
    if (await store.get(`card:${id}`)) {
      already++;
      continue;
    }
    await store.put(`card:${id}`, {
      ...NEW_CARD,
      id,
      front: card.front,
      back: card.back,
      deck,
      chatId: options.chatId ?? null,
      dueAt: stamp(now),
      lastReviewedAt: null,
      createdAt: stamp(now),
    } satisfies StudyCard);
    added++;
  }
  return { added, already };
}

export async function allCards(store: FeatureStore): Promise<StudyCard[]> {
  return (await store.list<StudyCard>("card:")).map((entry) => entry.value);
}

/** The cards due at `now`, the most overdue first. */
export async function dueCards(store: FeatureStore, now = new Date(), limit = 100) {
  const at = stamp(now);
  return (await allCards(store))
    .filter((card) => card.dueAt <= at)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit);
}

export async function reviewCard(
  store: FeatureStore,
  id: string,
  grade: Grade,
  now = new Date(),
): Promise<StudyCard> {
  const card = await store.get<StudyCard>(`card:${id}`);
  if (!card) throw new Error("This card is no longer in your review.");
  const { next, due } = review(card, grade, now);
  const updated: StudyCard = { ...card, ...next, dueAt: stamp(due), lastReviewedAt: stamp(now) };
  await store.put(`card:${id}`, updated);
  return updated;
}

export async function deleteCard(store: FeatureStore, id: string) {
  await store.delete(`card:${id}`);
}

export async function studyStats(store: FeatureStore, now = new Date()): Promise<StudyStats> {
  const at = stamp(now);
  const cards = await allCards(store);
  const later = cards
    .map((card) => card.dueAt)
    .filter((due) => due > at)
    .sort();
  return {
    total: cards.length,
    due: cards.filter((card) => card.dueAt <= at).length,
    nextDueAt: later[0] ?? null,
  };
}
