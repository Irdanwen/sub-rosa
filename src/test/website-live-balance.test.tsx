// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Operator, readBalance } from "../../website/src/client/carpe-diem";
import { setAccountScope } from "../../website/src/lib/api";
import {
  type DeviceRecord,
  type DeviceStore,
  admitBrowser,
  birthKey,
} from "../../website/src/lib/browser-device";
import { setWebsiteLocale } from "../../website/src/lib/i18n";
import { useLiveBalance } from "../../website/src/pages/browser-device";

/**
 * The account page reads the balance Carpe Diem reports now, with this
 * browser's own bounded key, instead of the last one an app happened to sync.
 */

const ACCOUNT = "0191d1a4-0000-7000-8000-000000000000";
const DEVICE = "0191d1a4-1111-7000-8000-000000000000";
const KEY = `cdm_${"b".repeat(64)}`;

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

/** A browser admitted to the account and holding a key, as the card leaves it. */
async function browserWithKey() {
  const store = memoryStore();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/v1/carpe-diem/assertion")
        return json(200, { data: { assertion: "h.c.s", expires_at: "x" } });
      if (url.endsWith("/partner/keys"))
        return json(201, {
          status: "issued",
          key: KEY,
          keyId: "k1",
          prefix: "cdm_bbbbbbbb...",
          expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          bound: { kind: "browser", dailyCapCredits: 200 },
        });
      return json(200, { data: { id: DEVICE, name: "Browser - Firefox" } });
    }),
  );
  const record = await admitBrowser(store, ACCOUNT, "Browser - Firefox", { recovery_proof: "a" });
  await birthKey(store, record);
  vi.unstubAllGlobals();
  vi.stubGlobal("crypto", webcrypto);
  return store;
}

function Balance({ store, operator }: { store: DeviceStore; operator: Operator }) {
  const [live] = useLiveBalance(ACCOUNT, store, operator);
  return <p>{live.status === "ok" ? `${live.status} ${live.available}` : live.status}</p>;
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  setAccountScope(ACCOUNT);
  setWebsiteLocale("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
  setAccountScope(null);
});

describe("the balance read with this browser's key", () => {
  it("asks /v1/credits with the key, no cookie and no referrer", async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!init) throw new Error("no request options");
      expect(String(url)).toBe("https://op.test/v1/credits");
      expect(init.method).toBe("GET");
      expect(init.credentials).toBe("omit");
      expect(init.referrerPolicy).toBe("no-referrer");
      expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
      return json(200, { availableCredits: 742.5, balanceCredits: 800 });
    });
    expect(await readBalance(KEY, { root: "https://op.test", fetch })).toBe(742.5);
  });

  it("refuses an answer that carries no balance", async () => {
    const fetch = vi.fn(async () => json(200, { balance: "lots" }));
    await expect(readBalance(KEY, { root: "https://op.test", fetch })).rejects.toMatchObject({
      code: "carpe_diem_unavailable",
    });
    const refused = vi.fn(async () => json(401, { code: "AUTH_REQUIRED", error: "Unauthorized" }));
    await expect(
      readBalance(KEY, { root: "https://op.test", fetch: refused }),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED", status: 401 });
  });

  it("shows the balance Carpe Diem reports for the account", async () => {
    const store = await browserWithKey();
    const fetch = vi.fn(async () => json(200, { availableCredits: 1200 }));
    render(<Balance store={store} operator={{ root: "https://op.test", fetch }} />);
    expect(await screen.findByText("ok 1200")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("says it failed rather than showing a stale number", async () => {
    const store = await browserWithKey();
    const fetch = vi.fn(async () => json(503, { code: "BALANCE_CHECK_FAILED" }));
    render(<Balance store={store} operator={{ root: "https://op.test", fetch }} />);
    expect(await screen.findByText("failed")).toBeInTheDocument();
  });

  it("asks nothing when this browser holds no key", async () => {
    const fetch = vi.fn();
    render(<Balance store={memoryStore()} operator={{ root: "https://op.test", fetch }} />);
    expect(await screen.findByText("none")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});
