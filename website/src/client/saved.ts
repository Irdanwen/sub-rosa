/**
 * The saved library from the browser (ADR-0088 and its addendum): what a
 * person saves from a chat (a reply, a link, a place) is a `saved_items` row,
 * synchronised as an `artifact`, whose id is derived from what was saved. So
 * the same link saved here and on the phone is one object, and saving twice
 * keeps one row. A temporary chat saves nothing (the button is not offered).
 */
import { firstLineTitle } from "@subrosa/chat-core/canvas-block";
import { timestamp } from "./codec";
import { replyText } from "./export";
import type { SyncClient } from "./sync";

export type SavedKind = "reply" | "link" | "place";
export interface SavedItem {
  id: string;
  kind: SavedKind;
  sourceKey: string;
  title: string;
  payload: Record<string, unknown>;
  conversationId: string | null;
  createdAt: string;
}
export interface SaveRequest {
  kind: SavedKind;
  sourceKey: string;
  title: string;
  payload: Record<string, unknown>;
  conversationId?: string;
}

const MAX_KEY_CHARS = 2200;
const MAX_PAYLOAD_BYTES = 256 * 1024;

/** `Uuid::NAMESPACE_URL`, the namespace `saved_items::item_id` hashes in. */
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/** A name-based (version 5) UUID, as the `uuid` crate makes one. */
export async function uuidV5(namespace: string, name: string): Promise<string> {
  const space = Uint8Array.from(namespace.replace(/-/g, "").match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
  const text = new TextEncoder().encode(name);
  const input = new Uint8Array(space.length + text.length);
  input.set(space);
  input.set(text, space.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `saved_items::item_id`. */
export function savedItemId(sourceKey: string): Promise<string> {
  return uuidV5(NAMESPACE_URL, `subrosa:saved-item:${sourceKey.trim()}`);
}

export function replySaveRequest(input: {
  text: string;
  conversationId: string;
  messageId: string;
}): SaveRequest {
  return {
    kind: "reply",
    sourceKey: `reply:${input.conversationId}:${input.messageId}`,
    title: firstLineTitle(replyText(input.text)),
    payload: { text: input.text, messageId: input.messageId },
    conversationId: input.conversationId,
  };
}

export function linkSaveRequest(
  link: { url: string; title?: string; snippet?: string },
  conversationId?: string,
): SaveRequest {
  let domain = "";
  try {
    domain = new URL(link.url).hostname.replace(/^www\./, "");
  } catch {
    // A link that does not parse keeps an empty domain, as the card shows it.
  }
  return {
    kind: "link",
    sourceKey: `link:${link.url}`,
    title: link.title ?? "",
    payload: { url: link.url, domain, ...(link.snippet ? { snippet: link.snippet } : {}) },
    conversationId,
  };
}

export function placeSaveRequest(
  place: {
    name: string;
    lat: number;
    lng: number;
    address?: string;
    category?: string;
    url?: string;
    note?: string;
  },
  conversationId?: string,
): SaveRequest {
  const { name, lat, lng, address, category, url, note } = place;
  return {
    kind: "place",
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

const text = (value: unknown) => (typeof value === "string" ? value : "");

export function listSaved(sync: SyncClient): SavedItem[] {
  return sync
    .rows("saved_items")
    .map((row) => {
      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(text(row.row.payload)) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          payload = parsed as Record<string, unknown>;
      } catch {
        // An unreadable payload shows the title alone.
      }
      return {
        id: row.id,
        kind: text(row.row.kind) as SavedKind,
        sourceKey: text(row.row.source_key),
        title: text(row.row.title),
        payload,
        conversationId: text(row.row.conversation_id) || null,
        createdAt: text(row.row.created_at),
      };
    })
    .filter((item) => item.kind === "reply" || item.kind === "link" || item.kind === "place")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function isSaved(sync: SyncClient, sourceKey: string): boolean {
  return listSaved(sync).some((item) => item.sourceKey === sourceKey.trim());
}

/** `saved_items::save`: once per thing, whatever the device. */
export async function saveItem(sync: SyncClient, request: SaveRequest): Promise<string> {
  const sourceKey = request.sourceKey.trim();
  if (!sourceKey || sourceKey.length > MAX_KEY_CHARS) throw new Error("Invalid saved item.");
  const payload = JSON.stringify(request.payload);
  if (new TextEncoder().encode(payload).length > MAX_PAYLOAD_BYTES)
    throw new Error("This is too large to save.");
  const id = await savedItemId(sourceKey);
  const existing = sync.objects.get(id);
  if (existing && !existing.deleted) return id;
  await sync.write("saved_items", {
    id,
    kind: request.kind,
    source_key: sourceKey,
    title: Array.from(request.title.trim() || request.kind)
      .slice(0, 200)
      .join(""),
    payload,
    conversation_id: request.conversationId ?? null,
    created_at: timestamp(),
  });
  return id;
}

export async function removeSaved(sync: SyncClient, id: string) {
  const item = sync.objects.get(id);
  if (item && !item.deleted && item.table === "saved_items")
    await sync.write("saved_items", item.row, { deleted: true });
}
