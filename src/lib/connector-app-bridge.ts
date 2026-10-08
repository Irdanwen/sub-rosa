/**
 * The bridge between a connector's interactive view and the app (ADR-0092).
 *
 * The view runs in an iframe sandboxed without `allow-same-origin`, served
 * from the `subrosa-app:` scheme under its own policy, so the only thing it
 * can do to the app is post a message. Every message is checked here before
 * anything happens: it must come from that frame, from an opaque origin, be
 * JSON-RPC 2.0, name one of a handful of methods, and be small. A tool call
 * goes through the same allow, ask or deny rule as the assistant's own calls,
 * on the view's own connector only (enforced again in Rust).
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { errorCode } from "./errors";
import { safeExternalUrl } from "./external-link";

export const BRIDGE_PROTOCOL = "2025-06-18";
const MAX_MESSAGE_BYTES = 64 * 1024;
export const MIN_FRAME_HEIGHT = 80;
export const MAX_FRAME_HEIGHT = 900;

const METHODS = new Set([
  "ui/initialize",
  "ui/notifications/initialized",
  "ui/notifications/size-changed",
  "tools/call",
  "ui/open-link",
  "ui/message",
]);

export type BridgeMessage = {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params: Record<string, unknown>;
};

/** A message event, as much of it as the check needs. */
export type BridgeEvent = { data: unknown; source: unknown; origin: string };

/** The message, when it is one the bridge answers; null for anything else. */
export function parseBridgeMessage(event: BridgeEvent, frame: unknown): BridgeMessage | null {
  if (!frame || event.source !== frame) return null;
  // A frame without `allow-same-origin` posts from an opaque origin. Any
  // other origin means the frame is not the one this card made.
  if (event.origin !== "null") return null;
  const data = event.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const message = data as Record<string, unknown>;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return null;
  if (!METHODS.has(message.method)) return null;
  const id = message.id;
  if (
    id !== undefined &&
    !(typeof id === "number" && Number.isFinite(id)) &&
    !(typeof id === "string" && id.length <= 64)
  )
    return null;
  const params = message.params ?? {};
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  try {
    if (JSON.stringify(data).length > MAX_MESSAGE_BYTES) return null;
  } catch {
    return null;
  }
  return {
    jsonrpc: "2.0",
    ...(id === undefined ? {} : { id }),
    method: message.method,
    params: params as Record<string, unknown>,
  };
}

export function clampFrameHeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, value)));
}

export type BridgeDeps = {
  /** Runs a tool on the view's connector. Rejects with `connector_confirm`
   * when the tool asks first and `confirmed` is false. */
  callTool: (name: string, args: Record<string, unknown>, confirmed: boolean) => Promise<unknown>;
  /** Asks the person whether a tool may run. */
  confirm: (tool: string) => Promise<boolean>;
  openLink: (url: string) => Promise<void>;
  setHeight: (height: number) => void;
  post: (message: unknown) => void;
  hostName: string;
  theme: "light" | "dark";
  toolInput: unknown;
  toolOutput: unknown;
};

function reply(deps: BridgeDeps, message: BridgeMessage, result: unknown) {
  if (message.id === undefined) return;
  deps.post({ jsonrpc: "2.0", id: message.id, result });
}

function fail(deps: BridgeDeps, message: BridgeMessage, code: number, text: string) {
  if (message.id === undefined) return;
  deps.post({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
}

/** Answers one checked message. */
export async function handleBridgeMessage(message: BridgeMessage, deps: BridgeDeps) {
  switch (message.method) {
    case "ui/initialize":
      reply(deps, message, {
        protocolVersion: BRIDGE_PROTOCOL,
        hostInfo: { name: deps.hostName },
        hostCapabilities: { openLinks: {}, serverTools: {} },
        hostContext: { theme: deps.theme, displayMode: "inline" },
      });
      return;
    case "ui/notifications/initialized":
      deps.post({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: deps.toolInput ?? {} },
      });
      deps.post({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: deps.toolOutput ?? {},
      });
      return;
    case "ui/notifications/size-changed": {
      const height = clampFrameHeight(message.params.height);
      if (height !== null) deps.setHeight(height);
      return;
    }
    case "ui/open-link": {
      const url = safeExternalUrl(message.params.url);
      if (!url) {
        fail(deps, message, -32602, "Only https links can be opened.");
        return;
      }
      await deps.openLink(url.href);
      reply(deps, message, {});
      return;
    }
    case "tools/call": {
      const name = message.params.name;
      const args = message.params.arguments ?? {};
      if (typeof name !== "string" || !name || name.length > 128) {
        fail(deps, message, -32602, "A tool name is required.");
        return;
      }
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        fail(deps, message, -32602, "Arguments must be an object.");
        return;
      }
      try {
        reply(deps, message, await deps.callTool(name, args as Record<string, unknown>, false));
      } catch (cause) {
        if (errorCode(cause) !== "connector_confirm") {
          fail(deps, message, -32000, "The tool could not run.");
          return;
        }
        if (!(await deps.confirm(name))) {
          fail(deps, message, -32000, "The person declined.");
          return;
        }
        try {
          reply(deps, message, await deps.callTool(name, args as Record<string, unknown>, true));
        } catch {
          fail(deps, message, -32000, "The tool could not run.");
        }
      }
      return;
    }
    default:
      fail(deps, message, -32601, "Not supported here.");
  }
}

export const APP_SCHEME = "subrosa-app";

/** Where the view is served: `subrosa-app://localhost/<id>`, or the
 * `http://subrosa-app.localhost/<id>` form where the platform's webview needs
 * it. Tauri knows which; outside a shell the custom-scheme form stands in. */
export function connectorAppUrl(id: string, theme: "light" | "dark"): string {
  const internals = (window as { __TAURI_INTERNALS__?: { convertFileSrc?: unknown } })
    .__TAURI_INTERNALS__;
  const base = internals?.convertFileSrc
    ? convertFileSrc("", APP_SCHEME)
    : `${APP_SCHEME}://localhost/`;
  return `${base}${encodeURIComponent(id)}${theme === "dark" ? "?theme=dark" : ""}`;
}
