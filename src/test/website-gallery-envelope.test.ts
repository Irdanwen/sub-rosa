// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openChunk, sealBytes } from "../../website/src/client/gallery";

// A chunk in the account is stored in one of two envelopes (ADR-0110): the
// JSON text one every chunk used to have, and the binary one compact copies
// use, `[2][nonce 12][ciphertext and tag]`, as `crypto::seal_binary` writes.
// The browser reads both, whether the transport hands it text or bytes.

const KEY = () => new Uint8Array(32).fill(7);
const CONTEXT = "subrosa:blob:v1:account:chunk";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

async function sealBinary(clear: Uint8Array<ArrayBuffer>, context: string): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", KEY(), "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: new TextEncoder().encode(context),
        tagLength: 128,
      },
      key,
      clear,
    ),
  );
  const sealed = new Uint8Array(1 + 12 + ciphertext.length);
  sealed[0] = 2;
  sealed.set(nonce, 1);
  sealed.set(ciphertext, 13);
  return sealed;
}

describe("a stored chunk", () => {
  const clear = new Uint8Array([1, 2, 3, 250, 251, 252]);

  it("opens from the binary envelope, a quarter smaller than the text one", async () => {
    const binary = await sealBinary(clear, CONTEXT);
    expect(binary.length).toBe(1 + 12 + clear.length + 16);
    expect(await openChunk(KEY(), binary, CONTEXT)).toEqual(clear);
  });

  it("opens from the text envelope, given as text or as bytes", async () => {
    const text = await sealBytes(KEY(), clear, CONTEXT);
    expect(await openChunk(KEY(), text, CONTEXT)).toEqual(clear);
    expect(await openChunk(KEY(), new TextEncoder().encode(text), CONTEXT)).toEqual(clear);
  });

  it("refuses a chunk moved under another id or altered", async () => {
    const binary = await sealBinary(clear, CONTEXT);
    await expect(openChunk(KEY(), binary, `${CONTEXT}-other`)).rejects.toThrow();
    const altered = binary.slice();
    altered[20] ^= 1;
    await expect(openChunk(KEY(), altered, CONTEXT)).rejects.toThrow();
    await expect(openChunk(KEY(), new Uint8Array([2, 0, 0]), CONTEXT)).rejects.toThrow();
  });
});
