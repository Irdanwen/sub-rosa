/**
 * Interactive views a connector returns (MCP Apps `ui://` resources, or the
 * older `openai/outputTemplate`), in the browser: the port of
 * `connectors/apps.rs` and the app's `connector-app-bridge.ts`.
 *
 * The HTML is the server's, so it never runs in the page. The card frames
 * the site's static view host (`/connector-view.html`), sandboxed with
 * `allow-scripts` and without `allow-same-origin`: an opaque origin with no
 * cookie, storage or access to the page. The host receives the document
 * through `postMessage` and writes it under the policy Rust renders for that
 * server (`csp_for`): its server's origin, inline script and style, nothing
 * else. The only way out is `postMessage`, and every message is checked
 * here (source, opaque origin, JSON-RPC 2.0, an allowlist of methods, size)
 * before anything happens.
 */
import type { FeatureStore } from "../feature";
import { CONNECTORS } from "./words";

export interface AppRecord {
  id: string;
  connectorId: string;
  chatId: string | null;
  uri: string;
  html: string;
  tool: string;
  toolInput: unknown;
  toolOutput: unknown;
  createdAt: string;
}

export const appKey = (id: string) => `app:${id}`;

/** The view host page, on the site's own origin. */
export function viewHostUrl(base = import.meta.env.BASE_URL ?? "/"): string {
  return `${base}connector-view.html`;
}

/** `apps::origin_of`. */
export function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : "";
  } catch {
    return "";
  }
}

/** `apps::csp_for`, from the policy Rust rendered for a marker origin. */
export function cspFor(origin: string): string {
  const allowed =
    origin.startsWith("https://") || origin.startsWith("http://127.0.0.1") ? origin : "";
  return CONNECTORS.app.csp.split(CONNECTORS.app.cspMarker).join(allowed).replaceAll("  ", " ");
}

/** JSON safe inside a `<script>`: no `</script>`, no `<!--`. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

/** What the view host writes: the view's own policy before anything else
 * (a meta policy governs only what follows it, and nothing the server wrote,
 * not even a `<head>` inside a comment, can come before it), then the view
 * as `apps::document` makes it. */
export function framedDocument(app: AppRecord, origin: string, theme: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${cspFor(origin).replaceAll('"', "&quot;")}">`;
  return `<!doctype html>${policy}${viewDocument(app.html, app.toolInput, app.toolOutput, theme)}`;
}

/** `apps::document`: the view with its data and Rust's bridge first. */
export function viewDocument(
  html: string,
  toolInput: unknown,
  toolOutput: unknown,
  theme: string,
): string {
  const data = { theme, toolInput, toolOutput };
  const head = `<script type="application/json" id="subrosa-app-data">${scriptJson(data)}</script><script>${CONNECTORS.app.bridge}</script>`;
  const at = html.toLowerCase().indexOf("<head>");
  if (at >= 0) {
    const cut = at + "<head>".length;
    return `${html.slice(0, cut)}${head}${html.slice(cut)}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${html}</body></html>`;
}

/** `apps::html_of`: the first HTML content of a `resources/read`. */
export function htmlOf(result: unknown): string | null {
  const contents = (result as { contents?: unknown } | null)?.contents;
  if (!Array.isArray(contents)) return null;
  for (const raw of contents) {
    const content = (raw ?? {}) as Record<string, unknown>;
    const mime = typeof content.mimeType === "string" ? content.mimeType : "text/html";
    if (!mime.toLowerCase().startsWith("text/html")) continue;
    if (typeof content.text === "string") return content.text;
    if (typeof content.blob === "string")
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(
          Uint8Array.from(atob(content.blob), (c) => c.charCodeAt(0)),
        );
      } catch {
        return null;
      }
  }
  return null;
}

/** What the view is handed of a result: its structured content when small
 * enough, else the bounded text and links. */
export function boundedOutput(result: unknown, fallback: unknown): unknown {
  const structured = (result as { structuredContent?: unknown } | null)?.structuredContent;
  const output = structured !== undefined ? structured : fallback;
  return JSON.stringify(output).length > CONNECTORS.limits.appMaxOutputBytes ? fallback : output;
}

export async function keepApp(store: FeatureStore, app: AppRecord): Promise<string | null> {
  if (new TextEncoder().encode(app.html).length > CONNECTORS.limits.appMaxHtmlBytes) return null;
  await store.put(appKey(app.id), app);
  return app.id;
}

export function getApp(store: FeatureStore, id: string) {
  return store.get<AppRecord>(appKey(id));
}

// ── The bridge ─────────────────────────────────────────────────────────────

export const BRIDGE_PROTOCOL = CONNECTORS.protocolVersion;
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

export interface BridgeMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params: Record<string, unknown>;
}

/** The message, when it is one the bridge answers; null for anything else. */
export function parseBridgeMessage(
  event: { data: unknown; source: unknown; origin: string },
  frame: unknown,
): BridgeMessage | null {
  if (!frame || event.source !== frame) return null;
  // A frame without `allow-same-origin` posts from an opaque origin.
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
    ...(id === undefined ? {} : { id: id as string | number }),
    method: message.method,
    params: params as Record<string, unknown>,
  };
}

export function clampFrameHeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, value)));
}

/** An https link a view may open; anything else is refused. */
export function safeLink(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export class ConfirmNeeded extends Error {
  constructor() {
    super("connector_confirm");
  }
}

export interface BridgeDeps {
  /** Runs a tool on the view's own connector; rejects with `ConfirmNeeded`
   * when it asks first and `confirmed` is false. */
  callTool(name: string, args: Record<string, unknown>, confirmed: boolean): Promise<unknown>;
  confirm(tool: string): Promise<boolean>;
  openLink(url: string): void;
  setHeight(height: number): void;
  post(message: unknown): void;
  theme: "light" | "dark";
  toolInput: unknown;
  toolOutput: unknown;
}

function reply(deps: BridgeDeps, message: BridgeMessage, result: unknown) {
  if (message.id !== undefined) deps.post({ jsonrpc: "2.0", id: message.id, result });
}
function fail(deps: BridgeDeps, message: BridgeMessage, code: number, text: string) {
  if (message.id !== undefined)
    deps.post({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
}

/** Answers one checked message. */
export async function handleBridgeMessage(message: BridgeMessage, deps: BridgeDeps) {
  switch (message.method) {
    case "ui/initialize":
      reply(deps, message, {
        protocolVersion: BRIDGE_PROTOCOL,
        hostInfo: { name: "Sub Rosa" },
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
      const url = safeLink(message.params.url);
      if (!url) {
        fail(deps, message, -32602, "Only https links can be opened.");
        return;
      }
      deps.openLink(url);
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
        if (!(cause instanceof ConfirmNeeded)) {
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
