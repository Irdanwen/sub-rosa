import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  boundedJson,
  readChanges,
  revisionHeads,
  setAccountScope,
  type Change,
} from "../../website/src/lib/api";

beforeEach(() => setAccountScope("test-account"));
afterEach(() => {
  vi.unstubAllGlobals();
  setAccountScope(null);
});
const revision = (id: string, parent: string | null, resolved: string[] = []): Change => ({
  sequence: 1,
  operation_id: id,
  object_id: "object",
  revision: id,
  parent_revision: parent,
  resolved_revisions: resolved,
  kind: "settings",
  ciphertext: "encrypted",
  deleted: false,
  device_id: "device",
});

describe("bounded account transport", () => {
  it("pins requests to the loaded account and fails closed after a cross-tab identity change", async () => {
    const changed = vi.fn();
    window.addEventListener("subrosa:account-session-changed", changed);
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "account_mismatch" } }), { status: 409 }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(api("/api/v1/vault")).rejects.toMatchObject({ code: "account_mismatch" });
    expect(fetch.mock.calls[0][1].headers.get("x-subrosa-account-id")).toBe("test-account");
    expect(changed).toHaveBeenCalledOnce();
    await expect(api("/api/v1/vault")).rejects.toMatchObject({ code: "account_not_loaded" });
    expect(fetch).toHaveBeenCalledOnce();
    window.removeEventListener("subrosa:account-session-changed", changed);
  });
  it("cancels a large streamed response without trusting content-length", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    await expect(boundedJson(new Response(body))).rejects.toMatchObject({
      code: "response_too_large",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("retains concurrent heads until a revision explicitly resolves both", () => {
    const base = revision("base", null),
      a = revision("a", "base"),
      b = revision("b", "base");
    expect(revisionHeads([base, a, b]).map((x) => x.revision)).toEqual(["a", "b"]);
    expect(
      revisionHeads([base, a, b, revision("merge", "a", ["b"])]).map((x) => x.revision),
    ).toEqual(["merge"]);
  });
  it("requests only the selected data kind and rejects a server mixing kinds", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            changes: [{ ...revision("a", null), kind: "note" }],
            cursor: 1,
            has_more: false,
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(readChanges(undefined, "settings")).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(fetch.mock.calls[0][0]).toContain("&kind=settings");
  });
  it("rejects an unchanging cursor instead of looping forever", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: { changes: [], cursor: 0, has_more: true } })),
        ),
    );
    await expect(readChanges()).rejects.toThrow("did not advance");
  });
});
