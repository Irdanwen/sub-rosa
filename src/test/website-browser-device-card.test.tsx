// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Device, setAccountScope } from "../../website/src/lib/api";
import {
  type DeviceRecord,
  type DeviceStore,
  admitBrowser,
} from "../../website/src/lib/browser-device";
import { BrowserDeviceCard, deviceKindLabel } from "../../website/src/pages/browser-device";

const ACCOUNT = "0191d1a4-0000-7000-8000-000000000000";
const DEVICE = "0191d1a4-1111-7000-8000-000000000000";
const RECOVERY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";

function memoryStore(): DeviceStore & { rows: Map<string, DeviceRecord> } {
  const rows = new Map<string, DeviceRecord>();
  return {
    rows,
    get: async (id) => rows.get(id) ?? null,
    put: async (record) => {
      rows.set(record.accountId, record);
    },
    delete: async (id) => {
      rows.delete(id);
    },
  };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const device = (over: Partial<Device> = {}): Device => ({
  id: DEVICE,
  name: "Browser - Firefox",
  created_at: "2026-10-08T10:00:00Z",
  last_seen_at: null,
  revoked_at: null,
  kind: "browser",
  ...over,
});

function Harness({
  store,
  devices,
  initial = null,
}: {
  store: DeviceStore;
  devices: Device[] | null;
  initial?: DeviceRecord | null;
}) {
  const [record, setRecord] = useState<DeviceRecord | null>(initial);
  return (
    <BrowserDeviceCard
      accountId={ACCOUNT}
      devices={devices}
      record={record}
      setRecord={setRecord}
      onDevicesChanged={() => undefined}
      store={store}
    />
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

describe("this browser as a device", () => {
  it("joins with the recovery key, sending only the derived value, then gets its key", async () => {
    const store = memoryStore();
    const bodies: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        bodies[url] = JSON.parse(String(init.body));
        if (url === "/api/v1/browser-devices")
          return json(200, { data: { id: DEVICE, name: "Browser - Firefox" } });
        if (url === "/api/v1/carpe-diem/assertion")
          return json(200, { data: { assertion: "a.b.c" } });
        return json(201, {
          status: "issued",
          key: `cdm_${"d".repeat(64)}`,
          keyId: "k",
          prefix: "cdm_dddddddd...",
          expiresAt: "2026-10-15T10:00:00Z",
          bound: { kind: "browser", dailyCapCredits: 200 },
        });
      }),
    );
    const user = userEvent.setup();
    render(<Harness store={store} devices={[]} />);
    await user.click(screen.getByRole("button", { name: "Use this browser as a device" }));
    await user.click(screen.getByRole("button", { name: "Use my recovery key" }));
    await user.type(screen.getByLabelText("Recovery key"), RECOVERY);
    await user.click(screen.getByRole("button", { name: "Add this browser" }));
    await waitFor(() => expect(screen.getByText(/cdm_dddddddd\.\.\./)).toBeTruthy());
    expect(screen.getByText(/at most 200 credits a day/)).toBeTruthy();
    // The derived value, never the recovery key itself.
    expect(JSON.stringify(bodies)).not.toContain(RECOVERY);
    expect(bodies["/api/v1/browser-devices"]).toMatchObject({
      admission: { recovery_proof: "t-sEm2vQ0uX9A8ZPTGnP8MFmCnXjqU16T18eu-kesmE" },
    });
    expect(store.rows.get(ACCOUNT)?.key?.prefix).toBe("cdm_dddddddd...");
  });

  it("asks for a fresh sign-in when the service wants one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(403, { error: { code: "recent_auth_required" } })),
    );
    const user = userEvent.setup();
    render(<Harness store={memoryStore()} devices={[]} />);
    await user.click(screen.getByRole("button", { name: "Use this browser as a device" }));
    await user.click(screen.getByRole("button", { name: "Use my recovery key" }));
    await user.type(screen.getByLabelText("Recovery key"), RECOVERY);
    await user.click(screen.getByRole("button", { name: "Add this browser" }));
    const link = await screen.findByRole("link", { name: "Sign in again" });
    expect(link.getAttribute("href")).toBe("/auth/login?return_to=/account/devices");
  });

  it("deletes its keys when the device was revoked elsewhere", async () => {
    const store = memoryStore();
    const record = {
      accountId: ACCOUNT,
      deviceId: DEVICE,
      name: "Browser - Firefox",
      x: "x",
      y: "y",
      signing: {} as CryptoKey,
      wrapping: {} as CryptoKey,
      key: null,
    } satisfies DeviceRecord;
    await store.put(record);
    render(
      <Harness
        store={store}
        devices={[device({ revoked_at: "2026-10-08T11:00:00Z" })]}
        initial={record}
      />,
    );
    await screen.findByText(/This browser was removed from your devices/);
    expect(store.rows.size).toBe(0);
  });

  it("labels this browser, other browsers and apps apart in the list", () => {
    expect(deviceKindLabel(device(), DEVICE)).toBe("This browser");
    expect(deviceKindLabel(device(), "other")).toBe("Browser");
    expect(deviceKindLabel(device({ kind: "native" }), DEVICE.replace("1111", "2222"))).toBe("App");
    expect(deviceKindLabel(device({ kind: undefined, id: "x" }), null)).toBe("App");
  });

  it("says the Carpe Diem account was deleted, drops the dead key, and asks before a new one", async () => {
    const store = memoryStore();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, { data: { id: DEVICE, name: "Browser - Firefox" } })),
    );
    const admitted = await admitBrowser(store, ACCOUNT, "Browser - Firefox", {
      recovery_proof: "abc",
    });
    // A key that runs out tomorrow: the page renews it, and learns of the deletion.
    const record = {
      ...admitted,
      key: {
        iv: "",
        ciphertext: "",
        keyId: "old",
        prefix: "cdm_old...",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        dailyCapCredits: 200,
      },
    };
    await store.put(record);
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/v1/carpe-diem/assertion")
          return json(200, { data: { assertion: "a.b.c" } });
        bodies.push(String(init.body));
        return bodies.length === 1
          ? json(410, { code: "ACCOUNT_CLOSED", closedAt: "2026-10-10T12:30:00.000Z" })
          : json(201, {
              status: "issued",
              key: `cdm_${"9".repeat(64)}`,
              keyId: "k",
              prefix: "cdm_99999999...",
              expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
              bound: { kind: "browser", dailyCapCredits: 200 },
            });
      }),
    );
    const user = userEvent.setup();
    render(<Harness store={store} devices={[device()]} initial={record} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Your Carpe Diem account was deleted on .*2026.*Its credits are gone and cannot be refunded\./,
    );
    expect(store.rows.get(ACCOUNT)?.key).toBeNull();
    expect(screen.queryByText(/cdm_old/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Get a Carpe Diem key" })).toBeNull();
    expect(bodies).toEqual(["{}"]);

    await user.click(screen.getByRole("button", { name: "Open a new, empty account" }));
    await waitFor(() => expect(screen.getByText(/cdm_99999999\.\.\./)).toBeTruthy());
    expect(bodies).toEqual(["{}", '{"reactivate":true}']);
  });
});
