// Changing who is in a shared project from a tab, against the vectors the app
// generated (`operations` in src-tauri/tests/fixtures/spaces-v1.json, written
// by `client::compose_rotation`): an invitation's request and code, the
// owner's check of an acceptance, an admission, a removal and the rotation
// a member makes after someone signed out. Every request must come out the
// same as the app's, byte for byte once parsed.
// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import vectors from "../../src-tauri/tests/fixtures/spaces-v1.json";
import type { FeatureStore } from "../../website/src/client/feature";
import {
  checkAcceptance,
  composeInvitation,
  composeRotation,
  type Rotation,
} from "../../website/src/client/spaces/membership";
import {
  type Bytes,
  type EpochHead,
  type IdentityBundle,
  IdentitySecret,
  memberFromBundle,
  ROLE_MEMBER,
  unb64,
  verifyNext,
} from "../../website/src/client/spaces/protocol";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

type Name = "alice" | "bob" | "carol";
interface Operation {
  prev_epoch: number;
  key: string;
  request: Rotation;
  hash?: string;
}
const v = vectors as unknown as {
  identities: Record<
    Name,
    { account_id: string; x25519_secret: string; ed25519_seed: string; bundle: IdentityBundle }
  >;
  space: { space_id: string; keys: string[]; heads: EpochHead[]; hashes: string[] };
  invitation: {
    invitation_id: string;
    secret: string;
    code: string;
    payload: Parameters<typeof composeInvitation>[2];
    payload_nonce: string;
  };
  operations: {
    ephemerals_from: string;
    invitation_request: Record<string, string>;
    acceptance_carol: { member: IdentityBundle; proof: string };
    admission: Operation & { known_epochs: number[] };
    removal: Operation & { removed: string };
    departure: Operation & { author: string };
  };
};
const ops = v.operations;
const who = (name: Name) =>
  IdentitySecret.fromSeeds(
    unb64(v.identities[name].x25519_secret),
    unb64(v.identities[name].ed25519_seed),
  );
const id = (name: Name) => v.identities[name].account_id;
const heads = v.space.heads;
const key = (epoch: number) => unb64(v.space.keys[epoch - 1]);
const keys = (upTo: number) =>
  new Map(Array.from({ length: upTo }, (_, i) => [i + 1, key(i + 1)] as [number, Bytes]));
const CREATED = "2026-10-08T12:00:00Z";

/** The same deterministic ephemerals as the Rust vectors: 0xa0, 0xa1, ... */
function ephemerals(): () => Bytes {
  let next = unb64(ops.ephemerals_from)[0];
  return () => new Uint8Array(32).fill(next++) as Bytes;
}

function memoryFeatureStore(): FeatureStore {
  const entries = new Map<string, unknown>();
  return {
    get: async <T>(name: string) => structuredClone(entries.get(name)) as T | undefined,
    put: async (name, value) => void entries.set(name, structuredClone(value)),
    delete: async (name) => void entries.delete(name),
    list: async <T>(prefix = "") =>
      [...entries]
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, value]) => ({ id: name, value: value as T })),
  };
}

const parsed = (rotation: Rotation) => JSON.parse(JSON.stringify(rotation));

describe("membership changes from a tab, as the app makes them", () => {
  it("makes the invitation request and code the app makes", async () => {
    const made = await composeInvitation(
      v.invitation.invitation_id,
      unb64(v.invitation.secret),
      v.invitation.payload,
      unb64(v.invitation.payload_nonce),
    );
    expect(made.request).toEqual(ops.invitation_request);
    expect(made.code).toBe(v.invitation.code);
  });

  it("admits through the link's secret only, and only the account that claimed it", async () => {
    const secrets = memoryFeatureStore();
    const invitation = {
      id: v.invitation.invitation_id,
      expires_at: "2026-10-15T12:00:00Z",
      claimed_by: id("carol"),
      acceptance: ops.acceptance_carol,
    };
    // A link made on another device: nothing here to check the proof with.
    expect((await checkAcceptance(secrets, v.space.space_id, invitation)).state).toBe(
      "unverifiable",
    );
    await secrets.put(`invitation:${invitation.id}`, {
      spaceId: v.space.space_id,
      secret: v.invitation.secret,
      expiresAt: invitation.expires_at,
    });
    const ready = await checkAcceptance(secrets, v.space.space_id, invitation);
    expect(ready).toEqual({ state: "ready", member: ops.acceptance_carol.member });
    // Claimed by Bob with Carol's acceptance, or for another space: refused.
    expect(
      (await checkAcceptance(secrets, v.space.space_id, { ...invitation, claimed_by: id("bob") }))
        .state,
    ).toBe("unverifiable");
    expect(
      (await checkAcceptance(secrets, "0191d1a4-5a00-7000-8000-00000000a0ff", invitation)).state,
    ).toBe("unverifiable");
    // A proof made for another member does not admit this one.
    const swapped = {
      ...invitation,
      claimed_by: id("bob"),
      acceptance: { member: v.identities.bob.bundle, proof: ops.acceptance_carol.proof },
    };
    expect((await checkAcceptance(secrets, v.space.space_id, swapped)).state).toBe("unverifiable");
    expect(
      (await checkAcceptance(secrets, v.space.space_id, { ...invitation, acceptance: null })).state,
    ).toBe("waiting");
  });

  it("admits Carol with her history's keys, as the app does", async () => {
    const carol = ops.acceptance_carol.member;
    const rotation = await composeRotation({
      identity: who("alice"),
      me: id("alice"),
      latest: heads[1],
      keys: keys(2),
      members: [...heads[1].members, memberFromBundle(carol, ROLE_MEMBER)],
      departures: [],
      admission: { invitationId: v.invitation.invitation_id, member: carol },
      key: key(3),
      createdAt: CREATED,
      ephemeral: ephemerals(),
    });
    expect(parsed(rotation)).toEqual(ops.admission.request);
    expect(rotation.head).toEqual(heads[2]);
    // One key per member for epoch 3, then epochs 1 and 2 for Carol.
    expect(rotation.wrapped_keys.map((w) => [w.account_id, w.epoch])).toEqual([
      [id("alice"), 3],
      [id("bob"), 3],
      [id("carol"), 3],
      [id("carol"), 1],
      [id("carol"), 2],
    ]);
  });

  it("removes Bob in a new epoch whose key he is not given", async () => {
    const rotation = await composeRotation({
      identity: who("alice"),
      me: id("alice"),
      latest: heads[2],
      keys: keys(3),
      members: heads[2].members.filter((m) => m.account_id !== ops.removal.removed),
      departures: [],
      admission: null,
      key: key(4),
      createdAt: CREATED,
      ephemeral: ephemerals(),
    });
    expect(parsed(rotation)).toEqual(ops.removal.request);
    expect(rotation.wrapped_keys.some((w) => w.account_id === id("bob"))).toBe(false);
    expect(rotation.admit).toEqual([]);
  });

  it("lets Carol rotate Bob out after he signed himself out, and nothing more", async () => {
    const rotation = await composeRotation({
      identity: who("carol"),
      me: id("carol"),
      latest: heads[2],
      keys: keys(3),
      members: heads[3].members,
      departures: heads[3].departures,
      admission: null,
      key: key(4),
      createdAt: CREATED,
      ephemeral: ephemerals(),
    });
    expect(parsed(rotation)).toEqual(ops.departure.request);
    expect(rotation.head).toEqual(heads[3]);
    // Carol may not take out someone who did not sign: her own check refuses
    // the head before anything is sent.
    await expect(
      composeRotation({
        identity: who("carol"),
        me: id("carol"),
        latest: heads[2],
        keys: keys(3),
        members: heads[3].members,
        departures: [],
        admission: null,
        key: key(4),
        createdAt: CREATED,
      }),
    ).rejects.toMatchObject({ code: "space_invalid" });
    await expect(verifyNext(heads[2], rotation.head)).resolves.toBeUndefined();
  });
});
