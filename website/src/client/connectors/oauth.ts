/**
 * OAuth 2.1 for connectors, from the browser: the port of
 * `connectors/oauth.rs` (ADR-0092). A server's `401` names its protected
 * resource metadata (RFC 9728), which names the authorization server, whose
 * metadata (RFC 8414 or OpenID, with path insertion) gives the endpoints.
 * The page registers itself as a public client (RFC 7591) and signs in with
 * PKCE `S256` (a server that does not declare it is refused) and the
 * resource indicator (RFC 8707).
 *
 * The redirect is the site's own `/app`. The verifier and the state are
 * sealed in this browser (`secrets.ts`) before the page leaves, single use,
 * forgotten after fifteen minutes, and the flow must come back to the
 * address it left for.
 */
import { encode } from "../../lib/vault";
import { type Fetch, McpError, validateEndpoint } from "./mcp";
import { pendingSlot, type Secrets } from "./secrets";
import { CONNECTORS } from "./words";

const MAX_METADATA_BYTES = 256 * 1024;

export class OAuthError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export interface AuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  scopes: string[];
  resource: string | null;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds since the epoch. */
  expiresAt: number | null;
  tokenEndpoint: string;
  clientId: string;
  resource: string | null;
  scope: string | null;
}

export interface PendingFlow {
  accountId: string;
  connectorId: string;
  verifier: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  resource: string | null;
  /** Seconds since the epoch. */
  createdAt: number;
}

const b64 = (bytes: Uint8Array) => encode(bytes);
export const nowSeconds = () => Math.floor(Date.now() / 1000);

/** 256 random bits, base64url. */
export function randomToken(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64(new Uint8Array(digest));
}

/** Scheme, host and port: the browser's own serialization. */
const originOf = (url: URL) => url.origin;

/** RFC 9728 §3.1: with the endpoint's path inserted, then without. */
export function protectedResourceCandidates(endpoint: URL): string[] {
  const base = originOf(endpoint);
  const path = endpoint.pathname.replace(/\/+$/, "");
  return [
    ...(path ? [`${base}/.well-known/oauth-protected-resource${path}`] : []),
    `${base}/.well-known/oauth-protected-resource`,
  ];
}

/** RFC 8414 and OpenID, with path insertion, then OpenID appended. */
export function authorizationServerCandidates(issuer: URL): string[] {
  const base = originOf(issuer);
  const path = issuer.pathname.replace(/\/+$/, "");
  return path
    ? [
        `${base}/.well-known/oauth-authorization-server${path}`,
        `${base}/.well-known/openid-configuration${path}`,
        `${base}${path}/.well-known/openid-configuration`,
      ]
    : [
        `${base}/.well-known/oauth-authorization-server`,
        `${base}/.well-known/openid-configuration`,
      ];
}

const secure = (raw: unknown) => (typeof raw === "string" ? validateEndpoint(raw) : null);

async function getJson(fetcher: Fetch, url: string): Promise<Record<string, unknown> | null> {
  if (!secure(url)) return null;
  try {
    const response = await fetcher(url, {
      headers: { Accept: "application/json" },
      credentials: "omit",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > MAX_METADATA_BYTES) return null;
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const strings = (value: unknown, max = 16): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, max)
    : [];

/** The endpoints a server's metadata gives; refused without `S256`. */
export function parseAuthServer(value: Record<string, unknown>, issuer: string): AuthServer {
  const endpoint = (key: string) => {
    const raw = value[key];
    return typeof raw === "string" && secure(raw) ? raw : null;
  };
  const authorizationEndpoint = endpoint("authorization_endpoint");
  const tokenEndpoint = endpoint("token_endpoint");
  if (!authorizationEndpoint || !tokenEndpoint) throw new OAuthError("connector_oauth_discovery");
  if (!strings(value.code_challenge_methods_supported, 64).includes("S256"))
    throw new OAuthError("connector_oauth_pkce");
  return {
    issuer: typeof value.issuer === "string" ? value.issuer : issuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: endpoint("registration_endpoint"),
    scopes: [],
    resource: null,
  };
}

/** A server's address as a resource indicator: no query, no fragment, no
 * trailing slash. */
export function canonicalResource(endpoint: URL): string {
  return `${originOf(endpoint)}${endpoint.pathname.replace(/\/+$/, "")}`;
}

/** From a server's `401` to its authorization server. */
export async function discover(
  fetcher: Fetch,
  endpoint: URL,
  metadataHint: string | null,
  scopeHint: string | null,
): Promise<AuthServer> {
  const candidates = [
    ...(metadataHint && secure(metadataHint) ? [metadataHint] : []),
    ...protectedResourceCandidates(endpoint),
  ];
  let issuers: string[] = [];
  let scopes: string[] = [];
  let resource: string | null = null;
  for (const candidate of candidates) {
    const metadata = await getJson(fetcher, candidate);
    if (metadata) {
      issuers = strings(metadata.authorization_servers);
      scopes = strings(metadata.scopes_supported);
      resource = typeof metadata.resource === "string" ? metadata.resource : null;
      break;
    }
  }
  // No resource metadata: the server is its own authorization server.
  if (!issuers.length) issuers = [originOf(endpoint)];
  for (const issuer of issuers) {
    const issuerUrl = secure(issuer);
    if (!issuerUrl) continue;
    for (const candidate of authorizationServerCandidates(issuerUrl)) {
      const metadata = await getJson(fetcher, candidate);
      if (!metadata) continue;
      const server = parseAuthServer(metadata, issuer);
      server.scopes = scopeHint?.trim() ? scopeHint.split(/\s+/).filter(Boolean) : scopes;
      server.resource = resource && secure(resource) ? resource : canonicalResource(endpoint);
      return server;
    }
  }
  throw new OAuthError("connector_oauth_discovery");
}

/** Registers the page as a public client and returns its id. */
export async function register(
  fetcher: Fetch,
  server: AuthServer,
  redirectUri: string,
): Promise<string> {
  const endpoint = secure(server.registrationEndpoint);
  if (!endpoint) throw new OAuthError("connector_oauth_registration");
  let value: Record<string, unknown> = {};
  try {
    const response = await fetcher(endpoint.href, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "Sub Rosa",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "web",
      }),
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new OAuthError("connector_oauth_registration");
    value = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new OAuthError("connector_oauth_registration");
  }
  const id = value.client_id;
  if (typeof id !== "string" || !id || id.length > 512)
    throw new OAuthError("connector_oauth_registration");
  return id;
}

export function authorizeUrl(request: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scopes: string[];
  resource: string | null;
}): string {
  const url = new URL(request.authorizationEndpoint);
  url.searchParams.append("response_type", "code");
  url.searchParams.append("client_id", request.clientId);
  url.searchParams.append("redirect_uri", request.redirectUri);
  url.searchParams.append("code_challenge", request.challenge);
  url.searchParams.append("code_challenge_method", "S256");
  url.searchParams.append("state", request.state);
  if (request.scopes.length) url.searchParams.append("scope", request.scopes.join(" "));
  if (request.resource) url.searchParams.append("resource", request.resource);
  return url.href;
}

export function parseTokenResponse(
  value: Record<string, unknown>,
  context: { tokenEndpoint: string; clientId: string; resource: string | null },
  previousRefresh: string | null,
  now: number,
): Tokens {
  const access = value.access_token;
  if (typeof access !== "string" || !access) throw new OAuthError("connector_oauth_failed");
  if (typeof value.token_type === "string" && value.token_type.toLowerCase() !== "bearer")
    throw new OAuthError("connector_oauth_failed");
  const refresh =
    typeof value.refresh_token === "string" && value.refresh_token ? value.refresh_token : null;
  const expires =
    typeof value.expires_in === "number" &&
    Number.isInteger(value.expires_in) &&
    value.expires_in > 0
      ? now + value.expires_in
      : null;
  return {
    accessToken: access,
    refreshToken: refresh ?? previousRefresh,
    expiresAt: expires,
    tokenEndpoint: context.tokenEndpoint,
    clientId: context.clientId,
    resource: context.resource,
    scope: typeof value.scope === "string" ? value.scope : null,
  };
}

async function postForm(
  fetcher: Fetch,
  endpoint: string,
  form: [string, string][],
): Promise<Record<string, unknown>> {
  if (!secure(endpoint)) throw new OAuthError("connector_oauth_failed");
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new OAuthError("connector_oauth_failed");
  }
  const value = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok)
    throw new OAuthError(
      value?.error === "invalid_grant" ? "connector_sign_in" : "connector_oauth_failed",
    );
  return value ?? {};
}

export function isExpiring(tokens: Tokens, now: number): boolean {
  return tokens.expiresAt !== null && tokens.expiresAt - 60 <= now;
}

export async function exchange(fetcher: Fetch, flow: PendingFlow, code: string): Promise<Tokens> {
  const form: [string, string][] = [
    ["grant_type", "authorization_code"],
    ["code", code],
    ["redirect_uri", flow.redirectUri],
    ["client_id", flow.clientId],
    ["code_verifier", flow.verifier],
  ];
  if (flow.resource) form.push(["resource", flow.resource]);
  const value = await postForm(fetcher, flow.tokenEndpoint, form);
  return parseTokenResponse(value, flow, null, nowSeconds());
}

/** Trades the refresh token; the old one is kept when no new one comes. */
export async function refresh(fetcher: Fetch, tokens: Tokens): Promise<Tokens> {
  if (!tokens.refreshToken) throw new OAuthError("connector_sign_in");
  const form: [string, string][] = [
    ["grant_type", "refresh_token"],
    ["refresh_token", tokens.refreshToken],
    ["client_id", tokens.clientId],
  ];
  if (tokens.resource) form.push(["resource", tokens.resource]);
  const value = await postForm(fetcher, tokens.tokenEndpoint, form);
  return parseTokenResponse(value, tokens, tokens.refreshToken, nowSeconds());
}

/** Seals the flow before the page leaves for the authorization page. */
export function storePending(secrets: Secrets, state: string, flow: PendingFlow) {
  return secrets.put(pendingSlot(state), flow);
}

/** The flow a returning state names: single use, fifteen minutes, this
 * account. */
export async function takePending(
  secrets: Secrets,
  state: string,
  accountId: string,
  now: number,
): Promise<PendingFlow> {
  if (!state || state.length > 128 || !/^[A-Za-z0-9_-]+$/.test(state))
    throw new OAuthError("connector_oauth_failed");
  const flow = await secrets.take<PendingFlow>(pendingSlot(state));
  if (!flow || flow.accountId !== accountId) throw new OAuthError("connector_oauth_failed");
  if (now - flow.createdAt > CONNECTORS.limits.pendingSignInSeconds)
    throw new OAuthError("connector_oauth_expired");
  return flow;
}

/** What a return to `/app` carries: a code, or a refusal, with its state. */
export function parseCallback(
  url: string,
): { state: string; code: string } | { state: string; denied: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const state = parsed.searchParams.get("state");
  if (!state) return null;
  const denied = parsed.searchParams.get("error");
  if (denied !== null) return { state, denied: Array.from(denied).slice(0, 80).join("") };
  const code = parsed.searchParams.get("code");
  return code ? { state, code } : null;
}

/** The return came back to the address the flow left for. */
export function redirectMatches(url: string, redirectUri: string): boolean {
  try {
    const got = new URL(url);
    const want = new URL(redirectUri);
    return (
      got.protocol === want.protocol &&
      got.host === want.host &&
      got.pathname.replace(/\/+$/, "") === want.pathname.replace(/\/+$/, "")
    );
  } catch {
    return false;
  }
}

/** A `401` as discovery hints. */
export function hintsOf(error: unknown): { metadata: string | null; scope: string | null } {
  return error instanceof McpError && error.kind === "unauthorized"
    ? { metadata: error.detail.resourceMetadata ?? null, scope: error.detail.scope ?? null }
    : { metadata: null, scope: null };
}
