// Tests run in Node; the application tsconfig intentionally has no Node globals.
// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../src-tauri/tests/fixtures/account-vault-v1.json";
import {
  decode,
  decrypt,
  decryptObject,
  encrypt,
  prepareVault,
  unlockVault,
} from "../../website/src/lib/vault";
import { registerAccountNavigation } from "../../website/src/lib/webmcp";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe("browser and native encrypted vault contract", () => {
  it("decrypts the same fixed WebCrypto fixture that Rust verifies", async () => {
    expect(
      await decrypt(decode(fixture.key), JSON.stringify(fixture.envelope), fixture.aad),
    ).toEqual(JSON.parse(fixture.plaintext));
  });
  it("recovers a newly created vault without saving secrets in browser storage", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const account = crypto.randomUUID();
    const prepared = await prepareVault(account);
    const key = await unlockVault(account, prepared.recoveryCode, {
      version: 1,
      envelope: prepared.envelope,
    });
    expect(key).toEqual(prepared.key);
    expect(storage).not.toHaveBeenCalled();
    key.fill(0);
    prepared.key.fill(0);
    storage.mockRestore();
  });
  it("refuses a different account, wrong key, changed ciphertext and unsupported version", async () => {
    const key = decode(fixture.key);
    await expect(
      decrypt(key, JSON.stringify(fixture.envelope), "another-account"),
    ).rejects.toThrow();
    await expect(
      decrypt(new Uint8Array(32), JSON.stringify(fixture.envelope), fixture.aad),
    ).rejects.toThrow();
    await expect(
      decrypt(
        key,
        JSON.stringify({
          ...fixture.envelope,
          ciphertext: `A${fixture.envelope.ciphertext.slice(1)}`,
        }),
        fixture.aad,
      ),
    ).rejects.toThrow();
    await expect(
      decrypt(key, JSON.stringify({ ...fixture.envelope, v: 2 }), fixture.aad),
    ).rejects.toThrow();
  });
  it("binds server revision metadata to the encrypted operation", async () => {
    const key = decode(fixture.key),
      account = crypto.randomUUID(),
      id = crypto.randomUUID(),
      operation = crypto.randomUUID();
    const ciphertext = await encrypt(
      key,
      {
        v: 1,
        operation_id: operation,
        parent_revision: null,
        deleted: false,
        table: "notes",
        row: { id, title: "Private" },
      },
      `subrosa:object:v1:${account}:note:${id}`,
    );
    const change = {
      sequence: 1,
      operation_id: operation,
      object_id: id,
      revision: crypto.randomUUID(),
      parent_revision: null,
      kind: "note",
      ciphertext,
      deleted: false,
      device_id: crypto.randomUUID(),
    };
    expect((await decryptObject(key, account, change)).row.title).toBe("Private");
    await expect(decryptObject(key, account, { ...change, deleted: true })).rejects.toThrow(
      "metadata",
    );
    await expect(
      decryptObject(key, account, { ...change, parent_revision: crypto.randomUUID() }),
    ).rejects.toThrow("metadata");
    await expect(
      decryptObject(key, account, { ...change, operation_id: crypto.randomUUID() }),
    ).rejects.toThrow("metadata");
  });
  it("randomizes each encryption even for identical plaintext", async () => {
    const key = decode(fixture.key);
    expect(await encrypt(key, { text: "same" }, "context")).not.toEqual(
      await encrypt(key, { text: "same" }, "context"),
    );
  });
});

describe("optional account navigation tool", () => {
  it("navigates only to known sections and unregisters with its lifecycle", async () => {
    const registerTool = vi.fn();
    Object.defineProperty(document, "modelContext", {
      value: { registerTool },
      configurable: true,
    });
    const navigate = vi.fn();
    const cleanup = registerAccountNavigation(navigate);
    const [tool, options] = registerTool.mock.calls[0];
    expect(tool.execute({ section: "devices" })).toEqual({
      path: "/account/devices",
      action: "navigation_started",
    });
    expect(navigate).toHaveBeenCalledWith("/account/devices");
    expect(() => tool.execute({ section: "https://attacker.test" })).toThrow();
    expect(() => tool.execute({ section: "devices", secret: "never" })).toThrow();
    expect(navigate).toHaveBeenCalledTimes(1);
    cleanup();
    expect(options.signal.aborted).toBe(true);
    Reflect.deleteProperty(document, "modelContext");
  });
});
