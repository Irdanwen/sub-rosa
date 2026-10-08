/**
 * What Rust says about connectors and skill packs (ADR-0092), read from
 * `packages/chat-core/web/connectors.json` (`agent_lite::web_features`), and
 * what the CORS probe found about each catalog server from a tab
 * (`website/scripts/probe-connectors.mjs`). Neither is written by hand here.
 */
import exported from "@subrosa/chat-core/web/connectors.json";
import { registerTables, type TableCodec } from "../codec";
import type { ToolDefinition } from "../codec";
import availability from "./web-availability.json";

export interface CatalogEntry {
  id: string;
  name: string;
  url: string;
  description: string;
  auth: "oauth" | "none";
}

interface Export {
  catalog: CatalogEntry[];
  protocolVersion: string;
  limits: {
    requestSeconds: number;
    maxBodyBytes: number;
    maxTools: number;
    maxOffered: number;
    maxSchemaBytes: number;
    resultChars: number;
    pendingSignInSeconds: number;
    triggerCheckSeconds: number;
    triggerMaxSeen: number;
    triggerMaxFires: number;
    researchExcerptChars: number;
    researchMaxConnectors: number;
    appMaxHtmlBytes: number;
    appMaxOutputBytes: number;
  };
  promptNote: string;
  declaration: { description: string; askDescription: string };
  sentences: {
    notOffered: string;
    removed: string;
    turnedOff: string;
    awaitsConfirmation: string;
    resultFrom: string;
    couldNot: string;
  };
  triggerDescriptions: Record<string, string>;
  app: { csp: string; cspMarker: string; bridge: string };
  skills: {
    offeredPrompt: string;
    pickedPrompt: string;
    loadSkill: ToolDefinition;
    missing: string;
    unreadable: string;
    maxOffered: number;
    maxBodyChars: number;
  };
  tables: Record<string, TableCodec>;
}

export const CONNECTORS = exported as unknown as Export;

// The definitions travel with the account's settings (ADR-0092): this
// browser reads and writes them like the app does.
registerTables(CONNECTORS.tables);

export interface WebAvailability {
  web: boolean;
  /** Why a tab cannot use it: the first step that refused the site's origin. */
  reason: string | null;
  /** Every origin a tab calls for it, for the page's `connect-src`. */
  connect: string[];
}
const probed = availability as unknown as {
  probedAt: string;
  servers: Record<string, WebAvailability>;
};
export const PROBED_AT = probed.probedAt;

/** What the probe found for a catalog server; a server it never saw is not
 * offered on the web until it is probed. */
export function webAvailability(catalogId: string): WebAvailability {
  return probed.servers[catalogId] ?? { web: false, reason: "not_probed", connect: [] };
}

/** Every origin `/app`'s `connect-src` names for connectors: what the probe
 * found reachable. The page can call nothing else (ADR-0096 keeps
 * `connect-src` to named origins), and `src/test/website-csp.test.ts` holds
 * the policy equal to this list. */
export function webConnectOrigins(): string[] {
  return [
    ...new Set(
      Object.values(probed.servers).flatMap((server) => (server.web ? server.connect : [])),
    ),
  ].sort();
}

let extraOrigins: string[] = [];
/** Origins a page's policy also names: a test's fake server, or a
 * development page with its own policy. Production names none. */
export function configurePageOrigins(origins: string[]) {
  extraOrigins = [...origins];
}

/** Why a connector cannot be used from this tab, or null when it can. A
 * custom server (developer mode) is reachable only when its address is one of
 * the origins the page's policy names. */
export function webRefusal(connector: {
  auth: string;
  catalogId: string;
  url: string;
}): string | null {
  if (!["oauth", "none", "token"].includes(connector.auth)) return "app_only";
  if (connector.catalogId) return webAvailability(connector.catalogId).reason;
  let origin = "";
  try {
    origin = new URL(connector.url).origin;
  } catch {
    return "page_policy";
  }
  return webConnectOrigins().includes(origin) || extraOrigins.includes(origin)
    ? null
    : "page_policy";
}

/** Fills `{name}` placeholders in one pass, so a value that itself contains
 * a placeholder is never filled again. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z]+)\}/g, (whole, key: string) =>
    key in values ? values[key] : whole,
  );
}
