// @ts-expect-error node:fs is available in the Vitest runtime.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfficeGlobal } from "../../office-addins/src/office";
import { type RelayState, startRelay } from "../../office-addins/src/session/relay";
import { startCourierFrame } from "../../website/src/office/courier-frame";
import { returnToSessionWindow, SESSION_WINDOW_URL } from "../../website/src/office/signed-in";
import { OFFICE_ORIGIN } from "../../website/src/lib/office-origins";

// The sign-in window and its courier frame (ADR-0102, addendum of
// 2026-10-10): each end answers only the other, by origin and by window.

const ACCOUNT = "https://account.test";
const OFFICE = "https://office.account.test";
const ID = "0191d1a4-0000-7000-8000-000000000000";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.useRealTimers());

/** A window that only records what it is sent. */
const messenger = () => ({ postMessage: vi.fn() });
const sent = (target: { postMessage: ReturnType<typeof vi.fn> }) =>
  target.postMessage.mock.calls.map(([message, origin]) => [JSON.parse(message as string), origin]);

function relayFixture(timeoutMs = 15_000) {
  const target = new EventTarget() as unknown as Window;
  const courier = messenger();
  const toPane: unknown[] = [];
  let fromPane: ((arg: { message: string; origin?: string }) => void) | null = null;
  const office = {
    context: {
      ui: {
        messageParent: (message: string) => toPane.push(JSON.parse(message)),
        addHandlerAsync: (
          _type: string,
          handler: (arg: { message: string; origin?: string }) => void,
          done?: () => void,
        ) => {
          fromPane = handler;
          done?.();
        },
      },
    },
    EventType: { DialogParentMessageReceived: "parent" },
  } as unknown as OfficeGlobal;
  const states: RelayState[] = [];
  const relay = startRelay({
    office,
    courier: () => courier as unknown as MessageEventSource,
    target,
    accountOrigin: ACCOUNT,
    paneOrigin: OFFICE,
    onState: (state) => states.push(state),
    timeoutMs,
    helloEveryMs: 60_000,
  });
  const frameSays = (message: unknown, origin = ACCOUNT, source: unknown = courier) =>
    target.dispatchEvent(
      new MessageEvent("message", {
        data: typeof message === "string" ? message : JSON.stringify(message),
        origin,
        source: source as MessageEventSource,
      }),
    );
  const paneSays = (message: unknown, origin = OFFICE) =>
    fromPane?.({ message: JSON.stringify(message), origin });
  return { relay, courier, toPane, states, frameSays, paneSays, hasPane: () => !!fromPane };
}

const request = (id: string, path = "/api/v1/devices") => ({
  v: 1,
  type: "request",
  id,
  method: "GET",
  path,
  headers: {},
});

describe("the sign-in window's relay", () => {
  it("asks the account origin's frame who is signed in, and nobody else", () => {
    const { relay, courier } = relayFixture();
    relay.hello();
    expect(sent(courier)).toEqual([[{ v: 1, type: "hello" }, ACCOUNT]]);
    relay.stop();
  });

  it("takes the frame's word only from the account origin and the frame it embeds", () => {
    const { relay, toPane, states, frameSays, hasPane } = relayFixture();
    const ready = { v: 1, type: "ready", account: { id: ID, email: "a@b.c" } };
    frameSays(ready, "https://evil.test");
    frameSays(ready, ACCOUNT, messenger());
    frameSays(ready, OFFICE);
    frameSays("not json");
    frameSays(request("x"));
    expect(toPane).toEqual([]);
    expect(states).toEqual([]);
    expect(hasPane()).toBe(false);
    frameSays(ready);
    expect(states).toEqual([{ kind: "carrying", account: { id: ID, email: "a@b.c" } }]);
    expect(toPane).toEqual([ready]);
    // Said once: a second ready changes nothing.
    frameSays({ v: 1, type: "ready", account: { id: ID, email: "other@b.c" } });
    expect(toPane).toHaveLength(1);
    relay.stop();
  });

  it("carries the pane's requests to the frame, and its answers back", () => {
    const { relay, courier, toPane, frameSays, paneSays } = relayFixture();
    frameSays({ v: 1, type: "ready", account: { id: ID, email: "a@b.c" } });
    courier.postMessage.mockClear();
    paneSays(request("q1"));
    expect(sent(courier)).toEqual([[request("q1"), ACCOUNT]]);
    frameSays({ v: 1, type: "response", id: "q1", status: 200, body: "{}" });
    expect(toPane.at(-1)).toEqual({ v: 1, type: "response", id: "q1", status: 200, body: "{}" });
    relay.stop();
  });

  it("refuses what the pane may not send", () => {
    const { relay, courier, frameSays, paneSays } = relayFixture();
    frameSays({ v: 1, type: "ready", account: { id: ID, email: "a@b.c" } });
    courier.postMessage.mockClear();
    paneSays(request("q2"), "https://evil.test");
    paneSays({ v: 1, type: "hello" });
    paneSays({ v: 1, type: "response", id: "q3", status: 200, body: "{}" });
    paneSays({ ...request("q4"), method: "DELETE" });
    expect(courier.postMessage).not.toHaveBeenCalled();
    relay.stop();
  });

  it("passes no answer on before the frame said who is signed in", () => {
    const { relay, toPane, frameSays } = relayFixture();
    frameSays({ v: 1, type: "response", id: "q1", status: 200, body: "{}" });
    expect(toPane).toEqual([]);
    relay.stop();
  });

  it("offers to sign in when the frame has no session", () => {
    const { relay, toPane, states, frameSays, hasPane } = relayFixture();
    frameSays({ v: 1, type: "signed-out" });
    expect(states).toEqual([{ kind: "signed-out" }]);
    expect(toPane).toEqual([{ v: 1, type: "signed-out" }]);
    expect(hasPane()).toBe(false);
    relay.stop();
  });

  it("says the account site is unavailable when the frame never answers", () => {
    vi.useFakeTimers();
    const { relay, states, frameSays } = relayFixture(1000);
    vi.advanceTimersByTime(1001);
    expect(states).toEqual([{ kind: "unavailable" }]);
    frameSays({ v: 1, type: "ready", account: { id: ID, email: "a@b.c" } });
    expect(states).toHaveLength(1);
    relay.stop();
  });

  it("stops relaying once stopped", () => {
    const { relay, courier, toPane, frameSays, paneSays } = relayFixture();
    frameSays({ v: 1, type: "ready", account: { id: ID, email: "a@b.c" } });
    relay.stop();
    courier.postMessage.mockClear();
    paneSays(request("q5"));
    frameSays({ v: 1, type: "response", id: "q5", status: 200, body: "{}" });
    expect(courier.postMessage).not.toHaveBeenCalled();
    expect(toPane).toHaveLength(1);
  });
});

function frameFixture(fetcher: ReturnType<typeof vi.fn>, framed = true) {
  const self = new EventTarget() as unknown as Window;
  const parent = messenger();
  const stop = startCourierFrame({
    self,
    parent: framed ? parent : null,
    officeOrigin: OFFICE,
    fetch: fetcher as unknown as typeof fetch,
    cookie: () => "other=1; subrosa_csrf=tok%2Ben",
  });
  const windowSays = (message: unknown, origin = OFFICE, source: unknown = parent) =>
    self.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(message),
        origin,
        source: source as MessageEventSource,
      }),
    );
  return { stop, parent, windowSays };
}

describe("the courier frame on the account origin", () => {
  it("tells the office origin's window who is signed in", async () => {
    const fetcher = vi.fn(async () =>
      json(200, { data: { id: ID, email: "a@b.c", created_at: "" } }),
    );
    const { stop, parent, windowSays } = frameFixture(fetcher);
    windowSays({ v: 1, type: "hello" });
    await vi.waitFor(() => expect(parent.postMessage).toHaveBeenCalled());
    expect(sent(parent)).toEqual([
      [{ v: 1, type: "ready", account: { id: ID, email: "a@b.c" } }, OFFICE],
    ]);
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/v1/me");
    expect(init.credentials).toBe("same-origin");
    stop();
  });

  it("says signed out when the account has no session", async () => {
    const { stop, parent, windowSays } = frameFixture(vi.fn(async () => json(401, {})));
    windowSays({ v: 1, type: "hello" });
    await vi.waitFor(() => expect(parent.postMessage).toHaveBeenCalled());
    expect(sent(parent)).toEqual([[{ v: 1, type: "signed-out" }, OFFICE]]);
    stop();
  });

  it("answers only its parent, and only on the office origin", async () => {
    const fetcher = vi.fn(async () => json(200, { data: {} }));
    const { stop, parent, windowSays } = frameFixture(fetcher);
    windowSays({ v: 1, type: "hello" }, "https://evil.test");
    windowSays({ v: 1, type: "hello" }, ACCOUNT);
    windowSays({ v: 1, type: "hello" }, OFFICE, messenger());
    windowSays(request("q1"), "https://evil.test");
    windowSays(request("q2"), OFFICE, messenger());
    windowSays({ v: 1, type: "ready", account: { id: ID, email: "a@b.c" } });
    await tick();
    expect(fetcher).not.toHaveBeenCalled();
    expect(parent.postMessage).not.toHaveBeenCalled();
    stop();
  });

  it("carries an allowed call with this origin's CSRF token", async () => {
    const fetcher = vi.fn(async () => json(200, { data: [] }));
    const { stop, parent, windowSays } = frameFixture(fetcher);
    windowSays(request("q1"));
    await vi.waitFor(() => expect(parent.postMessage).toHaveBeenCalled());
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/v1/devices");
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("tok+en");
    expect(sent(parent)).toEqual([
      [{ v: 1, type: "response", id: "q1", status: 200, body: '{"data":[]}' }, OFFICE],
    ]);
    stop();
  });

  it("refuses a call outside the seven, without making it", async () => {
    const fetcher = vi.fn();
    const { stop, parent, windowSays } = frameFixture(fetcher);
    windowSays(request("q1", "/api/v1/vault"));
    await vi.waitFor(() => expect(parent.postMessage).toHaveBeenCalled());
    expect(fetcher).not.toHaveBeenCalled();
    expect(sent(parent)[0][0]).toMatchObject({ type: "response", id: "q1", status: 403 });
    stop();
  });

  it("does nothing when it is not framed", async () => {
    const fetcher = vi.fn();
    const { stop, windowSays } = frameFixture(fetcher, false);
    windowSays({ v: 1, type: "hello" });
    await tick();
    expect(fetcher).not.toHaveBeenCalled();
    stop();
  });
});

describe("the signed-in page", () => {
  it("sends the window back to the office origin's sign-in window, at a fixed URL", () => {
    const replace = vi.fn();
    returnToSessionWindow({ replace });
    expect(replace).toHaveBeenCalledWith(`${OFFICE_ORIGIN}/office/session.html`);
    expect(SESSION_WINDOW_URL).toBe("https://office.subrosa.furetier.com/office/session.html");
  });

  it("and the courier are account pages that run no Office.js", () => {
    for (const page of ["courier", "signed-in"]) {
      const html = readFileSync(`website/office/${page}.html`, "utf8") as string;
      const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"[^>]*>/g)].map((m) => m[1]);
      expect(scripts, page).toHaveLength(1);
      expect(scripts[0], page).toMatch(/^\/src\/office\/[\w-]+\.ts$/);
      expect(html, page).not.toContain("appsforoffice");
      expect(html, page).not.toMatch(/<script>(?!<\/script>)/);
    }
    const moved = readFileSync("website/public/office/moved.html", "utf8") as string;
    expect(moved).not.toContain("<script");
    expect(moved).not.toMatch(/[–—]/);
  });
});
