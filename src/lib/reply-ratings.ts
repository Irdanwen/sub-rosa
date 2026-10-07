// A thumbs up or down on a chat reply, with an optional reason on a thumbs
// down. Kept on this device only (ADR-0082): `src-tauri/src/reply_ratings.rs`
// stores them in a table no sync trigger reads, and nothing here sends them.
//
// The ratings of a conversation are read once, the first time one of its
// replies asks, and kept in memory; a change is shown at once and undone if
// the store refuses it.

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { t } from "./i18n";

export type ReplyRatingValue = "up" | "down";

/** Why a reply was rated down, by id. Kept equal to `DOWN_REASONS` in Rust. */
export const DOWN_REASONS = [
  "not_accurate",
  "not_helpful",
  "too_long",
  "wrong_language",
  "other",
] as const;
export type DownReason = (typeof DOWN_REASONS)[number];

/** A free-text reason is a sentence. Equal to `MAX_NOTE_CHARS` in Rust. */
export const MAX_REASON_NOTE_CHARS = 500;

export type ReplyRatingDto = {
  conversationId: string;
  messageId: string;
  rating: ReplyRatingValue;
  reason?: DownReason | null;
  note?: string | null;
  updatedAt: string;
};

export function downReasonLabel(reason: DownReason): string {
  switch (reason) {
    case "not_accurate":
      return t("Not accurate");
    case "not_helpful":
      return t("Not helpful");
    case "too_long":
      return t("Too long");
    case "wrong_language":
      return t("Wrong language");
    default:
      return t("Other");
  }
}

export function listReplyRatings(conversationId: string): Promise<ReplyRatingDto[]> {
  return invoke<ReplyRatingDto[]>("reply_ratings_list", { request: { conversationId } });
}

export type ReplyRatingChange = {
  rating: ReplyRatingValue | null;
  reason?: DownReason | null;
  note?: string | null;
};

export function setReplyRating(
  conversationId: string,
  messageId: string,
  change: ReplyRatingChange,
): Promise<ReplyRatingDto | null> {
  return invoke<ReplyRatingDto | null>("reply_rating_set", {
    request: {
      conversationId,
      messageId,
      rating: change.rating,
      reason: change.reason ?? null,
      note: change.note ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// The in-memory copy the reply rows read.

type ConversationRatings = Map<string, ReplyRatingDto>;

const store = new Map<string, ConversationRatings>();
const requested = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function put(conversationId: string, messageId: string, rating: ReplyRatingDto | undefined) {
  const ratings = new Map(store.get(conversationId) ?? []);
  if (rating) ratings.set(messageId, rating);
  else ratings.delete(messageId);
  store.set(conversationId, ratings);
  changed();
}

function load(conversationId: string) {
  if (requested.has(conversationId)) return;
  requested.add(conversationId);
  void listReplyRatings(conversationId)
    .then((rows) => {
      // A rating made while the list was on its way wins over the list.
      const current = store.get(conversationId);
      const next: ConversationRatings = new Map(rows.map((row) => [row.messageId, row]));
      for (const [messageId, row] of current ?? []) next.set(messageId, row);
      store.set(conversationId, next);
      changed();
    })
    .catch(() => {
      // A rating is a convenience: unread, the thumbs simply show unset.
      requested.delete(conversationId);
    });
}

/** Forgets what was read, so the next reader asks the store again. Tests. */
export function resetReplyRatingsCache() {
  store.clear();
  requested.clear();
  changed();
}

/** One reply's rating, and the change that records, replaces or clears it. */
export function useReplyRating(conversationId: string | undefined, messageId: string) {
  useEffect(() => {
    if (conversationId) load(conversationId);
  }, [conversationId]);
  useSyncExternalStore(subscribe, () => version);
  const current = conversationId ? store.get(conversationId)?.get(messageId) : undefined;

  const rate = useCallback(
    async (change: ReplyRatingChange) => {
      if (!conversationId) return;
      const previous = store.get(conversationId)?.get(messageId);
      put(
        conversationId,
        messageId,
        change.rating
          ? {
              conversationId,
              messageId,
              rating: change.rating,
              reason: change.rating === "down" ? (change.reason ?? null) : null,
              note: change.rating === "down" ? (change.note ?? null) : null,
              updatedAt: new Date().toISOString(),
            }
          : undefined,
      );
      try {
        const saved = await setReplyRating(conversationId, messageId, change);
        put(conversationId, messageId, saved ?? undefined);
      } catch {
        put(conversationId, messageId, previous);
      }
    },
    [conversationId, messageId],
  );

  return { rating: current, rate };
}
