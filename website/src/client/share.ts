/**
 * Sharing a chat by link from the browser: ADR-0053 and its addendum, made
 * here exactly as `account/shares.rs` makes it in the app.
 *
 * A fresh key per share, never the vault key; the visible turns sealed under
 * it with the context `subrosa:share:v1:{share id}:{position}`; one opaque
 * blob uploaded; the share opened with a deadline among three; the key in the
 * URL fragment, which no request carries. The reader is the site's own
 * `/s/{id}` page, unchanged.
 */
import { api } from "../lib/api";
import type { SharedDocument, SharedMessage } from "../lib/share";
import { encode, encrypt } from "../lib/vault";
import type { Message } from "./library";

/** The three deadlines the app offers, in hours. No "never". */
export const SHARE_WINDOWS = [24, 24 * 7, 24 * 30] as const;
export type ShareWindow = (typeof SHARE_WINDOWS)[number];

/** What the reader of a shared conversation may be handed, at most. */
const MAX_CONVERSATION_BYTES = 2 * 1024 * 1024;

export class ShareError extends Error {
  constructor(public code: "share_empty" | "share_too_large" | "share_window_invalid") {
    super(code);
  }
}

export interface ShareLink {
  id: string;
  url: string;
  expiresAt: string;
}

/** How a share reaches the service, overridable in tests. */
export interface ShareTransport {
  putBlob(id: string, sealed: string): Promise<void>;
  open(body: { id: string; expires_at: string; blob_ids: string[] }): Promise<void>;
  revoke(id: string): Promise<void>;
  origin: string;
}

export const serviceShareTransport: ShareTransport = {
  async putBlob(id, sealed) {
    await api(`/api/v1/blobs/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new TextEncoder().encode(sealed),
    });
  },
  async open(body) {
    await api("/api/v1/shares", { method: "POST", body: JSON.stringify(body) });
  },
  async revoke(id) {
    await api(`/api/v1/shares/${id}`, { method: "DELETE" });
  },
  get origin() {
    return location.origin;
  },
};

/** The app's `without_attached_context`: a question shows alone. */
function withoutAttachedContext(content: string): string {
  let end = content.length;
  for (const marker of ["--- Context Warnings ---", "--- Attached Context ---"]) {
    const at = content.indexOf(marker);
    if (at >= 0) end = Math.min(end, at);
  }
  return content.slice(0, end);
}

/** The app's `without_inline_data`: every base64 `data:` URI becomes a marker. */
export function withoutInlineData(content: string): string {
  let out = "";
  let rest = content;
  for (;;) {
    const at = rest.indexOf("data:");
    if (at < 0) break;
    const candidate = rest.slice(at);
    const match = /[\s)"'>\]]/.exec(candidate);
    const end = match ? match.index : candidate.length;
    const token = candidate.slice(0, end);
    out += rest.slice(0, at);
    out += token.includes(";base64,") ? "[attachment]" : token;
    rest = candidate.slice(end);
  }
  return out + rest;
}

/** `visible_turns`: user and assistant text the person saw, nothing else. */
export function visibleTurns(messages: Pick<Message, "role" | "content">[]): SharedMessage[] {
  const turns: SharedMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = withoutInlineData(withoutAttachedContext(message.content)).trim();
    if (content) turns.push({ role: message.role, content });
  }
  return turns;
}

/** Publishes one conversation. Everything a reader will see is sealed before
 * the first byte leaves; the key is generated here and only ever returned in
 * the link. */
export async function createConversationShare(
  title: string,
  messages: Pick<Message, "role" | "content">[],
  windowHours: number,
  transport: ShareTransport = serviceShareTransport,
  now = new Date(),
): Promise<ShareLink> {
  if (!(SHARE_WINDOWS as readonly number[]).includes(windowHours))
    throw new ShareError("share_window_invalid");
  const turns = visibleTurns(messages);
  if (!turns.length) throw new ShareError("share_empty");
  const size = turns.reduce((sum, turn) => sum + new TextEncoder().encode(turn.content).length, 0);
  if (size > MAX_CONVERSATION_BYTES) throw new ShareError("share_too_large");
  const document: SharedDocument = {
    v: 1,
    kind: "conversation",
    title: Array.from(title.trim()).slice(0, 200).join(""),
    body: "",
    shared_at: now.toISOString(),
    messages: turns,
  };
  const id = crypto.randomUUID();
  const key = crypto.getRandomValues(new Uint8Array(32));
  try {
    const head = crypto.randomUUID();
    await transport.putBlob(head, await encrypt(key, document, `subrosa:share:v1:${id}:0`));
    const expiresAt = new Date(now.getTime() + windowHours * 3_600_000).toISOString();
    await transport.open({ id, expires_at: expiresAt, blob_ids: [head] });
    return { id, url: `${transport.origin}/s/${id}#k=${encode(key)}`, expiresAt };
  } finally {
    key.fill(0);
  }
}
