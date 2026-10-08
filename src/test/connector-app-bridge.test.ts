// The bridge a connector's interactive view talks to the app through
// (ADR-0092): every message checked before anything happens, and tool calls
// under the same allow, ask or deny rule as the assistant's own.

import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: () => "http://subrosa-app.localhost/" }));

import {
  type BridgeDeps,
  MAX_FRAME_HEIGHT,
  MIN_FRAME_HEIGHT,
  clampFrameHeight,
  connectorAppUrl,
  handleBridgeMessage,
  parseBridgeMessage,
} from "../lib/connector-app-bridge";

const frame = { name: "the-frame" };

function event(data: unknown, overrides: Partial<{ source: unknown; origin: string }> = {}) {
  return { data, source: frame, origin: "null", ...overrides };
}

function deps(overrides: Partial<BridgeDeps> = {}) {
  const posted: unknown[] = [];
  const base: BridgeDeps = {
    callTool: vi.fn(async () => ({ content: [] })),
    confirm: vi.fn(async () => true),
    openLink: vi.fn(async () => undefined),
    setHeight: vi.fn(),
    post: (message) => posted.push(message),
    hostName: "Sub Rosa",
    theme: "dark",
    toolInput: { q: "bugs" },
    toolOutput: { items: 2 },
    ...overrides,
  };
  return { deps: base, posted };
}

describe("checking a message", () => {
  const ok = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search" } };

  it("accepts a JSON-RPC message from the frame's opaque origin", () => {
    expect(parseBridgeMessage(event(ok), frame)).toEqual(ok);
  });

  it("refuses anything from another window or a real origin", () => {
    expect(parseBridgeMessage(event(ok, { source: {} }), frame)).toBeNull();
    expect(parseBridgeMessage(event(ok, { origin: "https://evil.example.com" }), frame)).toBeNull();
    expect(parseBridgeMessage(event(ok, { origin: "tauri://localhost" }), frame)).toBeNull();
    expect(parseBridgeMessage(event(ok), null)).toBeNull();
  });

  it("refuses methods outside the bridge and malformed envelopes", () => {
    for (const data of [
      { ...ok, method: "resources/read" },
      { ...ok, jsonrpc: "1.0" },
      { ...ok, id: { nested: true } },
      { ...ok, id: "x".repeat(65) },
      { ...ok, params: [1, 2] },
      "tools/call",
      [ok],
      null,
    ]) {
      expect(parseBridgeMessage(event(data), frame)).toBeNull();
    }
  });

  it("refuses a message too large to be a request", () => {
    const big = { ...ok, params: { name: "search", arguments: { blob: "x".repeat(70_000) } } };
    expect(parseBridgeMessage(event(big), frame)).toBeNull();
  });
});

describe("answering a message", () => {
  it("introduces the host, then hands the view its input and result", async () => {
    const { deps: d, posted } = deps();
    await handleBridgeMessage({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} }, d);
    expect(posted[0]).toMatchObject({
      id: 1,
      result: { hostInfo: { name: "Sub Rosa" }, hostContext: { theme: "dark" } },
    });
    await handleBridgeMessage(
      { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} },
      d,
    );
    expect(posted[1]).toMatchObject({
      method: "ui/notifications/tool-input",
      params: { arguments: { q: "bugs" } },
    });
    expect(posted[2]).toMatchObject({
      method: "ui/notifications/tool-result",
      params: { items: 2 },
    });
  });

  it("clamps the height a view asks for", async () => {
    const { deps: d } = deps();
    await handleBridgeMessage(
      { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 50_000 } },
      d,
    );
    expect(d.setHeight).toHaveBeenCalledWith(MAX_FRAME_HEIGHT);
    expect(clampFrameHeight(1)).toBe(MIN_FRAME_HEIGHT);
    expect(clampFrameHeight("200")).toBeNull();
  });

  it("opens https links only", async () => {
    const { deps: d, posted } = deps();
    await handleBridgeMessage(
      { jsonrpc: "2.0", id: 2, method: "ui/open-link", params: { url: "javascript:alert(1)" } },
      d,
    );
    expect(d.openLink).not.toHaveBeenCalled();
    expect(posted[0]).toMatchObject({ id: 2, error: { code: -32602 } });
    await handleBridgeMessage(
      { jsonrpc: "2.0", id: 3, method: "ui/open-link", params: { url: "https://example.com/a" } },
      d,
    );
    expect(d.openLink).toHaveBeenCalledWith("https://example.com/a");
  });

  it("runs an allowed tool without asking", async () => {
    const { deps: d, posted } = deps();
    await handleBridgeMessage(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "search", arguments: { q: "x" } },
      },
      d,
    );
    expect(d.callTool).toHaveBeenCalledWith("search", { q: "x" }, false);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(posted[0]).toMatchObject({ id: 4, result: { content: [] } });
  });

  it("asks the person when the tool asks first, and runs it only on yes", async () => {
    const needsConfirm = Object.assign(new Error("confirm"), { code: "connector_confirm" });
    const callTool = vi.fn(async (_name: string, _args: unknown, confirmed: boolean) => {
      if (!confirmed) throw needsConfirm;
      return { content: [{ type: "text", text: "made" }] };
    });
    const yes = deps({ callTool });
    await handleBridgeMessage(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "create" } },
      yes.deps,
    );
    expect(yes.deps.confirm).toHaveBeenCalledWith("create");
    expect(callTool).toHaveBeenLastCalledWith("create", {}, true);
    expect(yes.posted[0]).toMatchObject({ id: 5, result: { content: [{ text: "made" }] } });

    callTool.mockClear();
    const no = deps({ callTool, confirm: vi.fn(async () => false) });
    await handleBridgeMessage(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "create" } },
      no.deps,
    );
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(no.posted[0]).toMatchObject({ id: 6, error: { code: -32000 } });
  });

  it("refuses a malformed tool call and what it does not support", async () => {
    const { deps: d, posted } = deps();
    await handleBridgeMessage(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: 42 } },
      d,
    );
    await handleBridgeMessage({ jsonrpc: "2.0", id: 8, method: "ui/message", params: {} }, d);
    expect(d.callTool).not.toHaveBeenCalled();
    expect(posted).toMatchObject([
      { id: 7, error: { code: -32602 } },
      { id: 8, error: { code: -32601 } },
    ]);
  });
});

describe("where a view is served", () => {
  it("names the view by id on its own scheme", () => {
    expect(connectorAppUrl("call-1", "light")).toBe("subrosa-app://localhost/call-1");
    expect(connectorAppUrl("call-1", "dark")).toBe("subrosa-app://localhost/call-1?theme=dark");
  });
});
