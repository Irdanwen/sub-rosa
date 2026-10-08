/**
 * A connector in use from the browser: a fresh token, a session, a call
 * (the port of `connectors/runtime.rs`). A `401` triggers one refresh and one
 * retry; a second marks the connector as needing a sign-in rather than
 * failing in a loop. An expired session is opened again once.
 */
import type { FeatureStore } from "../feature";
import type { SyncClient } from "../sync";
import { type Fetch, McpError, Session, type ToolInfo, toolInfo, validateEndpoint } from "./mcp";
import {
  authorizeUrl,
  challengeFor,
  discover,
  exchange,
  hintsOf,
  isExpiring,
  nowSeconds,
  OAuthError,
  type PendingFlow,
  parseCallback,
  randomToken,
  redirectMatches,
  refresh,
  register,
  storePending,
  takePending,
  type Tokens,
} from "./oauth";
import { type Secrets, tokensSlot } from "./secrets";
import { type Connector, getConnector, localState, updateLocal } from "./store";

export interface ConnectorEnv {
  accountId: string;
  sync: SyncClient;
  store: FeatureStore;
  secrets: Secrets;
  fetch: Fetch;
  /** Where a sign-in comes back: the site's own `/app`. */
  redirectUri: string;
  /** This browser as a device of the account, so a call relayed through
   * another device is never addressed to itself (ADR-0107). */
  deviceId?: string | null;
}

/** Thrown when a connector needs the person to sign in (again). */
export class NeedsSignIn extends Error {
  constructor() {
    super("connector_sign_in");
  }
}

/** The address a sign-in returns to on this site. */
export function appRedirectUri(location: { origin: string } = window.location): string {
  return `${location.origin}${import.meta.env.BASE_URL ?? "/"}app`;
}

/** Whether this browser holds what the connector needs to be called. */
export async function hasCredential(env: ConnectorEnv, connector: Connector): Promise<boolean> {
  if (connector.auth === "none") return true;
  if (connector.auth === "token")
    return Boolean(await env.secrets.get<string>(tokensSlot(connector.id)));
  if (connector.auth !== "oauth") return false;
  return Boolean(await env.secrets.get<Tokens>(tokensSlot(connector.id)));
}

/** The credential to send, refreshed first when it is about to expire. */
async function bearer(env: ConnectorEnv, connector: Connector): Promise<string | null> {
  if (connector.auth === "none") return null;
  if (connector.auth === "token") {
    const token = await env.secrets.get<string>(tokensSlot(connector.id));
    if (!token) throw new NeedsSignIn();
    return token;
  }
  const current = await env.secrets.get<Tokens>(tokensSlot(connector.id));
  if (!current) throw new NeedsSignIn();
  if (isExpiring(current, nowSeconds()) && current.refreshToken) {
    const fresh = await refresh(env.fetch, current);
    await env.secrets.put(tokensSlot(connector.id), fresh);
    return fresh.accessToken;
  }
  return current.accessToken;
}

async function refreshAfter401(env: ConnectorEnv, connector: Connector): Promise<boolean> {
  if (connector.auth !== "oauth") return false;
  const current = await env.secrets.get<Tokens>(tokensSlot(connector.id));
  if (!current) return false;
  try {
    await env.secrets.put(tokensSlot(connector.id), await refresh(env.fetch, current));
    return true;
  } catch {
    return false;
  }
}

async function open(env: ConnectorEnv, connector: Connector, signal?: AbortSignal) {
  const endpoint = validateEndpoint(connector.url);
  if (!endpoint) throw new McpError("invalid", "address");
  let token: string | null;
  try {
    token = await bearer(env, connector);
  } catch (error) {
    if (
      error instanceof NeedsSignIn ||
      (error instanceof OAuthError && error.code === "connector_sign_in")
    )
      throw new McpError("unauthorized", "Sign-in needed.");
    throw new McpError("network", error instanceof Error ? error.message : "network");
  }
  return Session.open(endpoint, token, env.fetch, signal);
}

/** Runs `work` on a fresh session, once more after a refresh or an expired
 * session; the session is closed either way. */
export async function withSession<T>(
  env: ConnectorEnv,
  connector: Connector,
  work: (session: Session) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const session = await open(env, connector, signal);
      try {
        return await work(session);
      } finally {
        void session.close();
      }
    } catch (error) {
      if (error instanceof McpError && error.kind === "unauthorized") {
        if (attempt === 1 && (await refreshAfter401(env, connector))) continue;
        await updateLocal(env.store, connector.id, {
          status: "needs_sign_in",
          message: null,
        });
        throw new NeedsSignIn();
      }
      if (error instanceof McpError && error.kind === "session_expired" && attempt === 1) continue;
      throw error;
    }
  }
}

/** Lists the server's tools and keeps them for the next turn. */
export async function refreshTools(
  env: ConnectorEnv,
  connector: Connector,
  signal?: AbortSignal,
): Promise<ToolInfo[]> {
  try {
    const listed = await withSession(env, connector, (session) => session.listTools(), signal);
    const tools = listed.map(toolInfo).filter((tool): tool is ToolInfo => tool !== null);
    await updateLocal(env.store, connector.id, {
      tools,
      toolsFetchedAt: new Date().toISOString(),
      status: "connected",
      message: null,
    });
    return tools;
  } catch (error) {
    if (!(error instanceof NeedsSignIn))
      await updateLocal(env.store, connector.id, { status: "error", message: describe(error) });
    throw error;
  }
}

export function callTool(
  env: ConnectorEnv,
  connector: Connector,
  tool: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  return withSession(env, connector, (session) => session.callTool(tool, args), signal);
}

export function readResource(env: ConnectorEnv, connector: Connector, uri: string) {
  return withSession(env, connector, (session) => session.readResource(uri));
}

/** The reason a call failed, as the model and the card say it. */
export function describe(error: unknown): string {
  if (error instanceof NeedsSignIn) return "This connector needs you to sign in again.";
  if (error instanceof McpError)
    switch (error.kind) {
      case "unauthorized":
        return "This connector needs you to sign in again.";
      case "session_expired":
        return "The connector closed the session. Try again.";
      case "status":
        return `The connector answered with status ${error.detail.status}.`;
      case "rpc":
        return `The connector refused: ${Array.from(error.message).slice(0, 300).join("")}`;
      case "too_large":
        return "The connector sent back more than Sub Rosa can read at once.";
      case "invalid":
        return "The connector answered in a way Sub Rosa does not understand.";
      case "network":
        return "The connector could not be reached. Check your connection.";
    }
  if (error instanceof OAuthError) return error.code;
  return "The connector could not be reached. Check your connection.";
}

// ── Signing in ─────────────────────────────────────────────────────────────

export type SignIn = { kind: "connected" } | { kind: "browser"; url: string };

/** Probes the server, discovers how it signs in, registers the page if it
 * has to, and seals the pending flow before the page leaves. */
export async function beginSignIn(env: ConnectorEnv, connector: Connector): Promise<SignIn> {
  if (connector.auth === "none") return { kind: "connected" };
  if (connector.auth === "token") {
    if (await hasCredential(env, connector)) return { kind: "connected" };
    throw new OAuthError("connector_token_missing");
  }
  if (connector.auth !== "oauth") throw new OAuthError("connector_unavailable");
  const endpoint = validateEndpoint(connector.url);
  if (!endpoint) throw new OAuthError("connector_url_invalid");
  let hints = { metadata: null as string | null, scope: null as string | null };
  try {
    const session = await Session.open(endpoint, null, env.fetch);
    // It answers without a token, but it was added to be signed in to: its
    // metadata says how (Hugging Face serves a public subset anonymously).
    void session.close();
  } catch (error) {
    if (!(error instanceof McpError) || error.kind !== "unauthorized") throw error;
    hints = hintsOf(error);
  }
  const server = await discover(env.fetch, endpoint, hints.metadata, hints.scope);
  const local = await localState(env.store, connector.id);
  let clientId =
    local.oauthClient?.issuer === server.issuer && local.oauthClient.redirectUri === env.redirectUri
      ? local.oauthClient.clientId
      : null;
  if (!clientId) {
    clientId = await register(env.fetch, server, env.redirectUri);
    await updateLocal(env.store, connector.id, {
      oauthClient: { issuer: server.issuer, clientId, redirectUri: env.redirectUri },
    });
  }
  const verifier = randomToken();
  const state = randomToken();
  const flow: PendingFlow = {
    accountId: env.accountId,
    connectorId: connector.id,
    verifier,
    tokenEndpoint: server.tokenEndpoint,
    clientId,
    redirectUri: env.redirectUri,
    resource: server.resource,
    createdAt: nowSeconds(),
  };
  await storePending(env.secrets, state, flow);
  return {
    kind: "browser",
    url: authorizeUrl({
      authorizationEndpoint: server.authorizationEndpoint,
      clientId,
      redirectUri: env.redirectUri,
      challenge: await challengeFor(verifier),
      state,
      scopes: server.scopes,
      resource: server.resource,
    }),
  };
}

export type Completion =
  | { kind: "none" }
  | { kind: "connected"; connectorId: string }
  | { kind: "failed"; reason: string; connectorId?: string };

/** Finishes a sign-in the page came back from: `/app?code=…&state=…`. A
 * URL that carries no sign-in answers `none`. */
export async function completeSignIn(env: ConnectorEnv, url: string): Promise<Completion> {
  const callback = parseCallback(url);
  if (!callback) return { kind: "none" };
  let flow: PendingFlow;
  try {
    flow = await takePending(env.secrets, callback.state, env.accountId, nowSeconds());
  } catch (error) {
    // A state this browser never sealed is not a sign-in of ours.
    if (error instanceof OAuthError && error.code === "connector_oauth_failed")
      return { kind: "none" };
    return {
      kind: "failed",
      reason: error instanceof OAuthError ? error.code : "connector_oauth_failed",
    };
  }
  if (!redirectMatches(url, flow.redirectUri))
    return { kind: "failed", reason: "connector_oauth_failed", connectorId: flow.connectorId };
  if ("denied" in callback)
    return { kind: "failed", reason: "connector_oauth_denied", connectorId: flow.connectorId };
  try {
    const tokens = await exchange(env.fetch, flow, callback.code);
    await env.secrets.put(tokensSlot(flow.connectorId), tokens);
    await updateLocal(env.store, flow.connectorId, { status: "connected", message: null });
    const connector = getConnector(env.sync, flow.connectorId);
    if (connector) await refreshTools(env, connector).catch(() => undefined);
    return { kind: "connected", connectorId: flow.connectorId };
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof OAuthError ? error.code : "connector_oauth_failed",
      connectorId: flow.connectorId,
    };
  }
}

/** Developer mode: the token a service gave, kept sealed here. */
export async function setToken(env: ConnectorEnv, connectorId: string, token: string) {
  const trimmed = token.trim();
  if (!trimmed) throw new OAuthError("connector_token_missing");
  await env.secrets.put(tokensSlot(connectorId), trimmed);
}

export async function signOut(env: ConnectorEnv, connectorId: string) {
  await env.secrets.delete(tokensSlot(connectorId));
  await updateLocal(env.store, connectorId, { status: null, tools: [], toolsFetchedAt: null });
}
