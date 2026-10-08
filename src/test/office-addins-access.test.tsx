import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAccountScope, setApiTransport } from "../../website/src/lib/api";
import type { DeviceRecord, DeviceStore } from "../../website/src/lib/browser-device";
import type { OfficeGlobal } from "../../office-addins/src/office";
import { hasLiveKey, OfficeAccess } from "../../office-addins/src/pane/Access";
import { SessionWindow, SIGN_IN_URL } from "../../office-addins/src/session/SessionWindow";

const ACCOUNT = "0191d1a4-0000-7000-8000-000000000000";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function memoryStore(rows: DeviceRecord[] = []): DeviceStore {
  const map = new Map(rows.map((row) => [row.accountId, row]));
  return {
    get: async (id) => map.get(id) ?? null,
    put: async (record) => {
      map.set(record.accountId, record);
    },
    delete: async (id) => {
      map.delete(id);
    },
  };
}
const record = (expiresAt: string): DeviceRecord =>
  ({
    accountId: ACCOUNT,
    deviceId: "dev",
    name: "Office add-in - Word",
    x: "x",
    y: "y",
    signing: {} as CryptoKey,
    wrapping: {} as CryptoKey,
    key: {
      iv: "",
      ciphertext: "",
      keyId: "k1",
      prefix: "cdm_ab",
      expiresAt,
      dailyCapCredits: 200,
    },
  }) as DeviceRecord;

const office = {
  context: { requirements: { isSetSupported: () => true }, ui: {} },
  EventType: {},
} as unknown as OfficeGlobal;

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  setApiTransport(null);
  setAccountScope(null);
});

describe("the add-in's account gate", () => {
  it("works from its stored key with no session at all", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(401, { error: { code: "unauthorized" } }));
    localStorage.setItem("subrosa:office-account", JSON.stringify({ id: ACCOUNT, email: "a@b.c" }));
    const later = new Date(Date.now() + 5 * 24 * 3600_000).toISOString();
    render(
      <OfficeAccess office={office} host="Word" store={memoryStore([record(later)])}>
        {(ready) => <p>ready for {ready.account.email}</p>}
      </OfficeAccess>,
    );
    await screen.findByText("ready for a@b.c");
    expect(screen.queryByText(/runs out soon/)).toBeNull();
  });

  it("asks to sign in when there is no key and no session", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(401, {}));
    render(
      <OfficeAccess office={office} host="Excel" store={memoryStore()}>
        {() => <p>ready</p>}
      </OfficeAccess>,
    );
    await screen.findByRole("heading", { name: "Connect Sub Rosa" });
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText("ready")).toBeNull();
  });

  it("offers the device card in its own session, recovery key included", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input) === "/api/v1/me"
        ? json(200, { data: { id: ACCOUNT, email: "a@b.c", created_at: "" } })
        : json(200, { data: [] }),
    );
    render(
      <OfficeAccess office={office} host="PowerPoint" store={memoryStore()}>
        {() => <p>ready</p>}
      </OfficeAccess>,
    );
    await screen.findByRole("heading", { name: "This add-in" });
    await userEvent.click(screen.getByRole("button", { name: "Use this browser as a device" }));
    expect(screen.getByRole("button", { name: "Use my recovery key" })).toBeTruthy();
  });

  it("knows a key that has run out", () => {
    expect(hasLiveKey(record(new Date(Date.now() - 1000).toISOString()))).toBe(false);
    expect(hasLiveKey(null)).toBe(false);
  });
});

describe("the sign-in window", () => {
  function windowOffice() {
    let parentHandler: ((arg: { message: string; origin?: string }) => void) | null = null;
    const posted: unknown[] = [];
    const fake = {
      context: {
        ui: {
          messageParent: (message: string) => posted.push(JSON.parse(message)),
          addHandlerAsync: (
            _type: string,
            handler: (arg: { message: string; origin?: string }) => void,
            done?: () => void,
          ) => {
            parentHandler = handler;
            done?.();
          },
        },
      },
      EventType: { DialogParentMessageReceived: "parent" },
    } as unknown as OfficeGlobal;
    return {
      fake,
      posted,
      send: (message: unknown) => parentHandler?.({ message: JSON.stringify(message) }),
    };
  }

  it("says who is signed in, then carries the pane's calls", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input) === "/api/v1/me"
          ? json(200, { data: { id: ACCOUNT, email: "a@b.c", created_at: "" } })
          : json(200, { data: { assertion: "jws" } }),
      );
    const { fake, posted, send } = windowOffice();
    render(<SessionWindow office={fake} fresh={false} navigate={vi.fn()} />);
    await screen.findByText(/Signed in as a@b.c/);
    expect(posted[0]).toEqual({ v: 1, type: "ready", account: { id: ACCOUNT, email: "a@b.c" } });
    send({
      v: 1,
      type: "request",
      id: "q1",
      method: "POST",
      path: "/api/v1/carpe-diem/assertion",
      headers: { "subrosa-device-proof": "p" },
      body: "{}",
    });
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toMatchObject({ type: "response", id: "q1", status: 200 });
    send({ v: 1, type: "request", id: "q2", method: "GET", path: "/api/v1/vault", headers: {} });
    await waitFor(() => expect(posted).toHaveLength(3));
    expect(posted[2]).toMatchObject({ id: "q2", status: 403 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("signs in on the account origin and comes back to itself", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(401, {}));
    const navigate = vi.fn();
    const { fake, posted } = windowOffice();
    render(<SessionWindow office={fake} fresh={false} navigate={navigate} />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(navigate).toHaveBeenCalledWith(SIGN_IN_URL);
    expect(SIGN_IN_URL).toBe("/auth/login?return_to=%2Foffice%2Fsession.html");
    expect(posted).toEqual([{ v: 1, type: "signed-out" }]);
  });
});
