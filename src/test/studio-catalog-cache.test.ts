import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMediaCatalog, resetMediaCatalogCache } from "../lib/studio/catalog";
import type { MediaCatalog } from "../lib/studio/types";

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));

function pending() {
  let resolve!: (catalog: MediaCatalog) => void;
  const promise = new Promise<MediaCatalog>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("media catalog invalidation", () => {
  beforeEach(() => {
    bridge.invoke.mockReset();
    resetMediaCatalogCache();
  });

  it("keeps an obsolete response from restoring the old backend catalog", async () => {
    const old = pending();
    const current = pending();
    bridge.invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const first = fetchMediaCatalog();
    resetMediaCatalogCache();
    const second = fetchMediaCatalog();
    current.resolve({ backend: "carpe-diem", models: [] });
    await second;
    old.resolve({ backend: "venice", models: [] });
    await first;
    expect((await fetchMediaCatalog()).backend).toBe("carpe-diem");
    expect(bridge.invoke).toHaveBeenCalledTimes(2);
  });

  it("does not let an obsolete completion clear the newer in-flight request", async () => {
    const old = pending();
    const current = pending();
    bridge.invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const first = fetchMediaCatalog();
    resetMediaCatalogCache();
    const second = fetchMediaCatalog();
    old.resolve({ backend: "venice", models: [] });
    await first;
    const third = fetchMediaCatalog();
    expect(bridge.invoke).toHaveBeenCalledTimes(2);
    current.resolve({ backend: "carpe-diem", models: [] });
    expect(await third).toEqual(await second);
  });
});
