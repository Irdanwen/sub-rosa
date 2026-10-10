// Tests run in Node; the application tsconfig intentionally has no Node globals.
// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAccountScope } from "../../website/src/lib/api";
import {
  CARPE_DIEM_OPERATOR,
  DEVICE_PROOF_HEADER,
  type DeviceRecord,
  type DeviceStore,
  admitBrowser,
  birthKey,
  browserFamily,
  deviceProof,
  forgetBrowser,
  needsRenewal,
  openKey,
  operatorRoot,
  thumbprint,
} from "../../website/src/lib/browser-device";
import {
  decode,
  encode,
  prepareVault,
  recoveryAdmissionProof,
  verifierFor,
} from "../../website/src/lib/vault";

const ACCOUNT = "0191d1a4-0000-7000-8000-000000000000";
const DEVICE = "0191d1a4-1111-7000-8000-000000000000";

function memoryStore(): DeviceStore & { rows: Map<string, DeviceRecord> } {
  const rows = new Map<string, DeviceRecord>();
  return {
    rows,
    async get(id) {
      return rows.get(id) ?? null;
    },
    async put(record) {
      rows.set(record.accountId, record);
    },
    async delete(id) {
      rows.delete(id);
    },
  };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const part = (jws: string, index: number) =>
  JSON.parse(new TextDecoder().decode(decode(jws.split(".")[index])));
async function verifies(jws: string, jwk: { x: string; y: string }) {
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const [h, p, s] = jws.split(".");
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    decode(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
}
async function sha(value: string) {
  return encode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  );
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  setAccountScope(ACCOUNT);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setAccountScope(null);
});

describe("the browser device key", () => {
  it("computes the same RFC 7638 thumbprint the account service pins", async () => {
    // The vector of subrosa-services' browser.rs test, computed outside both.
    expect(
      await thumbprint(
        "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
        "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
      ),
    ).toBe("oKIywvGUpTVTyxMQ3bwIIeQUudfr_CkLMjCE19ECD-U");
  });

  it("names a browser by its family only", () => {
    const ua = {
      firefox:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:128.0) Gecko/20100101 Firefox/128.0",
      edge: "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0",
      chrome: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
      safari: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15",
    };
    expect(browserFamily(ua.firefox)).toBe("Firefox");
    expect(browserFamily(ua.edge)).toBe("Edge");
    expect(browserFamily(ua.chrome)).toBe("Chrome");
    expect(browserFamily(ua.safari)).toBe("Safari");
    expect(browserFamily("curl/8")).toBe("");
  });

  it("talks to the production operator unless a build names an HTTPS or loopback one", () => {
    expect(CARPE_DIEM_OPERATOR).toBe("https://carpe-diem.xyz/api/operator");
    expect(operatorRoot(undefined)).toBe("https://carpe-diem.xyz/api/operator");
    expect(operatorRoot("http://127.0.0.1:3001/")).toBe("http://127.0.0.1:3001");
    expect(operatorRoot("http://evil.example/api")).toBe("https://carpe-diem.xyz/api/operator");
    expect(operatorRoot("javascript:alert(1)")).toBe("https://carpe-diem.xyz/api/operator");
  });

  it("is admitted with a proof the service can check, and never lands in localStorage", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const store = memoryStore();
    const fetch = vi.fn(async (_path: string, init: RequestInit) => {
      // The record exists before the request, so a lost answer is recoverable.
      expect(store.rows.get(ACCOUNT)?.deviceId).toBeNull();
      const proof = new Headers(init.headers).get(DEVICE_PROOF_HEADER) ?? "";
      const header = part(proof, 0);
      expect(header).toMatchObject({ alg: "ES256", typ: "subrosa-device+jwt" });
      expect(header.jwk).not.toHaveProperty("d");
      expect(await verifies(proof, header.jwk)).toBe(true);
      expect(part(proof, 1)).toMatchObject({
        htm: "POST",
        htu: `${location.origin}/api/v1/browser-devices`,
        // Bound to the body exactly as sent, so it cannot carry another admission.
        ath: await sha(String(init.body)),
      });
      expect(JSON.parse(String(init.body))).toEqual({
        name: "Browser - Firefox",
        admission: { recovery_proof: "abc" },
      });
      return json(200, { data: { id: DEVICE, name: "Browser - Firefox", kind: "browser" } });
    });
    vi.stubGlobal("fetch", fetch);
    const record = await admitBrowser(store, ACCOUNT, "Browser - Firefox", {
      recovery_proof: "abc",
    });
    expect(record.deviceId).toBe(DEVICE);
    expect(record.signing.extractable).toBe(false);
    expect(record.wrapping.extractable).toBe(false);
    expect(store.rows.get(ACCOUNT)?.deviceId).toBe(DEVICE);
    // Once admitted, proofs name the device instead of carrying the key.
    const later = await deviceProof(record, "/api/v1/browser-devices/renounce", "{}");
    expect(part(later, 0)).toEqual({ alg: "ES256", typ: "subrosa-device+jwt", kid: DEVICE });
    expect(part(later, 1).ath).toBe(await sha("{}"));
    expect(await verifies(later, record)).toBe(true);
    // The vector the service's browser.rs test pins: SHA-256 of no bytes.
    const empty = await deviceProof(record, "/api/v1/browser-devices/renounce", "");
    expect(part(empty, 1).ath).toBe("47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU");
    expect(storage).not.toHaveBeenCalled();
  });

  it("forgets the key pair when the service refuses the admission", async () => {
    const store = memoryStore();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(403, { error: { code: "admission_required" } })),
    );
    await expect(
      admitBrowser(store, ACCOUNT, "Browser", { pairing_request_id: DEVICE }),
    ).rejects.toMatchObject({ code: "admission_required" });
    expect(store.rows.size).toBe(0);
  });
});

async function admitted(store: ReturnType<typeof memoryStore>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(200, { data: { id: DEVICE, name: "Browser - Firefox" } })),
  );
  return admitBrowser(store, ACCOUNT, "Browser - Firefox", { recovery_proof: "abc" });
}

describe("key birth for a browser device", () => {
  it("binds the assertion to an ephemeral key and keeps only ciphertext at rest", async () => {
    const store = memoryStore();
    const record = await admitted(store);
    const minted = `cdm_${"a".repeat(64)}`;
    let jkt = "";
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      if (url === "/api/v1/carpe-diem/assertion") {
        jkt = JSON.parse(String(init.body)).jkt;
        const proof = headers.get(DEVICE_PROOF_HEADER) ?? "";
        expect(part(proof, 0).kid).toBe(DEVICE);
        // The body, not the thumbprint alone: the service hashes the bytes.
        expect(String(init.body)).toBe(JSON.stringify({ jkt }));
        expect(part(proof, 1).ath).toBe(await sha(String(init.body)));
        return json(200, { data: { assertion: "header.claims.signature", expires_at: "x" } });
      }
      expect(url).toBe(`${CARPE_DIEM_OPERATOR}/partner/keys`);
      expect(init.credentials).toBe("omit");
      expect(headers.get("Authorization")).toBe("PartnerAssertion header.claims.signature");
      const dpop = headers.get("DPoP") ?? "";
      const header = part(dpop, 0);
      expect(header.typ).toBe("dpop+jwt");
      expect(await thumbprint(header.jwk.x, header.jwk.y)).toBe(jkt);
      expect(await verifies(dpop, header.jwk)).toBe(true);
      expect(part(dpop, 1)).toMatchObject({
        htm: "POST",
        htu: `${CARPE_DIEM_OPERATOR}/partner/keys`,
        ath: await sha("header.claims.signature"),
      });
      return json(201, {
        status: "issued",
        key: minted,
        keyId: "k1",
        prefix: "cdm_aaaaaaaa...",
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        bound: { kind: "browser", dailyCapCredits: 150 },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const birth = await birthKey(store, record);
    expect(birth.status).toBe("issued");
    const stored = store.rows.get(ACCOUNT);
    expect(stored?.key?.dailyCapCredits).toBe(150);
    expect(JSON.stringify(stored?.key)).not.toContain(minted.slice(4, 20));
    expect(stored && (await openKey(stored))).toBe(minted);
    expect(needsRenewal(stored ?? null)).toBe(false);
    expect(needsRenewal(stored ?? null, Date.now() + 6 * 86_400_000)).toBe(true);
    // Sealed for this device: a record under another device id cannot open it.
    await expect(openKey({ ...(stored as DeviceRecord), deviceId: "other" })).rejects.toThrow();
  });

  it("waits for a Carpe Diem confirmation with the same ephemeral key", async () => {
    const store = memoryStore();
    const record = await admitted(store);
    const keys: string[] = [];
    let polls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/v1/carpe-diem/assertion")
          return json(200, { data: { assertion: "a.b.c", expires_at: "x" } });
        const dpop = new Headers(init.headers).get("DPoP") ?? "";
        keys.push(part(dpop, 0).jwk.x);
        if (url.endsWith("/partner/keys"))
          return json(202, {
            status: "confirmation_required",
            linkRequestId: "11111111-2222-4333-8444-555555555555",
            code: "K7Q2MX",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
            emailHint: "m***@example.com",
          });
        expect(part(dpop, 1).ath).toBe(await sha("11111111-2222-4333-8444-555555555555"));
        polls += 1;
        return polls === 1
          ? json(202, { status: "pending" })
          : json(201, {
              status: "issued",
              key: `cdm_${"b".repeat(64)}`,
              keyId: "k",
              prefix: "p",
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
              bound: { kind: "browser", dailyCapCredits: 200 },
            });
      }),
    );
    const birth = await birthKey(store, record);
    if (birth.status !== "confirmation_required") throw new Error("expected a confirmation");
    expect(birth.code).toBe("K7Q2MX");
    expect((await birth.poll()).status).toBe("pending");
    const done = await birth.poll();
    expect(done.status).toBe("issued");
    expect(new Set(keys).size).toBe(1);
    expect(store.rows.get(ACCOUNT)?.key?.dailyCapCredits).toBe(200);
  });

  it("revokes and refuses a key Carpe Diem minted without the browser bound", async () => {
    const store = memoryStore();
    const record = await admitted(store);
    const revoked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/v1/carpe-diem/assertion")
          return json(200, { data: { assertion: "a.b.c" } });
        if (url.endsWith("/v1/keys/self/revoke")) {
          revoked.push(new Headers(init.headers).get("Authorization") ?? "");
          return json(200, { status: "revoked" });
        }
        // An operator that predates section 7 of the contract.
        return json(201, {
          status: "issued",
          key: `cdm_${"e".repeat(64)}`,
          keyId: "k",
          prefix: "p",
        });
      }),
    );
    await expect(birthKey(store, record)).rejects.toMatchObject({ code: "unbounded_key" });
    expect(revoked).toEqual([`Bearer cdm_${"e".repeat(64)}`]);
    expect(store.rows.get(ACCOUNT)?.key).toBeNull();
  });

  it("forgets everything, telling the service and Carpe Diem, even offline", async () => {
    const store = memoryStore();
    const record = await admitted(store);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/v1/carpe-diem/assertion"
          ? json(200, { data: { assertion: "a.b.c" } })
          : json(201, {
              status: "issued",
              key: `cdm_${"c".repeat(64)}`,
              keyId: "k",
              prefix: "p",
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
              bound: { kind: "browser", dailyCapCredits: 200 },
            }),
      ),
    );
    const birth = await birthKey(store, record);
    if (birth.status !== "issued") throw new Error("expected a key");
    const calls: string[] = [];
    const proofs: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        calls.push(`${url} ${headers.get("Authorization") ?? ""}`);
        const proof = headers.get(DEVICE_PROOF_HEADER);
        if (proof) proofs.push(`${part(proof, 1).ath} ${await sha(String(init.body))}`);
        throw new TypeError("offline");
      }),
    );
    await forgetBrowser(store, birth.record);
    expect(proofs).toEqual([`${await sha("{}")} ${await sha("{}")}`]);
    expect(calls).toContain("/api/v1/browser-devices/renounce ");
    expect(calls).toContain(
      `${CARPE_DIEM_OPERATOR}/v1/keys/self/revoke Bearer cdm_${"c".repeat(64)}`,
    );
    expect(store.rows.size).toBe(0);
  });
});

describe("admission by the recovery key", () => {
  it("derives the value the service compares, and the vault writes its verifier", async () => {
    // HKDF-SHA256 computed outside this code base with Python's hmac module.
    const code = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
    const proof = await recoveryAdmissionProof(ACCOUNT, code);
    expect(encode(proof)).toBe("t-sEm2vQ0uX9A8ZPTGnP8MFmCnXjqU16T18eu-kesmE");
    expect(await verifierFor(proof)).toBe("GxpCp4mXtbThnU4jYUg_6cxEBblYbbmvjcSmG-I8NN8");
    // Bound to the account: the same key proves nothing for another one.
    expect(encode(await recoveryAdmissionProof(crypto.randomUUID(), code))).not.toBe(encode(proof));
    const prepared = await prepareVault(ACCOUNT);
    expect(prepared.admissionVerifier).toBe(
      await verifierFor(await recoveryAdmissionProof(ACCOUNT, prepared.recoveryCode)),
    );
    prepared.key.fill(0);
    await expect(recoveryAdmissionProof(ACCOUNT, "short")).rejects.toThrow();
  });
});
