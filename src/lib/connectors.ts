/**
 * Connectors (ADR-0092): the services the assistant may read and act in.
 *
 * The facade over `src-tauri/src/connectors/`. Definitions synchronise with
 * the account; tokens stay in each device's keychain and never cross into the
 * webview, so nothing here ever holds one. On the computer the general
 * assistant runs on Hermes, whose MCP configuration the catalog also writes
 * (see `ConnectorsSection`).
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

export const CONNECTORS_CHANGED_EVENT = "connectors://changed";

export type ToolRule = "allow" | "ask" | "deny";

export type ConnectorTool = {
  name: string;
  title: string | null;
  description: string;
  readOnly: boolean;
  rule: ToolRule;
  /** The person chose the rule, rather than the default. */
  chosen: boolean;
  /** The tool draws an interactive view. */
  interactive: boolean;
};

export type ConnectorAuth = "oauth" | "none" | "token" | "google" | "microsoft";

export type Connector = {
  id: string;
  name: string;
  url: string;
  catalogId: string;
  auth: ConnectorAuth;
  enabled: boolean;
  toolPolicy: Record<string, string>;
  status: "idle" | "connected" | "needs_sign_in" | "error";
  lastError: string | null;
  signedIn: boolean;
  tools: ConnectorTool[];
  toolsFetchedAt: string | null;
};

export type CatalogServer = {
  id: string;
  name: string;
  url: string;
  description: string;
  auth: "oauth" | "none";
};

export type CatalogBuiltin = {
  id: "google" | "microsoft";
  name: string;
  available: boolean;
  description: string;
  gated: { id: string; name: string; state: "requires_verification" }[];
};

export type ConnectorCatalog = { servers: CatalogServer[]; builtins: CatalogBuiltin[] };

export type SignInResult = { authUrl: string | null; connected: boolean };

export function connectorCatalog() {
  return invoke<ConnectorCatalog>("connector_catalog");
}

export function connectorList() {
  return invoke<Connector[]>("connector_list");
}

export function connectorAdd(request: {
  catalogId?: string;
  name?: string;
  url?: string;
  auth?: "oauth" | "none" | "token";
}) {
  return invoke<Connector>("connector_add", { request });
}

export function connectorRemove(id: string) {
  return invoke<void>("connector_remove", { id });
}

export function connectorSetEnabled(id: string, enabled: boolean) {
  return invoke<Connector>("connector_set_enabled", { id, enabled });
}

export function connectorSetToolPolicy(id: string, tool: string, rule: ToolRule | null) {
  return invoke<Connector>("connector_set_tool_policy", { id, tool, rule });
}

export function connectorSignIn(id: string) {
  return invoke<SignInResult>("connector_sign_in", { id });
}

export function connectorSignOut(id: string) {
  return invoke<Connector>("connector_sign_out", { id });
}

/** A token pasted for a custom connector. Written to the keychain and never
 * read back. */
export function connectorSetToken(id: string, token: string) {
  return invoke<Connector>("connector_set_token", { id, token });
}

export function connectorRefreshTools(id: string) {
  return invoke<Connector>("connector_refresh_tools", { id });
}

export type ConnectorCall = {
  id: string;
  taskId: string;
  connectorId: string;
  connectorName: string;
  tool: string;
  toolTitle: string | null;
  arguments: unknown;
  status: "pending" | "running" | "done" | "failed" | "denied";
  result: { text: string; links: { title: string; url: string }[]; isError: boolean } | null;
  error: string | null;
  createdAt: string;
  appId: string | null;
};

export function connectorCallGet(id: string) {
  return invoke<ConnectorCall>("connector_call_get", { id });
}

export function connectorCallDecide(id: string, approve: boolean) {
  return invoke<ConnectorCall>("connector_call_decide", { id, approve });
}

export type ConnectorApp = {
  id: string;
  connectorId: string;
  connectorName: string;
  tool: string;
  uri: string;
  /** The one origin the view may reach. */
  origin: string;
  toolInput: unknown;
  toolOutput: unknown;
};

export function connectorAppGet(id: string) {
  return invoke<ConnectorApp>("connector_app_get", { id });
}

export function connectorAppCallTool(
  id: string,
  tool: string,
  args: Record<string, unknown>,
  confirmed: boolean,
) {
  return invoke<unknown>("connector_app_call_tool", {
    id,
    tool,
    arguments: args,
    confirmed,
  });
}

export type ConnectorTrigger = {
  id: string;
  assignmentId: string;
  connectorId: string;
  kind: "calendar_event" | "email_match" | "tool_poll" | "resource_updated";
  config: Record<string, unknown>;
  armed: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
};

export function connectorTriggers(assignmentId?: string) {
  return invoke<ConnectorTrigger[]>("connector_triggers", { assignmentId: assignmentId ?? null });
}

export function connectorTriggerSave(request: {
  id?: string;
  assignmentId: string;
  connectorId: string;
  kind: ConnectorTrigger["kind"];
  config: Record<string, unknown>;
}) {
  return invoke<ConnectorTrigger>("connector_trigger_save", { request });
}

export function connectorTriggerDelete(id: string) {
  return invoke<void>("connector_trigger_delete", { id });
}

/** The trigger kinds a connector can offer: the built-in providers watch
 * their calendars and mail, an MCP server a listing tool or a resource. */
export function triggerKindsFor(connector: Pick<Connector, "auth">): ConnectorTrigger["kind"][] {
  if (connector.auth === "google") return ["calendar_event"];
  if (connector.auth === "microsoft") return ["calendar_event", "email_match"];
  return ["tool_poll", "resource_updated"];
}

/** Whether a connector can be used here right now. */
export function connectorReady(connector: Connector): boolean {
  return connector.enabled && connector.signedIn && connector.status !== "needs_sign_in";
}

/** The developer-mode switch that shows "Add custom connector". Kept on this
 * device: it changes what a screen offers, nothing else. */
const DEVELOPER_MODE_KEY = "os-june:connectors-developer-mode";

export function readDeveloperMode(): boolean {
  try {
    return window.localStorage.getItem(DEVELOPER_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeDeveloperMode(on: boolean) {
  try {
    window.localStorage.setItem(DEVELOPER_MODE_KEY, on ? "1" : "0");
  } catch {
    // A private window: the switch lasts as long as the screen.
  }
}

/** The connectors and the catalog, kept current with the backend's events. */
export function useConnectors() {
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [catalog, setCatalog] = useState<ConnectorCatalog | null>(null);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(() => {
    connectorList()
      .then((list) => {
        setConnectors(list);
        setError(null);
      })
      .catch(setError);
  }, []);

  useEffect(() => {
    refresh();
    connectorCatalog()
      .then(setCatalog)
      .catch(() => setCatalog({ servers: [], builtins: [] }));
    let off: (() => void) | undefined;
    let disposed = false;
    listen(CONNECTORS_CHANGED_EVENT, refresh)
      .then((unlisten) => {
        if (disposed) unlisten();
        else off = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      off?.();
    };
  }, [refresh]);

  return { connectors, catalog, error, refresh };
}
