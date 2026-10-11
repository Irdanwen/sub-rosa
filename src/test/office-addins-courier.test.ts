import { afterEach, describe, expect, it, vi } from "vitest";
import { api, setAccountScope, setApiTransport } from "../../website/src/lib/api";
import type { OfficeDialog, OfficeGlobal } from "../../office-addins/src/office";
import {
  noSession,
  openSignInWindow,
  SignInWindowError,
} from "../../office-addins/src/pane/sign-in-window";
import {
  carried,
  carry,
  type CourierMessage,
  type CourierRequest,
  courierTransport,
  csrfFromCookie,
  parseMessage,
} from "../../website/src/lib/office-courier";

const ACCOUNT = "0191d1a4-0000-7000-8000-000000000000";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

afterEach(() => {
  setApiTransport(null);
  setAccountScope(null);
});

describe("what the sign-in window carries", () => {
  it("carries the device calls and nothing else", () => {
    expect(carried("GET", "/api/v1/me")).toBe(true);
    expect(carried("POST", "/api/v1/browser-devices")).toBe(true);
    expect(carried("POST", "/api/v1/carpe-diem/assertion")).toBe(true);
    expect(carried("GET", "/api/v1/pairing/0191d1a4-1111-7000-8000-000000000000")).toBe(true);
    expect(carried("GET", "/api/v1/sync?after=0")).toBe(false);
    expect(carried("GET", "/api/v1/vault")).toBe(false);
    expect(carried("POST", "/api/v1/me")).toBe(false);
    expect(carried("GET", "/api/v1/pairing/../vault")).toBe(false);
  });

  it("reads only well formed messages, and drops headers it does not forward", () => {
    expect(parseMessage("not json")).toBeNull();
    expect(parseMessage({ v: 1, type: "hello" })).toBeNull();
    expect(parseMessage(JSON.stringify({ v: 1, type: "hello", extra: 1 }))).toEqual({
      v: 1,
      type: "hello",
    });
    expect(parseMessage(JSON.stringify({ v: 2, type: "signed-out" }))).toBeNull();
    const request = parseMessage(
      JSON.stringify({
        v: 1,
        type: "request",
        id: "a",
        method: "POST",
        path: "/api/v1/browser-devices",
        headers: { "Subrosa-Device-Proof": "jws", Cookie: "stolen", "x-csrf-token": "x" },
        body: "{}",
      }),
    ) as CourierRequest;
    expect(request.headers).toEqual({ "subrosa-device-proof": "jws" });
    expect(
      parseMessage(JSON.stringify({ v: 1, type: "request", id: "a", method: "PUT" })),
    ).toBeNull();
  });

  it("refuses to carry a recovery key's admission proof", async () => {
    const fetch = vi.fn();
    const replies: CourierMessage[] = [];
    await carry(
      { fetch, csrf: () => "c", reply: (message) => replies.push(message) },
      {
        v: 1,
        type: "request",
        id: "r1",
        method: "POST",
        path: "/api/v1/browser-devices",
        headers: {},
        body: JSON.stringify({ name: "x", admission: { recovery_proof: "secret" } }),
      },
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(replies[0]).toMatchObject({ type: "response", id: "r1", status: 403 });
  });

  it("adds the window's cookie session and CSRF token, never the pane's", async () => {
    const fetch = vi.fn(async () => json(200, { data: { id: "d" } }));
    const replies: CourierMessage[] = [];
    await carry(
      { fetch, csrf: () => "token", reply: (message) => replies.push(message) },
      {
        v: 1,
        type: "request",
        id: "r2",
        method: "POST",
        path: "/api/v1/carpe-diem/assertion",
        headers: { "subrosa-device-proof": "proof" },
        body: "{}",
      },
    );
    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/v1/carpe-diem/assertion");
    expect(init.credentials).toBe("same-origin");
    const headers = new Headers(init.headers);
    expect(headers.get("x-csrf-token")).toBe("token");
    expect(headers.get("subrosa-device-proof")).toBe("proof");
    expect(replies[0]).toMatchObject({ status: 200, body: JSON.stringify({ data: { id: "d" } }) });
  });

  it("passes the pane's body on byte for byte, so its proof's ath still matches", async () => {
    // A device proof binds the exact body (ADR-0096 addendum of 2026-10-10):
    // pane, window and frame must hand the service the very string signed.
    const body = '{ "name":"Excel  \u00e9t\u00e9",\n"admission":{"pairing":"p"} }';
    const sent: string[] = [];
    const { transport } = courierTransport((message) => sent.push(message), 1000);
    void transport("/api/v1/browser-devices", {
      method: "POST",
      headers: { "subrosa-device-proof": "proof" },
      body,
    });
    // The window re-reads and re-writes what crosses it, never forwards it raw.
    const relayed = JSON.stringify(parseMessage(sent[0]));
    const fetch = vi.fn(async () => json(201, { data: { id: "d" } }));
    await carry(
      { fetch, csrf: () => "token", reply: () => undefined },
      parseMessage(relayed) as CourierRequest,
    );
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(body);
  });

  it("reads the CSRF cookie like the site does", () => {
    expect(csrfFromCookie("a=b; subrosa_csrf=x%2By")).toBe("x+y");
    expect(csrfFromCookie("a=b")).toBeUndefined();
  });

  it("times out a call the window never answers", async () => {
    const { transport } = courierTransport(() => undefined, 10);
    const response = await transport("/api/v1/me", {});
    expect(response.status).toBe(504);
  });
});

/** An Office whose dialog is a sign-in window running the real `carry`. */
function fakeOffice(windowFetch: typeof fetch) {
  const handlers = new Map<string, (arg: { message?: string; origin?: string }) => void>();
  const sent: string[] = [];
  const dialog: OfficeDialog = {
    addEventHandler: (type, handler) => handlers.set(type, handler),
    messageChild(message) {
      sent.push(message);
      const request = parseMessage(message);
      if (request?.type !== "request") return;
      void carry(
        {
          fetch: windowFetch,
          csrf: () => "csrf",
          reply: (answer) =>
            handlers.get("received")?.({
              message: JSON.stringify(answer),
              origin: "https://account.test",
            }),
        },
        request,
      );
    },
    close: vi.fn(),
  };
  const office = {
    onReady: async () => ({ host: "Word", platform: "OfficeOnline" }),
    context: {
      requirements: { isSetSupported: (name: string) => name === "DialogApi" },
      ui: {
        displayDialogAsync: (_url: string, _options: unknown, callback: (r: unknown) => void) =>
          callback({ status: "succeeded", value: dialog }),
        messageParent: vi.fn(),
        addHandlerAsync: vi.fn(),
      },
    },
    EventType: {
      DialogMessageReceived: "received",
      DialogEventReceived: "event",
      DialogParentMessageReceived: "parent",
    },
  } as unknown as OfficeGlobal;
  const ready = (origin = "https://account.test") =>
    handlers.get("received")?.({
      message: JSON.stringify({ v: 1, type: "ready", account: { id: ACCOUNT, email: "a@b.c" } }),
      origin,
    });
  return { office, dialog, handlers, sent, ready };
}

describe("the pane's calls through the sign-in window", () => {
  it("routes the site's api() through the window once it is signed in", async () => {
    const windowFetch = vi.fn(async () => json(200, { data: [{ id: "dev" }] }));
    const { office, ready, dialog, handlers } = fakeOffice(windowFetch as unknown as typeof fetch);
    const opening = openSignInWindow(office, {}, "https://account.test");
    ready();
    const opened = await opening;
    expect(opened.account.id).toBe(ACCOUNT);
    const devices = await api<{ id: string }[]>("/api/v1/devices");
    expect(devices).toEqual([{ id: "dev" }]);
    const [, init] = windowFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("x-subrosa-account-id")).toBe(ACCOUNT);
    // Closing the window puts back the pane's own transport, which reaches
    // nothing: the office origin has no session and serves no API.
    opened.close();
    expect(dialog.close).toHaveBeenCalled();
    const pageFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(200, { data: [] }));
    await expect(api("/api/v1/devices")).rejects.toMatchObject({ status: 401 });
    expect(pageFetch).not.toHaveBeenCalled();
    pageFetch.mockRestore();
    expect(handlers.size).toBe(2);
  });

  it("ignores a ready message from another origin", async () => {
    const { office, ready, handlers } = fakeOffice(vi.fn() as unknown as typeof fetch);
    const opening = openSignInWindow(office, {}, "https://account.test");
    ready("https://evil.test");
    handlers.get("event")?.({});
    await expect(opening).rejects.toBeInstanceOf(SignInWindowError);
  });

  it("answers no session without a request while no window is open", async () => {
    setApiTransport(noSession);
    const pageFetch = vi.spyOn(globalThis, "fetch");
    await expect(api("/api/v1/me")).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(pageFetch).not.toHaveBeenCalled();
    pageFetch.mockRestore();
  });

  it("says when Office cannot message a window", async () => {
    const { office } = fakeOffice(vi.fn() as unknown as typeof fetch);
    (office.context as { requirements: unknown }).requirements = {
      isSetSupported: () => false,
    };
    await expect(openSignInWindow(office)).rejects.toMatchObject({ code: "unsupported" });
  });
});
