// The browser half of the spaces protocol against the vectors the Rust half
// generated (src-tauri/src/account/spaces/protocol_tests.rs). Every value
// must come out the same, byte for byte, and every refusal must agree.
// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import vectors from "../../src-tauri/tests/fixtures/spaces-v1.json";
import {
  acceptanceProof,
  type EpochHead,
  fingerprintDigits,
  headHash,
  headMember,
  hkdf32,
  hpkeOpen,
  hpkeSealWithEphemeral,
  IdentitySecret,
  type IdentityBundle,
  invitationCode,
  inviteToken,
  leaveStatement,
  type ObjectBody,
  objectPlaintext,
  openObject,
  openPayload,
  parseInvitation,
  payloadPlaintext,
  safetyNumber,
  sealObject,
  sealPayload,
  signHead,
  tokenHash,
  unb64,
  unwrapKey,
  verifyBundle,
  verifyChain,
  verifyNext,
  type WireObject,
  wrapKey,
} from "../../website/src/client/spaces/protocol";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

const v = vectors as unknown as {
  hkdf: { ikm: string; info: string; okm: string };
  hpke: Record<string, string>;
  identities: Record<
    "alice" | "bob" | "carol",
    {
      account_id: string;
      x25519_secret: string;
      ed25519_seed: string;
      created_at: string;
      bundle: IdentityBundle;
      fingerprint: string;
    }
  >;
  sealed_identity: {
    vault_key: string;
    account_id: string;
    nonce: string;
    plaintext: string;
    envelope: string;
  };
  safety_number: { alice_bob: string };
  space: {
    space_id: string;
    keys: string[];
    heads: EpochHead[];
    hashes: string[];
    leave_statement_bob_epoch_3: string;
    wrapped_epoch_2_for_bob: { ephemeral_secret: string; sealed: string };
    objects: { body: ObjectBody; plaintext: string; nonce: string; wire: WireObject }[];
  };
  invitation: {
    invitation_id: string;
    secret: string;
    code: string;
    token: string;
    token_hash: string;
    payload: Parameters<typeof sealPayload>[2];
    payload_plaintext: string;
    payload_nonce: string;
    sealed_payload: string;
    acceptance_bob: string;
  };
};
const who = (name: "alice" | "bob" | "carol") =>
  IdentitySecret.fromSeeds(
    unb64(v.identities[name].x25519_secret),
    unb64(v.identities[name].ed25519_seed),
  );
const heads = v.space.heads;
const key = (epoch: number) => unb64(v.space.keys[epoch - 1]);

describe("primitives", () => {
  it("derives HKDF and seals HPKE exactly as Rust does", async () => {
    expect(await hkdf32(unb64(v.hkdf.ikm), v.hkdf.info)).toEqual(unb64(v.hkdf.okm));
    const h = v.hpke;
    const sealed = await hpkeSealWithEphemeral(
      unb64(h.ephemeral_secret),
      unb64(h.recipient_public),
      new TextEncoder().encode(h.info),
      new Uint8Array(0),
      unb64(h.plaintext),
    );
    expect(sealed.enc).toEqual(unb64(h.enc));
    expect(sealed.ct).toEqual(unb64(h.ct));
    const opened = await hpkeOpen(
      unb64(h.recipient_secret),
      unb64(h.enc),
      new TextEncoder().encode(h.info),
      new Uint8Array(0),
      unb64(h.ct),
    );
    expect(opened).toEqual(unb64(h.plaintext));
  });

  it("builds the same self-signed identities, fingerprints and safety number", async () => {
    for (const name of ["alice", "bob", "carol"] as const) {
      const id = v.identities[name];
      expect(await who(name).bundle(id.account_id, id.created_at)).toEqual(id.bundle);
      await verifyBundle(id.bundle);
      expect(await fingerprintDigits(id.bundle)).toBe(id.fingerprint);
    }
    expect(await safetyNumber(v.identities.alice.bundle, v.identities.bob.bundle)).toBe(
      v.safety_number.alice_bob,
    );
    expect(await safetyNumber(v.identities.bob.bundle, v.identities.alice.bundle)).toBe(
      v.safety_number.alice_bob,
    );
    await expect(
      verifyBundle({ ...v.identities.alice.bundle, x25519: v.identities.bob.bundle.x25519 }),
    ).rejects.toThrow();
  });

  it("seals the identity under the vault key byte for byte", async () => {
    const s = v.sealed_identity;
    expect(await who("alice").seal(unb64(s.vault_key), s.account_id, unb64(s.nonce))).toBe(
      s.envelope,
    );
    const opened = await IdentitySecret.open(unb64(s.vault_key), s.account_id, s.envelope);
    expect(await opened.bundle(s.account_id, v.identities.alice.created_at)).toEqual(
      v.identities.alice.bundle,
    );
    await expect(
      IdentitySecret.open(unb64(s.vault_key), v.identities.bob.account_id, s.envelope),
    ).rejects.toThrow();
  });
});

describe("epoch heads", () => {
  it("signs every head of the chain to the same bytes and hashes", async () => {
    const ids = {
      [v.identities.alice.account_id]: who("alice"),
      [v.identities.carol.account_id]: who("carol"),
    };
    for (const [index, head] of heads.entries()) {
      const remade = await signHead(
        {
          spaceId: head.space_id,
          epoch: head.epoch,
          prev: index ? heads[index - 1] : null,
          owner: head.owner,
          members: head.members,
          key: key(head.epoch),
          author: head.author,
          departures: head.departures,
          createdAt: head.created_at,
        },
        ids[head.author],
      );
      expect(remade).toEqual(head);
      expect(await headHash(head)).toBe(v.space.hashes[index]);
    }
    expect(await leaveStatement(who("bob"), v.space.space_id, 3, v.identities.bob.account_id)).toBe(
      v.space.leave_statement_bob_epoch_3,
    );
  });

  it("verifies the chain from the inviter and refuses another anchor", async () => {
    expect((await verifyChain(null, heads, v.identities.alice.bundle)).epoch).toBe(4);
    await expect(verifyChain(null, heads, v.identities.bob.bundle)).rejects.toThrow();
  });

  it("detects a rollback and a fork against the trusted head", async () => {
    await expect(verifyChain(heads[2], heads.slice(0, 2), null)).rejects.toMatchObject({
      code: "space_rollback",
    });
    const fork = await signHead(
      {
        spaceId: v.space.space_id,
        epoch: 3,
        prev: heads[1],
        owner: heads[1].owner,
        members: [heads[0].members[0]],
        key: key(1),
        author: heads[1].owner,
        departures: [],
        createdAt: heads[2].created_at,
      },
      who("alice"),
    );
    await expect(verifyChain(heads[2], [heads[0], heads[1], fork], null)).rejects.toMatchObject({
      code: "space_rollback",
    });
  });

  it("refuses a member who adds someone, and a departure nobody signed", async () => {
    const bob = v.identities.bob.account_id;
    const added = await signHead(
      {
        spaceId: v.space.space_id,
        epoch: 3,
        prev: heads[1],
        owner: heads[1].owner,
        members: heads[2].members,
        key: key(3),
        author: bob,
        departures: [],
        createdAt: heads[2].created_at,
      },
      who("bob"),
    );
    await expect(verifyNext(heads[1], added)).rejects.toThrow();
    const forged = await signHead(
      {
        spaceId: v.space.space_id,
        epoch: 4,
        prev: heads[2],
        owner: heads[2].owner,
        members: heads[3].members,
        key: key(4),
        author: heads[3].author,
        departures: [
          {
            account_id: bob,
            signature: await leaveStatement(who("carol"), v.space.space_id, 3, bob),
          },
        ],
        createdAt: heads[3].created_at,
      },
      who("carol"),
    );
    await expect(verifyNext(heads[2], forged)).rejects.toThrow();
    await expect(verifyNext(heads[2], heads[3])).resolves.toBeUndefined();
  });
});

describe("wrapped keys and objects", () => {
  it("wraps and unwraps the epoch key as Rust does, and checks the commitment", async () => {
    const w = v.space.wrapped_epoch_2_for_bob;
    const bob = v.identities.bob;
    expect(
      await wrapKey(
        key(2),
        bob.bundle.x25519,
        v.space.space_id,
        2,
        bob.account_id,
        unb64(w.ephemeral_secret),
      ),
    ).toBe(w.sealed);
    expect(await unwrapKey(who("bob"), w.sealed, heads[1], bob.account_id)).toEqual(key(2));
    const substituted = await wrapKey(
      unb64("E".repeat(43)),
      bob.bundle.x25519,
      v.space.space_id,
      2,
      bob.account_id,
    );
    await expect(unwrapKey(who("bob"), substituted, heads[1], bob.account_id)).rejects.toThrow();
    await expect(unwrapKey(who("bob"), w.sealed, heads[2], bob.account_id)).rejects.toThrow();
  });

  it("seals and opens every object kind exactly as Rust does", async () => {
    const signer = {
      [v.identities.alice.account_id]: who("alice"),
      [v.identities.carol.account_id]: who("carol"),
    };
    for (const object of v.space.objects) {
      expect(JSON.parse(objectPlaintext(object.body))).toEqual(JSON.parse(object.plaintext));
      const sealed = await sealObject(
        key(4),
        v.space.space_id,
        object.wire.epoch,
        object.body,
        signer[object.body.author],
        unb64(object.nonce),
        object.plaintext,
      );
      expect(sealed.ciphertext).toBe(object.wire.ciphertext);
      expect(sealed.signature).toBe(object.wire.signature);
      const author = headMember(heads[3], object.wire.author_account_id);
      if (!author) throw new Error("author");
      expect(await openObject(key(4), v.space.space_id, object.wire, author)).toEqual(object.body);
    }
  });

  it("refuses an object moved, re-attributed, or opened with an older key", async () => {
    const note = v.space.objects[1];
    const alice = headMember(heads[3], v.identities.alice.account_id);
    const carol = headMember(heads[3], v.identities.carol.account_id);
    if (!alice || !carol) throw new Error("members");
    await expect(
      openObject(
        key(4),
        v.space.space_id,
        { ...note.wire, object_id: v.space.objects[2].wire.object_id },
        alice,
      ),
    ).rejects.toThrow();
    await expect(
      openObject(
        key(4),
        v.space.space_id,
        { ...note.wire, author_account_id: carol.account_id },
        carol,
      ),
    ).rejects.toThrow();
    // A member removed at epoch 4 holds the epoch 3 key, which opens nothing
    // written in epoch 4, even relabelled.
    await expect(openObject(key(3), v.space.space_id, note.wire, alice)).rejects.toThrow();
    await expect(
      openObject(key(3), v.space.space_id, { ...note.wire, epoch: 3 }, alice),
    ).rejects.toThrow();
  });
});

describe("invitations", () => {
  it("derives the token, seals the payload and proves acceptance as Rust does", async () => {
    const i = v.invitation;
    const secret = unb64(i.secret);
    expect(invitationCode(i.invitation_id, secret)).toBe(i.code);
    const parsed = parseInvitation(`https://example.test/app#join=${i.code}`);
    expect(parsed.invitationId).toBe(i.invitation_id);
    expect(parsed.secret).toEqual(secret);
    const token = await inviteToken(secret, i.invitation_id);
    expect(token).toEqual(unb64(i.token));
    expect(await tokenHash(token)).toBe(i.token_hash);
    expect(JSON.parse(payloadPlaintext(i.payload))).toEqual(JSON.parse(i.payload_plaintext));
    expect(
      await sealPayload(
        secret,
        i.invitation_id,
        i.payload,
        unb64(i.payload_nonce),
        i.payload_plaintext,
      ),
    ).toBe(i.sealed_payload);
    expect(await openPayload(secret, i.invitation_id, i.sealed_payload)).toEqual(i.payload);
    expect(
      await acceptanceProof(secret, i.invitation_id, v.space.space_id, v.identities.bob.bundle),
    ).toBe(i.acceptance_bob);
  });

  it("refuses a replayed or substituted acceptance and a damaged code", async () => {
    const i = v.invitation;
    const secret = unb64(i.secret);
    expect(
      await acceptanceProof(secret, i.invitation_id, v.space.space_id, v.identities.carol.bundle),
    ).not.toBe(i.acceptance_bob);
    expect(
      await acceptanceProof(
        secret,
        "0191d1a4-1000-7000-8000-00000000f002",
        v.space.space_id,
        v.identities.bob.bundle,
      ),
    ).not.toBe(i.acceptance_bob);
    await expect(
      openPayload(unb64("A".repeat(43)), i.invitation_id, i.sealed_payload),
    ).rejects.toMatchObject({
      code: "space_invitation_invalid",
    });
    expect(() => parseInvitation(i.code.slice(0, -3))).toThrow();
    expect(() => parseInvitation("srspace1.nope.AAAA")).toThrow();
  });
});
