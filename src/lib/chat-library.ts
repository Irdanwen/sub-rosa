import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";
import { firstLineTitle } from "./canvas-block";
import type { ChatBlockLink, ChatBlockPlace } from "./chat-blocks";
import { ACCOUNT_SYNC_UPDATED_EVENT } from "./account-sync-events";
import { chatBlocksToClipboardText } from "./chat-blocks";
import { listArtifacts } from "./studio/artifacts";
import type { StudioArtifact } from "./studio/types";

/**
 * The Library: everything a chat made or a person kept from one (ADR-0088).
 *
 * Two halves, stored in two places on purpose. A picture made in a chat is a
 * gallery file already, so the Library finds it by the `origin` its
 * generation metadata carries rather than copying it anywhere. A reply, a
 * link or a place is not a file, so "Save" writes a small row of its own
 * (`saved_items`, synchronised with an account). The views on both shells
 * read this module only.
 */

export type SavedItemKind = "reply" | "link" | "place";

export type SavedReplyPayload = { text: string; messageId?: string };
export type SavedLinkPayload = Pick<ChatBlockLink, "url" | "domain" | "snippet">;
export type SavedPlacePayload = Pick<
  ChatBlockPlace,
  "lat" | "lng" | "address" | "category" | "url" | "note"
>;

export type SavedItem = {
  id: string;
  kind: SavedItemKind;
  sourceKey: string;
  title: string;
  payload: Record<string, unknown>;
  conversationId?: string | null;
  createdAt: string;
};

type SaveRequest = {
  kind: SavedItemKind;
  sourceKey: string;
  title: string;
  payload: Record<string, unknown>;
  conversationId?: string;
};

/* ------------------------------------------------------------------ *
 * What a thing is saved as
 * ------------------------------------------------------------------ */

/** A reply's title: its first heading or line, cards and markdown left out. */
export function replyTitle(text: string): string {
  return firstLineTitle(chatBlocksToClipboardText(text));
}

export function replySaveRequest(input: {
  text: string;
  conversationId?: string;
  messageId?: string;
}): SaveRequest {
  // A reply without a stored id (still in memory) is keyed by its text, so
  // saving it twice still keeps one row.
  const identity = input.messageId
    ? `${input.conversationId ?? "chat"}:${input.messageId}`
    : `text:${hashText(input.text)}`;
  return {
    kind: "reply",
    sourceKey: `reply:${identity}`,
    title: replyTitle(input.text),
    payload: { text: input.text, ...(input.messageId ? { messageId: input.messageId } : {}) },
    conversationId: input.conversationId,
  };
}

export function linkSaveRequest(link: ChatBlockLink, conversationId?: string): SaveRequest {
  return {
    kind: "link",
    sourceKey: `link:${link.url}`,
    title: link.title,
    payload: {
      url: link.url,
      domain: link.domain,
      ...(link.snippet ? { snippet: link.snippet } : {}),
    },
    conversationId,
  };
}

export function placeSaveRequest(place: ChatBlockPlace, conversationId?: string): SaveRequest {
  const { name, lat, lng, address, category, url, note } = place;
  return {
    kind: "place",
    // Coordinates to five places (about a metre): the same place found twice
    // is one row, two shops in one building are two.
    sourceKey: `place:${lat.toFixed(5)},${lng.toFixed(5)}:${name}`,
    title: name,
    payload: Object.fromEntries(
      Object.entries({ lat, lng, address, category, url, note }).filter(
        ([, value]) => value !== undefined,
      ),
    ),
    conversationId,
  };
}

/** FNV-1a, enough to name a text, not to protect it. */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/* ------------------------------------------------------------------ *
 * The store every "Save" button and both Library views read
 * ------------------------------------------------------------------ */

let items: SavedItem[] = [];
let loaded = false;
let loading: Promise<void> | null = null;
let following = false;
const listeners = new Set<() => void>();

/** An item saved or removed on another device lands in the database while the
 * Library is open, so the store reads again whenever a sync applies changes.
 * One subscription for the store, whatever the number of Save buttons. */
function followSync() {
  if (following) return;
  following = true;
  void Promise.resolve()
    .then(() =>
      listen(ACCOUNT_SYNC_UPDATED_EVENT, () => {
        if (loaded) void loadSavedItems().catch(() => undefined);
      }),
    )
    .catch(() => {
      following = false;
    });
}

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads the Library from the device. Concurrent callers share one read. */
export function loadSavedItems(): Promise<void> {
  followSync();
  if (loading) return loading;
  loading = invoke<SavedItem[]>("saved_items_list")
    .then((rows) => {
      items = Array.isArray(rows) ? rows : [];
      loaded = true;
      emit();
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export async function saveItem(request: SaveRequest): Promise<SavedItem> {
  const saved = await invoke<SavedItem>("saved_item_save", { request });
  items = [saved, ...items.filter((item) => item.id !== saved.id)];
  emit();
  return saved;
}

export async function removeSavedItem(id: string): Promise<void> {
  await invoke<void>("saved_item_remove", { id });
  items = items.filter((item) => item.id !== id);
  emit();
}

/** Every saved item, newest first. Loads once on first use. */
export function useSavedItems(): { items: SavedItem[]; loaded: boolean } {
  const snapshot = useSyncExternalStore(subscribe, () => items);
  useEffect(() => {
    if (!loaded) void loadSavedItems().catch(() => undefined);
  }, []);
  return { items: snapshot, loaded };
}

/** The saved row for a key, if this thing is in the Library. */
export function useSavedItem(sourceKey: string): SavedItem | undefined {
  const { items: current } = useSavedItems();
  return current.find((item) => item.sourceKey === sourceKey);
}

/** Saved, or taken back out: the one gesture every "Save" button makes. */
export async function toggleSaved(request: SaveRequest, saved?: SavedItem): Promise<void> {
  if (saved) await removeSavedItem(saved.id);
  else await saveItem(request);
}

/** Every picture a chat made, newest first: gallery files whose generation
 * says they were asked for in a conversation. */
export async function listChatImages(): Promise<StudioArtifact[]> {
  const artifacts = await listArtifacts("image");
  return artifacts.filter((artifact) => artifact.origin?.surface === "chat");
}

/** For tests: forget what was loaded. */
export function resetLibraryStore() {
  items = [];
  loaded = false;
  loading = null;
  emit();
}
