import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAccountScope, setApiTransport } from "../../website/src/lib/api";
import type { DeviceRecord, DeviceStore } from "../../website/src/lib/browser-device";
import type { OfficeGlobal } from "../../office-addins/src/office";
import { hasLiveKey, OfficeAccess } from "../../office-addins/src/pane/Access";
import {
  COURIER_PATH,
  SessionWindow,
  signInUrl,
} from "../../office-addins/src/session/SessionWindow";

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

  it("never calls the account service itself, even with nothing stored", async () => {
    const pageFetch = vi.spyOn(globalThis, "fetch");
    render(
      <OfficeAccess office={office} host="PowerPoint" store={memoryStore()}>
        {() => <p>ready</p>}
      </OfficeAccess>,
    );
    await screen.findByRole("heading", { name: "Connect Sub Rosa" });
    // The office origin has no session: the sign-in window is the only way.
    expect(pageFetch).not.toHaveBeenCalled();
  });

  it("knows a key that has run out", () => {
    expect(hasLiveKey(record(new Date(Date.now() - 1000).toISOString()))).toBe(false);
    expect(hasLiveKey(null)).toBe(false);
  });
});

describe("the sign-in window", () => {
  const ORIGIN = "https://account.test";
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
  /** What the courier frame would say, as a message from its window. */
  function fromFrame(message: unknown, origin = ORIGIN) {
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(message),
        origin,
        source: frame.contentWindow,
      }),
    );
  }

  it("embeds the account origin's courier and says who is signed in", async () => {
    const pageFetch = vi.spyOn(globalThis, "fetch");
    const { fake, posted, send } = windowOffice();
    render(<SessionWindow office={fake} fresh={false} navigate={vi.fn()} origin={ORIGIN} />);
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(`${ORIGIN}${COURIER_PATH}`);
    const toFrame = vi.spyOn(frame.contentWindow as Window, "postMessage");
    fromFrame({ v: 1, type: "ready", account: { id: ACCOUNT, email: "a@b.c" } });
    await screen.findByText(/Signed in as a@b.c/);
    expect(posted[0]).toEqual({ v: 1, type: "ready", account: { id: ACCOUNT, email: "a@b.c" } });
    send({ v: 1, type: "request", id: "q1", method: "GET", path: "/api/v1/me", headers: {} });
    expect(toFrame).toHaveBeenCalledWith(expect.stringContaining('"id":"q1"'), ORIGIN);
    // The window itself never calls the service: the frame does.
    expect(pageFetch).not.toHaveBeenCalled();
  });

  it("signs in on the account origin and comes back through the signed-in page", async () => {
    const navigate = vi.fn();
    const { fake, posted } = windowOffice();
    render(<SessionWindow office={fake} fresh={false} navigate={navigate} origin={ORIGIN} />);
    fromFrame({ v: 1, type: "signed-out" });
    await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(navigate).toHaveBeenCalledWith(
      `${ORIGIN}/auth/login?return_to=%2Foffice%2Fsigned-in.html`,
    );
    expect(signInUrl(ORIGIN)).toBe(`${ORIGIN}/auth/login?return_to=%2Foffice%2Fsigned-in.html`);
    expect(posted).toEqual([{ v: 1, type: "signed-out" }]);
  });

  it("goes straight to sign-in when asked for a fresh one", () => {
    const navigate = vi.fn();
    const { fake } = windowOffice();
    render(<SessionWindow office={fake} fresh navigate={navigate} origin={ORIGIN} />);
    expect(navigate).toHaveBeenCalledWith(signInUrl(ORIGIN));
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("ignores what another origin says in the frame's name", async () => {
    const { fake, posted } = windowOffice();
    render(<SessionWindow office={fake} fresh={false} navigate={vi.fn()} origin={ORIGIN} />);
    fromFrame(
      { v: 1, type: "ready", account: { id: ACCOUNT, email: "evil@b.c" } },
      "https://evil.test",
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ v: 1, type: "ready", account: { id: ACCOUNT, email: "x@b.c" } }),
        origin: ORIGIN,
        source: window,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posted).toEqual([]);
    expect(screen.getByRole("status").textContent).toBe("Loading…");
  });
});
