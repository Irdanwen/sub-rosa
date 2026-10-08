/**
 * Connectors as this browser sees them: the synchronised definition (the
 * `connectors` row, ADR-0092) and what this browser alone knows of it, kept
 * in the feature's sealed store: its listed tools, its status, the client a
 * sign-in registered, and the developer-mode switch.
 */
import { timestamp } from "../codec";
import type { FeatureStore } from "../feature";
import type { SyncClient } from "../sync";
import type { ToolInfo } from "./mcp";
import { validateEndpoint } from "./mcp";
import { parsePolicy, type Rule, slug } from "./rules";
import { CONNECTORS } from "./words";

export interface Connector {
  id: string;
  name: string;
  url: string;
  catalogId: string;
  /** `oauth`, `none` or `token` on the web. The app's built-ins (`google`,
   * `microsoft`, `github`) sign in with the app's own client ids and are not
   * offered in a browser. */
  auth: string;
  enabled: boolean;
  toolPolicy: Record<string, string>;
}

export interface LocalState {
  tools: ToolInfo[];
  toolsFetchedAt: string | null;
  status: "connected" | "needs_sign_in" | "error" | null;
  message: string | null;
  /** The client a sign-in registered, reused while issuer and redirect hold. */
  oauthClient: { issuer: string; clientId: string; redirectUri: string } | null;
}

const EMPTY: LocalState = {
  tools: [],
  toolsFetchedAt: null,
  status: null,
  message: null,
  oauthClient: null,
};

/** The app's built-ins: their sign-in needs the app's own client ids. */
export const APP_ONLY_AUTH = ["google", "microsoft", "github"];

function connectorOf(row: Record<string, unknown>): Connector {
  return {
    id: String(row.id),
    name: typeof row.name === "string" ? row.name : String(row.id),
    url: typeof row.url === "string" ? row.url : "",
    catalogId: typeof row.catalog_id === "string" ? row.catalog_id : "",
    auth: typeof row.auth === "string" ? row.auth : "oauth",
    enabled: Number(row.enabled) !== 0,
    toolPolicy: parsePolicy(row.tool_policy),
  };
}

export function listConnectors(sync: SyncClient): Connector[] {
  return sync
    .rows("connectors")
    .map((object) => ({
      connector: connectorOf(object.row),
      at: String(object.row.created_at ?? ""),
    }))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((entry) => entry.connector);
}

/** A connector's object is a UUID derived from its id (`objectIdOf`), so it
 * is found by the id its row carries. */
function objectOf(sync: SyncClient, id: string) {
  return sync.rows("connectors").find((object) => object.row.id === id);
}

export function getConnector(sync: SyncClient, id: string): Connector | null {
  const object = objectOf(sync, id);
  return object ? connectorOf(object.row) : null;
}

export class ConnectorError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

/** `connector_for`: the row an add request describes. */
export function connectorFor(request: {
  catalogId?: string;
  name?: string;
  url?: string;
  auth?: string;
}): Connector {
  const blank = { enabled: true, toolPolicy: {} };
  if (request.catalogId) {
    const entry = CONNECTORS.catalog.find((item) => item.id === request.catalogId);
    if (!entry) throw new ConnectorError("connector_not_found");
    return {
      ...blank,
      id: entry.id,
      name: entry.name,
      url: entry.url,
      catalogId: entry.id,
      auth: entry.auth,
    };
  }
  const url = validateEndpoint(request.url ?? "");
  if (!url) throw new ConnectorError("connector_url_invalid");
  const name = Array.from(request.name?.trim() || url.hostname || "Connector")
    .slice(0, 60)
    .join("");
  const auth = request.auth === "none" || request.auth === "token" ? request.auth : "oauth";
  return {
    ...blank,
    id: `${slug(name)}-${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`,
    name,
    url: url.href,
    catalogId: "",
    auth,
  };
}

function rowOf(connector: Connector, createdAt: string) {
  return {
    id: connector.id,
    name: connector.name,
    url: connector.url,
    catalog_id: connector.catalogId,
    auth: connector.auth,
    enabled: connector.enabled ? 1 : 0,
    tool_policy: JSON.stringify(connector.toolPolicy),
    created_at: createdAt,
    updated_at: timestamp(),
  };
}

export async function addConnector(sync: SyncClient, connector: Connector) {
  if (getConnector(sync, connector.id)) throw new ConnectorError("connector_duplicate");
  await sync.write("connectors", rowOf(connector, timestamp()));
}

async function rewrite(sync: SyncClient, id: string, change: (connector: Connector) => Connector) {
  const object = objectOf(sync, id);
  if (!object) throw new ConnectorError("connector_not_found");
  await sync.write(
    "connectors",
    rowOf(change(connectorOf(object.row)), String(object.row.created_at ?? timestamp())),
  );
}

export const setEnabled = (sync: SyncClient, id: string, enabled: boolean) =>
  rewrite(sync, id, (connector) => ({ ...connector, enabled }));

export const setToolRule = (sync: SyncClient, id: string, tool: string, rule: Rule) =>
  rewrite(sync, id, (connector) => ({
    ...connector,
    toolPolicy: { ...connector.toolPolicy, [tool]: rule },
  }));

export async function removeConnector(sync: SyncClient, id: string) {
  const object = objectOf(sync, id);
  if (!object) return;
  await sync.write("connectors", object.row, { deleted: true });
}

// ── This browser's own state ────────────────────────────────────────────────

export async function localState(store: FeatureStore, id: string): Promise<LocalState> {
  return { ...EMPTY, ...((await store.get<LocalState>(`state:${id}`)) ?? {}) };
}

export async function updateLocal(
  store: FeatureStore,
  id: string,
  change: Partial<LocalState>,
): Promise<LocalState> {
  const next = { ...(await localState(store, id)), ...change };
  await store.put(`state:${id}`, next);
  return next;
}

export async function forgetLocal(store: FeatureStore, id: string) {
  await store.delete(`state:${id}`);
}

export async function developerMode(store: FeatureStore): Promise<boolean> {
  return (await store.get<boolean>("settings:developer")) === true;
}
export function setDeveloperMode(store: FeatureStore, on: boolean) {
  return store.put("settings:developer", on);
}
