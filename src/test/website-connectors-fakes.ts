// Fakes for the web client's connectors: an MCP server and its authorization
// server, behind one `fetch`, following the protocol's rules closely enough
// to drive discovery, registration, PKCE, refresh, sessions and streams.
// @ts-expect-error node:crypto is available in the Vitest runtime.
import { createHash } from "node:crypto";
import type { FeatureHost } from "../../website/src/client/feature";
import { featureStore, OPEN_GUARDS } from "../../website/src/client/feature";
import { memoryClientStore } from "../../website/src/client/store";
import { SyncClient } from "../../website/src/client/sync";
import { FakeJournal } from "./website-client-fakes";

export const ACCOUNT = "0191d1a4-0000-7000-8000-00000000a11c";
export const MCP = "https://mcp.test/mcp";

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

export interface ServerOptions {
  /** Answer in an event stream instead of JSON. */
  sse?: boolean;
  /** Hand out a session id at initialize. */
  session?: boolean;
  /** No token needed. */
  open?: boolean;
  tools?: Record<string, unknown>[];
  /** What a tools/call answers, by tool. */
  results?: Record<string, unknown>;
}

export function fakeServers(options: ServerOptions = {}) {
  const state = {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    issued: 0,
    challenge: "",
    registered: [] as Record<string, unknown>[],
    calls: [] as { method: string; params: unknown; session: string | null; auth: string | null }[],
    sessions: new Set<string>(),
    /** Expire every session once, to see the client open a new one. */
    expireSessions: false,
    refreshAnswerHasRefreshToken: false,
    log: [] as string[],
  };
  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const answer = (id: unknown, result: unknown, headers: Record<string, string> = {}) => {
    const message = { jsonrpc: "2.0", id, result };
    if (!options.sse) return json(message, 200, headers);
    const note = { jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } };
    return new Response(`data: ${JSON.stringify(note)}\n\ndata: ${JSON.stringify(message)}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream", ...headers },
    });
  };
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    state.log.push(`${method} ${url.origin}${url.pathname}`);
    if (url.href === MCP && method === "DELETE") return new Response(null, { status: 204 });
    if (url.href === MCP) {
      const auth = headers.get("authorization");
      if (!options.open && auth !== `Bearer ${state.accessToken}`)
        return new Response("", {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp", scope="read write"',
          },
        });
      const body = JSON.parse(String(init.body)) as {
        id?: number;
        method: string;
        params?: unknown;
      };
      const session = headers.get("mcp-session-id");
      state.calls.push({ method: body.method, params: body.params, session, auth });
      if (session && !state.sessions.has(session)) return new Response("", { status: 404 });
      if (body.method === "initialize") {
        const extra: Record<string, string> = {};
        if (options.session) {
          const id = `session-${state.sessions.size + 1}`;
          state.sessions.add(id);
          extra["mcp-session-id"] = id;
        }
        return answer(
          body.id,
          {
            protocolVersion: "2025-06-18",
            serverInfo: { name: "Fake", version: "1" },
            capabilities: {},
          },
          extra,
        );
      }
      if (state.expireSessions && session) {
        state.expireSessions = false;
        state.sessions.delete(session);
        return new Response("", { status: 404 });
      }
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (body.method === "tools/list") return answer(body.id, { tools: options.tools ?? [] });
      if (body.method === "tools/call") {
        const name = (body.params as { name: string }).name;
        return answer(
          body.id,
          options.results?.[name] ?? { content: [{ type: "text", text: `ran ${name}` }] },
        );
      }
      if (body.method === "resources/read")
        return answer(body.id, {
          contents: [
            {
              uri: (body.params as { uri: string }).uri,
              mimeType: "text/html",
              text: "<p>view</p>",
            },
          ],
        });
      return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } });
    }
    if (url.href === "https://mcp.test/.well-known/oauth-protected-resource/mcp")
      return json({
        resource: MCP,
        authorization_servers: ["https://auth.test"],
        scopes_supported: ["read"],
      });
    if (url.href === "https://auth.test/.well-known/oauth-authorization-server")
      return json({
        issuer: "https://auth.test",
        authorization_endpoint: "https://auth.test/authorize",
        token_endpoint: "https://auth.test/token",
        registration_endpoint: "https://auth.test/register",
        code_challenge_methods_supported: ["S256"],
      });
    if (url.href === "https://auth.test/register" && method === "POST") {
      state.registered.push(JSON.parse(String(init.body)));
      return json({ client_id: `client-${state.registered.length}` }, 201);
    }
    if (url.href === "https://auth.test/token" && method === "POST") {
      const form = new URLSearchParams(String(init.body));
      if (form.get("grant_type") === "authorization_code") {
        const verifier = form.get("code_verifier") ?? "";
        const challenge = b64url(new Uint8Array(createHash("sha256").update(verifier).digest()));
        if (form.get("code") !== "the-code" || challenge !== state.challenge)
          return json({ error: "invalid_grant" }, 400);
        state.issued += 1;
        return json({
          access_token: state.accessToken,
          refresh_token: state.refreshToken,
          token_type: "Bearer",
          expires_in: 3600,
          resource_seen: form.get("resource"),
        });
      }
      if (form.get("grant_type") === "refresh_token") {
        if (form.get("refresh_token") !== state.refreshToken)
          return json({ error: "invalid_grant" }, 400);
        state.accessToken = `access-${++state.issued + 1}`;
        return json({
          access_token: state.accessToken,
          token_type: "bearer",
          expires_in: 3600,
          ...(state.refreshAnswerHasRefreshToken ? { refresh_token: "refresh-2" } : {}),
        });
      }
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, state };
}

export function client() {
  const journal = new FakeJournal();
  const store = memoryClientStore();
  const key = new Uint8Array(32).fill(7);
  return {
    journal,
    store,
    key,
    sync: new SyncClient(ACCOUNT, key, store, journal.transport()),
  };
}

/** The page as a feature sees it, with `ask` recorded. */
export function fakeHost(
  sync: SyncClient,
  store = memoryClientStore(),
  over: Partial<FeatureHost> = {},
) {
  const asked: { question: string; options: unknown }[] = [];
  const key = new Uint8Array(32).fill(7);
  const host: FeatureHost = {
    account: { id: ACCOUNT, email: "a@example.test", created_at: "" } as FeatureHost["account"],
    device: { id: "device", name: "Browser" },
    sync,
    vaultKey: key,
    storeFor: (feature) => featureStore(ACCOUNT, key, store, feature),
    operator: { root: "https://operator.test", fetch: async () => new Response("{}") },
    openKey: async () => "cdm_test",
    model: "m",
    models: [],
    live: [],
    guards: OPEN_GUARDS,
    setGuards: () => undefined,
    memory: true,
    openChatId: null,
    busy: false,
    ask: async (question, options) => {
      asked.push({ question, options });
      return { chatId: "chat", answer: "ok", stopped: false };
    },
    stop: () => undefined,
    openChat: () => undefined,
    openPanel: () => undefined,
    notify: () => undefined,
    refresh: () => undefined,
    ...over,
  };
  return { host, asked };
}
