/**
 * Shared projects in the browser (ADR-0098): the same protocol as the app,
 * spoken to the same routes. This tab reads a space, writes notes and
 * messages, accepts an invitation, leaves, and asks the assistant with the
 * browser device's own key (ADR-0096). Inviting, admitting and removing are
 * the owner's, from any of the owner's devices, this tab included
 * (`membership.ts`).
 *
 * What it keeps between reloads is public by nature: the last head it
 * verified per space (so an older one is a rollback) and the inviter it
 * trusted when it joined. Decrypted content lives in memory only.
 */
import { api } from "../../lib/api";
import type { Operator } from "../carpe-diem";
import { streamCompletion } from "../carpe-diem";
import type { ClientStore } from "../store";
import {
  type Bytes,
  type EpochHead,
  type IdentityBundle,
  IdentitySecret,
  type InvitePayload,
  type ObjectBody,
  type WireObject,
  acceptanceProof,
  grouped,
  headMember,
  inviteToken,
  leaveStatement,
  openObject,
  openPayload,
  parseInvitation,
  safetyNumber,
  sealObject,
  tokenHash,
  unwrapKey,
  verifyBundle,
  verifyChain,
} from "./protocol";

/** The service calls this module makes, replaceable in tests. */
export interface SpacesTransport {
  get<T>(path: string): Promise<T>;
  send<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T>;
}
export const serviceSpaces: SpacesTransport = {
  get: (path) => api(path),
  send: (method, path, body) =>
    api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
};

/** Where a browser keeps the Preview switch, off unless the person turned
 * it on. */
export const SPACES_ENABLED = "spaces-enabled";
export class SpacesDisabledError extends Error {
  code = "spaces_disabled" as const;
  constructor() {
    super("spaces_disabled");
  }
}
export async function spacesEnabled(store: ClientStore | null): Promise<boolean> {
  return store !== null && (await store.get<boolean>("local", SPACES_ENABLED)) === true;
}
/** The transport behind the Preview switch. The client holds the switch, as
 * the app's commands do (`enabled_pool`), rather than trusting every panel
 * to: with it off, no call reaches the service, whatever asks. Each call
 * reads the switch again, so turning it off takes effect at once. */
export function behindPreview(
  store: ClientStore | null,
  inner: SpacesTransport = serviceSpaces,
): SpacesTransport {
  const check = async () => {
    if (!(await spacesEnabled(store))) throw new SpacesDisabledError();
  };
  return {
    get: async (path) => {
      await check();
      return inner.get(path);
    },
    send: async (method, path, body) => {
      await check();
      return inner.send(method, path, body);
    },
  };
}

export interface Me {
  accountId: string;
  identity: IdentitySecret;
  bundle: IdentityBundle;
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error && "status" in error
    ? (error as { status: number }).status
    : undefined;
}

/** The account's identity: from the service, sealed under the vault key, or
 * born here when no device made one yet. */
export async function loadIdentity(
  transport: SpacesTransport,
  vaultKey: Bytes,
  accountId: string,
): Promise<Me> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const record = await transport.get<{ public: IdentityBundle; sealed_private: string }>(
        "/api/v1/identity",
      );
      await verifyBundle(record.public);
      const identity = await IdentitySecret.open(vaultKey, accountId, record.sealed_private);
      const mine = await identity.bundle(accountId, record.public.created_at);
      if (
        record.public.account_id !== accountId ||
        mine.x25519 !== record.public.x25519 ||
        mine.ed25519 !== record.public.ed25519
      )
        throw new Error("Identity mismatch");
      return { accountId, identity, bundle: record.public };
    } catch (error) {
      if (status(error) !== 404) throw error;
    }
    const identity = IdentitySecret.generate();
    const bundle = await identity.bundle(accountId, new Date().toISOString());
    try {
      await transport.send("PUT", "/api/v1/identity", {
        expected_version: 0,
        public: bundle,
        sealed_private: await identity.seal(vaultKey, accountId),
      });
      return { accountId, identity, bundle };
    } catch (error) {
      if (status(error) !== 409) throw error;
    }
  }
  throw new Error("The identity could not be set up.");
}

export interface SpaceSummary {
  id: string;
  owner_account_id: string;
  role: "owner" | "member";
  current_epoch: number;
  latest_sequence: number;
  member_count: number;
}
export const listSpaces = (transport: SpacesTransport) =>
  transport.get<SpaceSummary[]>("/api/v1/spaces");

/** An invitation as the service shows it to the owner: who claimed it, and
 * the acceptance they sent, which only the device holding the link's secret
 * can check. */
export interface DetailInvitation {
  id: string;
  expires_at: string;
  claimed_by: string | null;
  acceptance: unknown;
}
/** A leave statement a member signed, waiting for the rotation that takes
 * them out. */
export interface DetailDeparture {
  account_id: string;
  epoch: number;
  statement: string;
}
interface Detail {
  current_epoch: number;
  members: { account_id: string; identity: IdentityBundle | null }[];
  heads: { epoch: number; head: EpochHead }[];
  keys: { epoch: number; sealed: string }[];
  invitations?: DetailInvitation[];
  departures?: DetailDeparture[];
}

export interface SpaceMember {
  accountId: string;
  role: string;
  name: string | null;
  isMe: boolean;
  safetyNumber: string[];
}
export interface SpaceItem {
  id: string;
  kind: ObjectBody["kind"];
  revision: string;
  author: string;
  createdAt: string;
  data: Record<string, unknown>;
}
/** One space, verified and decrypted, in memory. */
export interface SpaceView {
  id: string;
  name: string;
  instructions: string;
  latest: EpochHead;
  keys: Map<number, Bytes>;
  members: SpaceMember[];
  items: Map<string, SpaceItem>;
  sequenceOf: Map<string, number>;
  /** Every verified head of the chain, by epoch: an admission seals the
   * earlier keys against the heads that committed to them. */
  heads: Map<number, EpochHead>;
  /** What the service said beside the heads: the accounts it still lists
   * as members, the owner's invitations, the signed departures. */
  onService: string[];
  invitations: DetailInvitation[];
  departures: DetailDeparture[];
}

const headKey = (id: string) => `space-head:${id}`;
const anchorKey = (id: string) => `space-anchor:${id}`;

/** Reads a space and verifies everything the service said about it: the
 * chain of heads against the last one this browser trusted (or the inviter
 * it joined through), each member's published keys against the head, and
 * every key against its commitment. Then every object, opened and checked. */
export async function openSpace(
  transport: SpacesTransport,
  store: ClientStore,
  me: Me,
  spaceId: string,
): Promise<SpaceView> {
  const detail = await transport.get<Detail>(`/api/v1/spaces/${spaceId}`);
  const heads = detail.heads.map((h) => h.head);
  const trusted = (await store.get<EpochHead>("meta", headKey(spaceId))) ?? null;
  const anchor =
    (await store.get<IdentityBundle>("meta", anchorKey(spaceId))) ??
    (heads[0]?.owner === me.accountId ? me.bundle : null);
  if (!trusted && !anchor) throw new Error("This browser has no anchor for this space.");
  const { latest, heads: byEpoch } = await verifyChain(trusted, heads, trusted ? null : anchor);
  if (latest.space_id !== spaceId || detail.current_epoch !== latest.epoch)
    throw new Error("The space does not match its heads.");
  if (!headMember(latest, me.accountId)) throw new Error("This account is not in the space.");
  await store.put("meta", headKey(spaceId), latest);
  // Only the verified heads name a key's commitment, a member or an author.
  const keys = new Map<number, Bytes>();
  for (const wrapped of detail.keys) {
    const head = byEpoch.get(wrapped.epoch);
    if (!head) throw new Error("A key names an unknown epoch.");
    keys.set(wrapped.epoch, await unwrapKey(me.identity, wrapped.sealed, head, me.accountId));
  }
  const members: SpaceMember[] = [];
  for (const member of latest.members) {
    const published =
      member.account_id === me.accountId
        ? me.bundle
        : detail.members.find((m) => m.account_id === member.account_id)?.identity;
    if (!published) continue;
    await verifyBundle(published);
    if (published.x25519 !== member.x25519 || published.ed25519 !== member.ed25519)
      throw new Error("A member's published keys differ from the signed head.");
    members.push({
      accountId: member.account_id,
      role: member.role,
      name: null,
      isMe: member.account_id === me.accountId,
      safetyNumber: grouped(await safetyNumber(me.bundle, published)),
    });
  }
  const view: SpaceView = {
    id: spaceId,
    name: "",
    instructions: "",
    latest,
    keys,
    members,
    items: new Map(),
    sequenceOf: new Map(),
    heads: byEpoch,
    onService: detail.members.map((m) => m.account_id),
    invitations: detail.invitations ?? [],
    departures: detail.departures ?? [],
  };
  let cursor = 0;
  for (;;) {
    const page = await transport.get<{
      objects: (WireObject & { sequence: number; created_at: string })[];
      cursor: number;
      has_more: boolean;
    }>(`/api/v1/spaces/${spaceId}/objects?after=${cursor}&limit=200`);
    for (const wire of page.objects) {
      const head = byEpoch.get(wire.epoch);
      const key = keys.get(wire.epoch);
      const author = head && headMember(head, wire.author_account_id);
      if (!key || !author) continue;
      let body: ObjectBody;
      try {
        body = await openObject(key, spaceId, wire, author);
      } catch {
        continue;
      }
      accept(view, body, wire.epoch, wire.sequence);
    }
    cursor = page.cursor;
    if (!page.has_more) break;
  }
  for (const member of view.members) {
    const profile = view.items.get(await profileId(spaceId, member.accountId));
    if (typeof profile?.data.name === "string" && profile.data.name.trim())
      member.name = profile.data.name;
  }
  return view;
}

const epochOf = new WeakMap<SpaceItem, number>();
function accept(view: SpaceView, body: ObjectBody, epoch: number, sequence: number) {
  const kept = view.items.get(body.object_id);
  // A later sequence replaces; an older epoch never does.
  if (
    kept &&
    ((view.sequenceOf.get(body.object_id) ?? 0) >= sequence || (epochOf.get(kept) ?? 0) > epoch)
  )
    return;
  view.sequenceOf.set(body.object_id, sequence);
  if (body.deleted) {
    view.items.delete(body.object_id);
    return;
  }
  const item: SpaceItem = {
    id: body.object_id,
    kind: body.kind,
    revision: body.revision,
    author: body.author,
    createdAt: body.created_at,
    data: body.data,
  };
  epochOf.set(item, epoch);
  view.items.set(body.object_id, item);
  if (body.kind === "project") {
    view.name = String(body.data.name ?? "");
    view.instructions = String(body.data.instructions ?? "");
  }
}

/** The object a member's display name lives in, as the app computes it:
 * UUID v5 of the account id in the space's namespace. */
export async function profileId(spaceId: string, accountId: string): Promise<string> {
  const namespace =
    spaceId
      .replaceAll("-", "")
      .match(/../g)
      ?.map((h) => Number.parseInt(h, 16)) ?? [];
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-1",
      new Uint8Array([...namespace, ...new TextEncoder().encode(accountId)]),
    ),
  ).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Seals one write under the current epoch, signs it, and sends it. */
export async function write(
  transport: SpacesTransport,
  me: Me,
  view: SpaceView,
  kind: ObjectBody["kind"],
  objectId: string,
  data: Record<string, unknown>,
  deleted = false,
): Promise<void> {
  const key = view.keys.get(view.latest.epoch);
  if (!key) throw new Error("No key for the current epoch.");
  const body: ObjectBody = {
    v: 1,
    kind,
    object_id: objectId,
    revision: crypto.randomUUID(),
    parent_revision: view.items.get(objectId)?.revision ?? null,
    author: me.accountId,
    created_at: new Date().toISOString(),
    deleted,
    data,
  };
  const sealed = await sealObject(key, view.id, view.latest.epoch, body, me.identity);
  const result = await transport.send<{ results: { revision: string; sequence: number }[] }>(
    "POST",
    `/api/v1/spaces/${view.id}/objects`,
    {
      objects: [
        {
          object_id: objectId,
          revision: body.revision,
          parent_revision: body.parent_revision,
          kind,
          epoch: view.latest.epoch,
          ciphertext: sealed.ciphertext,
          signature: sealed.signature,
          deleted,
        },
      ],
    },
  );
  const answer = result.results?.[0];
  if (answer?.revision !== body.revision) throw new Error("Invalid acknowledgement.");
  accept(view, body, view.latest.epoch, answer.sequence);
}

export function itemsOf(view: SpaceView, kind: ObjectBody["kind"]): SpaceItem[] {
  return [...view.items.values()]
    .filter((item) => item.kind === kind)
    .sort((a, b) => (view.sequenceOf.get(a.id) ?? 0) - (view.sequenceOf.get(b.id) ?? 0));
}
export function messagesOf(view: SpaceView, conversationId: string): SpaceItem[] {
  return itemsOf(view, "message").filter((m) => m.data.conversation_id === conversationId);
}
export function nameOf(view: SpaceView, accountId: string): string | null {
  return view.members.find((m) => m.accountId === accountId)?.name ?? null;
}

export interface OpenedInvitation {
  invitationId: string;
  secret: Bytes;
  payload: InvitePayload;
  safetyNumber: string[];
}
export async function openInvitation(
  transport: SpacesTransport,
  me: Me,
  code: string,
): Promise<OpenedInvitation> {
  const { invitationId, secret } = parseInvitation(code);
  const token = await inviteToken(secret, invitationId);
  const opened = await transport.send<{ space_id: string; payload: string }>(
    "POST",
    `/api/v1/space-invitations/${invitationId}/open`,
    { token_hash: await tokenHash(token) },
  );
  const payload = await openPayload(secret, invitationId, opened.payload);
  if (payload.space_id !== opened.space_id) throw new Error("The invitation does not match.");
  return {
    invitationId,
    secret,
    payload,
    safetyNumber: grouped(await safetyNumber(me.bundle, payload.inviter)),
  };
}
export async function acceptInvitation(
  transport: SpacesTransport,
  store: ClientStore,
  me: Me,
  opened: OpenedInvitation,
): Promise<void> {
  const token = await inviteToken(opened.secret, opened.invitationId);
  await transport.send("POST", `/api/v1/space-invitations/${opened.invitationId}/accept`, {
    token_hash: await tokenHash(token),
    acceptance: {
      member: me.bundle,
      proof: await acceptanceProof(
        opened.secret,
        opened.invitationId,
        opened.payload.space_id,
        me.bundle,
      ),
    },
  });
  // The inviter named in the link is what this browser verifies the chain
  // from, the first time it reads the space.
  await store.put("meta", anchorKey(opened.payload.space_id), opened.payload.inviter);
}

export async function leave(transport: SpacesTransport, me: Me, view: SpaceView) {
  await transport.send("POST", `/api/v1/spaces/${view.id}/leave`, {
    epoch: view.latest.epoch,
    statement: await leaveStatement(me.identity, view.id, view.latest.epoch, me.accountId),
  });
}

/** An assistant reply in a group chat, run in this tab with this browser's
 * key, written as this account's message with `paid_by` naming it. */
export async function askAssistant(
  transport: SpacesTransport,
  me: Me,
  view: SpaceView,
  conversationId: string,
  operator: Operator,
  key: string,
  model: string,
  onText: (text: string) => void,
): Promise<void> {
  let context = "";
  for (const item of [...itemsOf(view, "note"), ...itemsOf(view, "file")]) {
    const title = String(item.data.title ?? item.data.name ?? "");
    const text = String(item.data.body ?? item.data.text ?? "");
    context += `\n--- ${title} ---\n${text}\n`;
    if (context.length > 24_000) break;
  }
  let system = `You are Sub Rosa's assistant in a shared project named "${view.name.trim()}". Several people take part in this conversation; each of their messages starts with the person's name. Answer the group, address people by name when it helps, and do not claim to be one of them.`;
  if (view.instructions.trim())
    system += `\nThe project's instructions:\n${view.instructions.trim()}`;
  if (context) system += `\nThe project's notes and files:${context.slice(0, 24_000)}`;
  const history = messagesOf(view, conversationId)
    .slice(-40)
    .map((m) =>
      m.data.role === "assistant"
        ? { role: "assistant" as const, content: String(m.data.text ?? "") }
        : {
            role: "user" as const,
            content: `${nameOf(view, m.author) ?? "A member"}: ${String(m.data.text ?? "")}`,
          },
    );
  let text = "";
  await streamCompletion(
    operator,
    key,
    { model, messages: [{ role: "system", content: system }, ...history] },
    (fragment) => {
      text += fragment;
      onText(text);
    },
  );
  if (!text.trim()) throw new Error("The assistant could not answer.");
  await write(transport, me, view, "message", crypto.randomUUID(), {
    conversation_id: conversationId,
    role: "assistant",
    text: text.slice(0, 100_000),
    model: model.slice(0, 200),
    paid_by: me.accountId,
  });
}
