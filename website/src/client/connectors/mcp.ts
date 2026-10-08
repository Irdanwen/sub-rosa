/**
 * A Model Context Protocol client over Streamable HTTP, in the browser: the
 * port of `connectors/mcp.rs` (ADR-0092). Every client message is a JSON-RPC
 * `POST`; the server answers with plain JSON or a short event stream; a
 * session id handed out at `initialize` is echoed, and a `404` on it means
 * the session is gone. A minute and four megabytes per request, two hundred
 * tools at most. A `401` is the start of a sign-in and carries where it
 * begins (`resource_metadata`, RFC 9728).
 *
 * The tab talks to the server directly: a server that does not answer the
 * site's origin with CORS cannot be used from the web client, and nothing is
 * relayed through the account service.
 */
import { CONNECTORS } from "./words";

const LIMITS = CONNECTORS.limits;
const MAX_PAGES = 10;
const MAX_NOTIFICATIONS = 64;

export type McpErrorKind =
  | "unauthorized"
  | "session_expired"
  | "status"
  | "rpc"
  | "too_large"
  | "invalid"
  | "network";

export class McpError extends Error {
  constructor(
    public kind: McpErrorKind,
    message: string,
    public detail: {
      status?: number;
      code?: number;
      resourceMetadata?: string | null;
      scope?: string | null;
    } = {},
  ) {
    super(message);
  }
}

/** An address a connector may live at: https anywhere, plain http only on
 * this machine, no credentials, no fragment. */
export function validateEndpoint(raw: string): URL | null {
  if (raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const schemeOk = url.protocol === "https:" || (loopback && url.protocol === "http:");
  if (!schemeOk || !url.hostname || url.username || url.password || url.hash) return null;
  return url;
}

/** `resource_metadata` and `scope` from a `WWW-Authenticate: Bearer …`. */
export function parseWwwAuthenticate(header: string): {
  resourceMetadata: string | null;
  scope: string | null;
} {
  let resourceMetadata: string | null = null;
  let scope: string | null = null;
  let rest = header.trim();
  if (/^bearer/i.test(rest)) rest = rest.slice(6);
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const c of rest) {
    if (c === '"') {
      quoted = !quoted;
      current += c;
    } else if (c === "," && !quoted) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  if (current.trim()) parts.push(current);
  for (const part of parts) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const key = part.slice(0, at).trim().toLowerCase();
    const value = part
      .slice(at + 1)
      .trim()
      .replace(/^"+|"+$/g, "");
    if (key === "resource_metadata" && value) resourceMetadata = value;
    if (key === "scope" && value) scope = value;
  }
  return { resourceMetadata, scope };
}

/** Server-sent events from chunks: each event's `data:` lines, joined. */
export class SseEvents {
  private buffer = "";
  private data: string[] = [];
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return this.take(lines);
  }
  finish(): string[] {
    const lines = this.buffer ? [this.buffer, ""] : [""];
    this.buffer = "";
    return this.take(lines);
  }
  private take(lines: string[]): string[] {
    const events: string[] = [];
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line) {
        if (this.data.length) {
          events.push(this.data.join("\n"));
          this.data = [];
        }
      } else if (line.startsWith("data:")) {
        const data = line.slice(5);
        this.data.push(data.startsWith(" ") ? data.slice(1) : data);
      }
    }
    return events;
  }
}

type Json = Record<string, unknown>;

/** The response to request `id` in one message (or batch), if it is there. */
export function rpcOutcome(
  message: unknown,
  id: number,
): { ok: unknown } | { err: McpError } | null {
  if (Array.isArray(message)) {
    for (const entry of message) {
      const found = rpcOutcome(entry, id);
      if (found) return found;
    }
    return null;
  }
  if (!message || typeof message !== "object") return null;
  const value = message as Json;
  if (value.id !== id || "method" in value) return null;
  if (value.error && typeof value.error === "object") {
    const error = value.error as Json;
    const text = typeof error.message === "string" ? error.message : "error";
    return {
      err: new McpError("rpc", text, { code: typeof error.code === "number" ? error.code : 0 }),
    };
  }
  return { ok: value.result ?? null };
}

export interface ServerInfo {
  name: string;
  version: string;
  capabilities: unknown;
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Aborts when any of `signals` does (`AbortSignal.any`, which older
 * browsers lack). */
export function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function checkStatus(response: Response, hadSession: boolean) {
  const status = response.status;
  if (status === 401) {
    const parsed = parseWwwAuthenticate(response.headers.get("www-authenticate") ?? "");
    throw new McpError("unauthorized", "Sign-in needed.", { status, ...parsed });
  }
  if (status === 404 && hadSession) throw new McpError("session_expired", "Session expired.");
  if (status < 200 || status >= 300)
    throw new McpError("status", `The connector answered with status ${status}.`, { status });
}

async function bounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > LIMITS.maxBodyBytes) {
      await reader.cancel().catch(() => undefined);
      throw new McpError("too_large", "Too large.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** One conversation with a server. */
export class Session {
  private sessionId: string | null = null;
  private protocol = CONNECTORS.protocolVersion;
  private nextId = 1;
  server: ServerInfo = { name: "", version: "", capabilities: null };
  notifications: unknown[] = [];

  private constructor(
    private readonly endpoint: URL,
    private readonly bearer: string | null,
    private readonly fetcher: Fetch,
    private readonly signal?: AbortSignal,
  ) {}

  /** `initialize`, then `notifications/initialized`. */
  static async open(
    endpoint: URL,
    bearer: string | null,
    fetcher: Fetch,
    signal?: AbortSignal,
  ): Promise<Session> {
    const session = new Session(endpoint, bearer, fetcher, signal);
    const result = (await session.request("initialize", {
      protocolVersion: CONNECTORS.protocolVersion,
      capabilities: {},
      clientInfo: { name: "Sub Rosa", version: "web" },
    })) as Json | null;
    if (typeof result?.protocolVersion === "string")
      session.protocol = result.protocolVersion.slice(0, 32);
    const info = (result?.serverInfo ?? {}) as Json;
    session.server = {
      name: typeof info.name === "string" ? info.name.slice(0, 120) : "",
      version: typeof info.version === "string" ? info.version.slice(0, 40) : "",
      capabilities: result?.capabilities ?? null,
    };
    await session.notify("notifications/initialized", {});
    return session;
  }

  get id() {
    return this.sessionId;
  }

  private async post(body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": this.protocol,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.bearer) headers.Authorization = `Bearer ${this.bearer}`;
    const timeout = AbortSignal.timeout(LIMITS.requestSeconds * 1000);
    const signal = anySignal([this.signal, timeout]);
    try {
      return await this.fetcher(this.endpoint.href, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
      });
    } catch (error) {
      if (this.signal?.aborted) throw error;
      throw new McpError("network", "The connector could not be reached.");
    }
  }

  private async notify(method: string, params: unknown) {
    const response = await this.post({ jsonrpc: "2.0", method, params });
    checkStatus(response, this.sessionId !== null);
    await response.body?.cancel().catch(() => undefined);
  }

  /** One request, its response, and the notifications that rode with it. */
  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params });
    checkStatus(response, this.sessionId !== null);
    if (method === "initialize") {
      const given = response.headers.get("mcp-session-id");
      if (given && given.length <= 256 && /^[\x21-\x7e]+$/.test(given)) this.sessionId = given;
    }
    const streamed = response.headers.get("content-type")?.includes("text/event-stream");
    if (!streamed) {
      const text = await bounded(response);
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        throw new McpError("invalid", "Not JSON.");
      }
      const outcome = rpcOutcome(message, id);
      if (!outcome) throw new McpError("invalid", "No response for this request.");
      if ("err" in outcome) throw outcome.err;
      return outcome.ok;
    }
    const reader = response.body?.getReader();
    if (!reader) throw new McpError("invalid", "The stream ended without a response.");
    const decoder = new TextDecoder();
    const events = new SseEvents();
    let received = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        const batch = done ? events.finish() : events.push(decoder.decode(value, { stream: true }));
        if (!done) {
          received += value.byteLength;
          if (received > LIMITS.maxBodyBytes) throw new McpError("too_large", "Too large.");
        }
        for (const data of batch) {
          let message: unknown;
          try {
            message = JSON.parse(data);
          } catch {
            continue;
          }
          const outcome = rpcOutcome(message, id);
          if (outcome) {
            if ("err" in outcome) throw outcome.err;
            return outcome.ok;
          }
          this.keep(message);
        }
        if (done) break;
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
    throw new McpError("invalid", "The stream ended without a response.");
  }

  private keep(message: unknown) {
    if (!message || typeof message !== "object") return;
    const value = message as Json;
    if (typeof value.method !== "string" || "id" in value) return;
    if (this.notifications.length >= MAX_NOTIFICATIONS) this.notifications.shift();
    this.notifications.push(message);
  }

  /** Every tool the server lists, across pages, up to the limit. */
  async listTools(): Promise<unknown[]> {
    const tools: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = (await this.request("tools/list", cursor ? { cursor } : {})) as Json | null;
      if (Array.isArray(result?.tools))
        tools.push(...result.tools.slice(0, LIMITS.maxTools - tools.length));
      cursor = typeof result?.nextCursor === "string" ? result.nextCursor : null;
      if (!cursor || tools.length >= LIMITS.maxTools) break;
    }
    return tools;
  }

  callTool(name: string, args: unknown): Promise<unknown> {
    const argumentsObject = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    return this.request("tools/call", { name, arguments: argumentsObject });
  }

  readResource(uri: string): Promise<unknown> {
    return this.request("resources/read", { uri });
  }

  /** Ends the session on the server, when it gave one. Best effort. */
  async close() {
    if (!this.sessionId) return;
    const headers: Record<string, string> = {
      "Mcp-Session-Id": this.sessionId,
      "MCP-Protocol-Version": this.protocol,
    };
    if (this.bearer) headers.Authorization = `Bearer ${this.bearer}`;
    await this.fetcher(this.endpoint.href, {
      method: "DELETE",
      headers,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    })
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
  }
}

// ── Tools and results ──────────────────────────────────────────────────────

export interface ToolInfo {
  name: string;
  title: string | null;
  description: string;
  inputSchema: unknown;
  readOnly: boolean;
  destructive: boolean;
  uiResource: string | null;
}

const chars = (text: string, max: number) => Array.from(text).slice(0, max).join("");

/** `mcp::tool_info`: a listed tool as the rest reads it, or null. */
export function toolInfo(value: unknown): ToolInfo | null {
  if (!value || typeof value !== "object") return null;
  const tool = value as Json;
  if (typeof tool.name !== "string") return null;
  const name = tool.name.trim();
  if (!name || new TextEncoder().encode(name).length > 128) return null;
  const annotations =
    tool.annotations && typeof tool.annotations === "object" ? (tool.annotations as Json) : {};
  const hint = (key: string) => (typeof annotations[key] === "boolean" ? annotations[key] : null);
  const meta = tool._meta && typeof tool._meta === "object" ? (tool._meta as Json) : {};
  const ui = meta.ui && typeof meta.ui === "object" ? (meta.ui as Json) : {};
  const uiResource =
    [ui.resourceUri, meta["ui/resourceUri"], meta["openai/outputTemplate"]].find(
      (uri): uri is string =>
        typeof uri === "string" && uri.startsWith("ui://") && uri.length <= 512,
    ) ?? null;
  const schema =
    tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
      ? tool.inputSchema
      : { type: "object", properties: {} };
  // A `title` that is there but not text hides the annotation's, as in Rust.
  const title = tool.title !== undefined ? tool.title : annotations.title;
  const readOnly = hint("readOnlyHint") ?? false;
  return {
    name,
    title: typeof title === "string" ? chars(title, 120) : null,
    description: typeof tool.description === "string" ? chars(tool.description, 1000) : "",
    inputSchema: schema,
    readOnly,
    destructive: !readOnly && (hint("destructiveHint") ?? true),
    uiResource,
  };
}

/** `mcp::result_text`: a tool result as the model reads it, bounded. */
export function resultText(result: unknown, limit: number): string {
  const value = (result && typeof result === "object" ? result : {}) as Json;
  const parts: string[] = [];
  if (Array.isArray(value.content))
    for (const raw of value.content) {
      const item = (raw ?? {}) as Json;
      const resource = (item.resource ?? {}) as Json;
      switch (item.type) {
        case "text":
          if (typeof item.text === "string") parts.push(item.text);
          break;
        case "resource_link":
          parts.push(
            `[link] ${typeof item.name === "string" ? item.name : ""} ${typeof item.uri === "string" ? item.uri : ""}`,
          );
          break;
        case "resource": {
          const uri = typeof resource.uri === "string" ? resource.uri : "";
          if (uri.startsWith("ui://")) parts.push("[An interactive view is shown to the user.]");
          else if (typeof resource.text === "string") parts.push(resource.text);
          break;
        }
        case "image":
          parts.push("[image omitted]");
          break;
        case "audio":
          parts.push("[audio omitted]");
          break;
      }
    }
  if (!parts.length && "structuredContent" in value)
    parts.push(JSON.stringify(value.structuredContent));
  let text = parts.join("\n");
  if (value.isError === true) text = `The tool reported an error: ${text}`;
  if (!text.trim()) text = "The tool returned nothing.";
  const all = Array.from(text);
  return all.length > limit ? `${all.slice(0, limit).join("")}\n[truncated]` : text;
}

/** `mcp::result_links`: the https links a result offers, six at most. */
export function resultLinks(result: unknown): { title: string; url: string }[] {
  const value = (result && typeof result === "object" ? result : {}) as Json;
  if (!Array.isArray(value.content)) return [];
  const out: { title: string; url: string }[] = [];
  for (const raw of value.content) {
    const item = (raw ?? {}) as Json;
    if (item.type !== "resource_link" || typeof item.uri !== "string") continue;
    if (!item.uri.startsWith("https://") || item.uri.length > 2048) continue;
    const named = item.title !== undefined ? item.title : item.name;
    const name = typeof named === "string" ? named : item.uri;
    out.push({ title: chars(name, 120), url: item.uri });
    if (out.length === 6) break;
  }
  return out;
}

/** An interactive view embedded in a result itself: `[uri, html]`. */
export function embeddedUi(result: unknown): [string, string] | null {
  const value = (result && typeof result === "object" ? result : {}) as Json;
  if (!Array.isArray(value.content)) return null;
  for (const raw of value.content) {
    const item = (raw ?? {}) as Json;
    const resource = (item.resource ?? {}) as Json;
    if (
      item.type === "resource" &&
      typeof resource.uri === "string" &&
      typeof resource.text === "string" &&
      resource.uri.startsWith("ui://")
    )
      return [resource.uri, resource.text];
  }
  return null;
}
