// The browser's shared projects client against an in-memory service that
// keeps the routes' rules: an owner shares, invites and admits; a member
// reads the history, writes, asks the assistant with their own key; a
// rollback is caught; a removed member reads nothing written after; an
// invitation works once.
// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import vectors from "../../src-tauri/tests/fixtures/spaces-v1.json";
import { ApiError } from "../../website/src/lib/api";
import {
  type Me,
  type SpacesTransport,
  acceptInvitation,
  askAssistant,
  itemsOf,
  loadIdentity,
  messagesOf,
  openInvitation,
  openSpace,
  profileId,
  write,
} from "../../website/src/client/spaces/client";
import {
  type Bytes,
  type EpochHead,
  type IdentityBundle,
  type WireObject,
  acceptanceProof,
  headMember,
  invitationCode,
  inviteToken,
  memberFromBundle,
  openObject,
  safetyNumber,
  sealPayload,
  signHead,
  tokenHash,
  wrapKey,
} from "../../website/src/client/spaces/protocol";
import { memoryClientStore } from "../../website/src/client/store";
import { fakeOperator, text } from "./website-client-fakes";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

type Stored = WireObject & { sequence: number; created_at: string };
interface FakeSpace {
  owner: string;
  epoch: number;
  members: Map<string, string>;
  heads: EpochHead[];
  wraps: Map<string, string>;
  objects: Stored[];
  invitations: Map<
    string,
    { tokenHash: string; payload: string; claimedBy?: string; acceptance?: unknown }
  >;
}
/** The routes this client calls, with the service's authorization rules. */
class FakeService {
  identities = new Map<string, { public: IdentityBundle; sealed_private: string }>();
  spaces = new Map<string, FakeSpace>();
  /** When set, the next detail read for this account shows only these heads. */
  stale = new Map<string, number>();

  as(account: string): SpacesTransport {
    const notFound = () => new ApiError("not_found", "x", 404);
    const member = (id: string) => {
      const space = this.spaces.get(id);
      if (!space?.members.has(account)) throw notFound();
      return space;
    };
    return {
      get: async <T>(path: string) => {
        if (path === "/api/v1/identity") {
          const record = this.identities.get(account);
          if (!record) throw notFound();
          return structuredClone(record) as T;
        }
        if (path === "/api/v1/spaces")
          return [...this.spaces.entries()]
            .filter(([, s]) => s.members.has(account))
            .map(([id, s]) => ({
              id,
              member_count: s.members.size,
              role: s.members.get(account),
            })) as T;
        const objects = /^\/api\/v1\/spaces\/([^/]+)\/objects\?after=(\d+)/.exec(path);
        if (objects) {
          const space = member(objects[1]);
          const after = Number(objects[2]);
          const page = space.objects.filter((o) => o.sequence > after);
          return {
            objects: structuredClone(page),
            cursor: page.at(-1)?.sequence ?? after,
            has_more: false,
          } as T;
        }
        const detail = /^\/api\/v1\/spaces\/([^/]+)$/.exec(path);
        if (detail) {
          const space = member(detail[1]);
          const shown = this.stale.get(account) ?? space.epoch;
          this.stale.delete(account);
          return structuredClone({
            current_epoch: shown,
            members: [...space.members.keys()].map((id) => ({
              account_id: id,
              identity: this.identities.get(id)?.public ?? null,
            })),
            heads: space.heads
              .filter((h) => h.epoch <= shown)
              .map((head) => ({ epoch: head.epoch, head })),
            keys: [...space.wraps.entries()]
              .filter(([key]) => key.endsWith(`:${account}`))
              .map(([key, sealed]) => ({ epoch: Number(key.split(":")[0]), sealed })),
          }) as T;
        }
        throw notFound();
      },
      send: async <T>(method: string, path: string, body?: unknown) => {
        const b = body as Record<string, unknown>;
        if (path === "/api/v1/identity" && method === "PUT") {
          if (this.identities.has(account)) throw new ApiError("conflict", "x", 409);
          this.identities.set(account, {
            public: b.public as IdentityBundle,
            sealed_private: b.sealed_private as string,
          });
          return { version: 1 } as T;
        }
        const objects = /^\/api\/v1\/spaces\/([^/]+)\/objects$/.exec(path);
        if (objects) {
          const space = member(objects[1]);
          const results = (b.objects as WireObject[]).map((o) => {
            if (o.epoch !== space.epoch) throw new ApiError("conflict", "x", 409);
            const sequence = space.objects.length + 1;
            space.objects.push({ ...o, author_account_id: account, sequence, created_at: "now" });
            return { revision: o.revision, sequence };
          });
          return { results } as T;
        }
        const open = /^\/api\/v1\/space-invitations\/([^/]+)\/(open|accept)$/.exec(path);
        if (open) {
          for (const [spaceId, space] of this.spaces) {
            const invitation = space.invitations.get(open[1]);
            if (!invitation || invitation.tokenHash !== b.token_hash) continue;
            if (invitation.claimedBy)
              throw open[2] === "open" ? notFound() : new ApiError("conflict", "x", 409);
            if (open[2] === "open") return { space_id: spaceId, payload: invitation.payload } as T;
            invitation.claimedBy = account;
            invitation.acceptance = b.acceptance;
            return { space_id: spaceId } as T;
          }
          throw notFound();
        }
        throw notFound();
      },
    };
  }
}

const v = vectors as unknown as {
  profile_id: { space_id: string; account_id: string; id: string };
};
const ALICE = "0191d1a4-0000-7000-8000-0000000000a1";
const BOB = "0191d1a4-0000-7000-8000-0000000000b2";
const CAROL = "0191d1a4-0000-7000-8000-0000000000c3";
const SPACE = "0191d1a4-5a00-7000-8000-00000000a0aa";
const vault = () => crypto.getRandomValues(new Uint8Array(32)) as Bytes;

/** The owner's side, which lives in the app: create, invite, admit, remove. */
async function share(service: FakeService, alice: Me) {
  const keys = [crypto.getRandomValues(new Uint8Array(32)) as Bytes];
  const head = await signHead(
    {
      spaceId: SPACE,
      epoch: 1,
      prev: null,
      owner: ALICE,
      members: [memberFromBundle(alice.bundle, "owner")],
      key: keys[0],
      author: ALICE,
      departures: [],
      createdAt: "2026-10-08T12:00:00Z",
    },
    alice.identity,
  );
  service.spaces.set(SPACE, {
    owner: ALICE,
    epoch: 1,
    members: new Map([[ALICE, "owner"]]),
    heads: [head],
    wraps: new Map([[`1:${ALICE}`, await wrapKey(keys[0], alice.bundle.x25519, SPACE, 1, ALICE)]]),
    objects: [],
    invitations: new Map(),
  });
  return keys;
}
async function invite(service: FakeService, alice: Me) {
  const id = crypto.randomUUID();
  const secret = crypto.getRandomValues(new Uint8Array(32)) as Bytes;
  const payload = await sealPayload(secret, id, {
    v: 1,
    space_id: SPACE,
    space_name: "Launch plan",
    inviter: alice.bundle,
    expires_at: "2026-10-15T12:00:00Z",
  });
  service.spaces.get(SPACE)?.invitations.set(id, {
    tokenHash: await tokenHash(await inviteToken(secret, id)),
    payload,
  });
  return { id, secret, link: `https://example.test/app#join=${invitationCode(id, secret)}` };
}
async function rotate(
  service: FakeService,
  alice: Me,
  keys: Bytes[],
  members: IdentityBundle[],
  history?: IdentityBundle,
) {
  const space = service.spaces.get(SPACE);
  if (!space) throw new Error("space");
  const key = crypto.getRandomValues(new Uint8Array(32)) as Bytes;
  const epoch = space.epoch + 1;
  const head = await signHead(
    {
      spaceId: SPACE,
      epoch,
      prev: space.heads.at(-1) ?? null,
      owner: ALICE,
      members: members.map((m) => memberFromBundle(m, m.account_id === ALICE ? "owner" : "member")),
      key,
      author: ALICE,
      departures: [],
      createdAt: "2026-10-08T12:00:00Z",
    },
    alice.identity,
  );
  space.heads.push(head);
  space.epoch = epoch;
  space.members = new Map(
    members.map((m) => [m.account_id, m.account_id === ALICE ? "owner" : "member"]),
  );
  for (const m of members)
    space.wraps.set(
      `${epoch}:${m.account_id}`,
      await wrapKey(key, m.x25519, SPACE, epoch, m.account_id),
    );
  if (history)
    for (const [index, old] of keys.entries())
      space.wraps.set(
        `${index + 1}:${history.account_id}`,
        await wrapKey(old, history.x25519, SPACE, index + 1, history.account_id),
      );
  for (const [key2] of [...space.wraps])
    if (!space.members.has(key2.split(":")[1])) space.wraps.delete(key2);
  keys.push(key);
}

describe("shared projects in the browser", () => {
  it("derives a member's profile object as the app does", async () => {
    expect(await profileId(v.profile_id.space_id, v.profile_id.account_id)).toBe(v.profile_id.id);
  });

  it("carries a project from the owner to a member, and a reply that says who paid", async () => {
    const service = new FakeService();
    const aliceStore = memoryClientStore();
    const bobStore = memoryClientStore();
    const alice = await loadIdentity(service.as(ALICE), vault(), ALICE);
    const bobVault = vault();
    const bob = await loadIdentity(service.as(BOB), bobVault, BOB);
    // A second tab of the same account finds the identity instead of making one.
    expect((await loadIdentity(service.as(BOB), bobVault, BOB)).bundle).toEqual(bob.bundle);

    const keys = await share(service, alice);
    let aliceView = await openSpace(service.as(ALICE), aliceStore, alice, SPACE);
    await write(service.as(ALICE), alice, aliceView, "project", SPACE, {
      name: "Launch plan",
      instructions: "Be brief.",
    });
    await write(service.as(ALICE), alice, aliceView, "note", crypto.randomUUID(), {
      title: "Venue",
      body: "Book it",
    });

    const link = await invite(service, alice);
    const opened = await openInvitation(service.as(BOB), bob, link.link);
    expect(opened.safetyNumber.join("")).toBe(await safetyNumber(alice.bundle, bob.bundle));
    await acceptInvitation(service.as(BOB), bobStore, bob, opened);
    // Before admission Bob is not a member.
    await expect(openSpace(service.as(BOB), bobStore, bob, SPACE)).rejects.toMatchObject({
      status: 404,
    });

    // The owner's device checks the proof only the link could make.
    const claimed = service.spaces.get(SPACE)?.invitations.get(link.id);
    const acceptance = claimed?.acceptance as { member: IdentityBundle; proof: string };
    expect(acceptance.proof).toBe(
      await acceptanceProof(link.secret, link.id, SPACE, acceptance.member),
    );
    await rotate(service, alice, keys, [alice.bundle, bob.bundle], bob.bundle);

    const bobView = await openSpace(service.as(BOB), bobStore, bob, SPACE);
    expect(bobView.name).toBe("Launch plan");
    expect(itemsOf(bobView, "note")[0]?.data.title).toBe("Venue");
    const conversation = crypto.randomUUID();
    await write(service.as(BOB), bob, bobView, "conversation", conversation, { title: "Planning" });
    await write(service.as(BOB), bob, bobView, "message", crypto.randomUUID(), {
      conversation_id: conversation,
      role: "user",
      text: "Who brings the projector?",
    });
    const { operator, calls } = fakeOperator(() => text("Nobody has said yet."));
    await askAssistant(
      service.as(BOB),
      bob,
      bobView,
      conversation,
      operator,
      "cdm_browser",
      "model-x",
      () => undefined,
    );
    const prompt = calls[0]?.body.messages as { role: string; content: string }[];
    expect(prompt[0]?.content).toContain("Be brief.");
    expect(prompt.at(-1)?.content).toContain("Who brings the projector?");

    aliceView = await openSpace(service.as(ALICE), aliceStore, alice, SPACE);
    const thread = messagesOf(aliceView, conversation);
    expect(thread.map((m) => m.data.text)).toEqual([
      "Who brings the projector?",
      "Nobody has said yet.",
    ]);
    expect(thread[1]?.author).toBe(BOB);
    expect(thread[1]?.data.paid_by).toBe(BOB);
  });

  it("catches a rollback, and a removed member reads nothing written after", async () => {
    const service = new FakeService();
    const alice = await loadIdentity(service.as(ALICE), vault(), ALICE);
    const bob = await loadIdentity(service.as(BOB), vault(), BOB);
    const bobStore = memoryClientStore();
    const keys = await share(service, alice);
    const link = await invite(service, alice);
    await acceptInvitation(
      service.as(BOB),
      bobStore,
      bob,
      await openInvitation(service.as(BOB), bob, link.link),
    );
    await rotate(service, alice, keys, [alice.bundle, bob.bundle], bob.bundle);
    await openSpace(service.as(BOB), bobStore, bob, SPACE);
    await rotate(service, alice, keys, [alice.bundle, bob.bundle]);
    await openSpace(service.as(BOB), bobStore, bob, SPACE);
    // The service shows Bob epoch 2 after he has verified epoch 3.
    service.stale.set(BOB, 2);
    await expect(openSpace(service.as(BOB), bobStore, bob, SPACE)).rejects.toMatchObject({
      code: "space_rollback",
    });

    await rotate(service, alice, keys, [alice.bundle]);
    const aliceView = await openSpace(service.as(ALICE), memoryClientStore(), alice, SPACE);
    await write(service.as(ALICE), alice, aliceView, "note", crypto.randomUUID(), {
      title: "After",
      body: "secret",
    });
    await expect(openSpace(service.as(BOB), bobStore, bob, SPACE)).rejects.toMatchObject({
      status: 404,
    });
    // Even handed the ciphertext, the keys Bob kept open nothing of epoch 4.
    const wire = service.spaces.get(SPACE)?.objects.at(-1) as Stored;
    const author = headMember(service.spaces.get(SPACE)?.heads.at(-1) as EpochHead, ALICE);
    if (!author) throw new Error("author");
    for (const old of keys.slice(0, 3))
      await expect(openObject(old, SPACE, wire, author)).rejects.toThrow();
    expect(wire.epoch).toBe(4);
  });

  it("lets an invitation be used once, by one account, with its secret", async () => {
    const service = new FakeService();
    const alice = await loadIdentity(service.as(ALICE), vault(), ALICE);
    const bob = await loadIdentity(service.as(BOB), vault(), BOB);
    const carol = await loadIdentity(service.as(CAROL), vault(), CAROL);
    await share(service, alice);
    const link = await invite(service, alice);
    // Another secret under the same invitation id opens nothing.
    const dot = link.link.lastIndexOf(".") + 1;
    const tampered = `${link.link.slice(0, dot)}${link.link[dot] === "A" ? "B" : "A"}${link.link.slice(dot + 1)}`;
    await expect(openInvitation(service.as(BOB), bob, tampered)).rejects.toBeTruthy();
    const opened = await openInvitation(service.as(BOB), bob, link.link);
    await acceptInvitation(service.as(BOB), memoryClientStore(), bob, opened);
    await expect(openInvitation(service.as(CAROL), carol, link.link)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      acceptInvitation(service.as(CAROL), memoryClientStore(), carol, opened),
    ).rejects.toMatchObject({ status: 409 });
  });
});
