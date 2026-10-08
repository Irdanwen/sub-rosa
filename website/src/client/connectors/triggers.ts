/**
 * "When this happens": a connector event that starts an assignment run
 * (ADR-0092 on ADR-0091), in the browser. A trigger watches one thing on one
 * connector (a new item a read-only tool lists, or a resource that changed)
 * and is looked at only while the tab is open, every five minutes at most,
 * by a clock that keeps no state but its record. Its first look only learns
 * what is already there; later looks fire for what is new, three at most.
 *
 * The run itself belongs to the assignments feature, which registers how to
 * start one (`registerTriggerRunner`); without it, a trigger waits unlooked.
 * The app's calendar and mail triggers need its built-in Google and
 * Microsoft connectors, which a browser does not have.
 */
import type { FeatureStore } from "../feature";
import { resultLinks } from "./mcp";
import { callTool, type ConnectorEnv, readResource } from "./runtime";
import { getConnector } from "./store";
import { reachableFromWeb } from "./turn";
import { CONNECTORS, fill } from "./words";

export type TriggerKind = "tool_poll" | "resource_updated";

export interface TriggerRecord {
  id: string;
  assignmentId: string;
  connectorId: string;
  kind: TriggerKind;
  config: { tool?: string; arguments?: Record<string, unknown>; uri?: string };
  seen: string[];
  armed: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface Item {
  id: string;
  title: string;
}

/** How the assignments feature starts a run for an event. `runsHere` says
 * whether this browser is the device that runs that assignment. */
export interface TriggerRunner {
  runsHere(assignmentId: string): boolean;
  run(assignmentId: string, key: string, summary: string): Promise<void>;
}
let runner: TriggerRunner | null = null;
export function registerTriggerRunner(given: TriggerRunner | null) {
  runner = given;
}

const LIMITS = CONNECTORS.limits;
const chars = (text: string, max: number) => Array.from(text).slice(0, max).join("");

function field(object: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

function itemsFromArray(list: unknown[]): Item[] {
  const out: Item[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const id = field(entry, ["id", "number", "key", "identifier", "url", "uri"]);
    if (!id) continue;
    const title = field(entry, ["title", "name", "subject", "summary"]) ?? id;
    out.push({ id: chars(id, 200), title: chars(title, 200) });
  }
  return out;
}

function firstList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  for (const entry of Object.values(value as Record<string, unknown>))
    if (
      Array.isArray(entry) &&
      entry.some((item) => item && typeof item === "object" && !Array.isArray(item))
    )
      return entry;
  return null;
}

/** `triggers::items_from_result`: what a result lists, wherever it put it. */
export function itemsFromResult(result: unknown): Item[] {
  const value = (result ?? {}) as Record<string, unknown>;
  const structured = firstList(value.structuredContent);
  if (structured) {
    const items = itemsFromArray(structured);
    if (items.length) return items;
  }
  const links = resultLinks(result).map((link) => ({ id: link.url, title: link.title }));
  if (links.length) return links;
  if (!Array.isArray(value.content)) return [];
  for (const raw of value.content) {
    const text = (raw as { text?: unknown } | null)?.text;
    if (typeof text !== "string") continue;
    try {
      const list = firstList(JSON.parse(text));
      const items = list ? itemsFromArray(list) : [];
      if (items.length) return items;
    } catch {
      // Not JSON: nothing listed here.
    }
  }
  return [];
}

export function newItems(seen: string[], current: Item[]): Item[] {
  const known = new Set(seen);
  const out: Item[] = [];
  for (const item of current)
    if (!known.has(item.id) && !out.some((other) => other.id === item.id)) out.push(item);
  return out;
}

export function mergeSeen(seen: string[], current: Item[]): string[] {
  const merged = [...seen];
  for (const item of current) if (!merged.includes(item.id)) merged.push(item.id);
  return merged.length > LIMITS.triggerMaxSeen
    ? merged.slice(merged.length - LIMITS.triggerMaxSeen)
    : merged;
}

/** `triggers::decide`: unarmed, a look only learns; armed, it fires for
 * what is new, a few at a time, and what it could not fire stays unseen. */
export function decide(
  trigger: Pick<TriggerRecord, "seen" | "armed">,
  current: Item[],
): { fire: Item[]; seen: string[]; armed: true } {
  const fresh = newItems(trigger.seen, current);
  const fire = trigger.armed ? fresh.slice(0, LIMITS.triggerMaxFires) : [];
  const skipped = new Set(
    trigger.armed ? fresh.slice(LIMITS.triggerMaxFires).map((item) => item.id) : [],
  );
  const remembered = current.filter((item) => !skipped.has(item.id));
  return { fire, seen: mergeSeen(trigger.seen, remembered), armed: true };
}

export function due(lastCheckedAt: string | null, now = Date.now()): boolean {
  if (!lastCheckedAt) return true;
  const at = Date.parse(lastCheckedAt);
  return Number.isNaN(at) || now - at >= LIMITS.triggerCheckSeconds * 1000;
}

/** `triggers::describe`: why the run started, as its prompt says it. */
export function describeEvent(kind: TriggerKind, connectorName: string, item: Item): string {
  const template = CONNECTORS.triggerDescriptions[kind] ?? CONNECTORS.triggerDescriptions.tool_poll;
  return fill(template, { connector: connectorName, title: item.title, id: item.id });
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value ?? null));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const triggerKey = (id: string) => `trigger:${id}`;

export async function listTriggers(store: FeatureStore): Promise<TriggerRecord[]> {
  return (await store.list<TriggerRecord>("trigger:")).map((entry) => entry.value);
}

/** Saves a trigger; a changed trigger learns its backlog again. */
export async function saveTrigger(
  store: FeatureStore,
  trigger: Omit<TriggerRecord, "seen" | "armed" | "lastCheckedAt" | "lastError">,
) {
  const kind: TriggerKind = trigger.kind === "resource_updated" ? "resource_updated" : "tool_poll";
  const config =
    kind === "tool_poll"
      ? {
          tool: chars(String(trigger.config.tool ?? "").trim(), 128),
          arguments:
            trigger.config.arguments && JSON.stringify(trigger.config.arguments).length <= 4096
              ? trigger.config.arguments
              : {},
        }
      : { uri: chars(String(trigger.config.uri ?? "").trim(), 1024) };
  if (kind === "tool_poll" ? !config.tool : !config.uri)
    throw new Error("connector_trigger_invalid");
  await store.put(triggerKey(trigger.id), {
    ...trigger,
    kind,
    config,
    seen: [],
    armed: false,
    lastCheckedAt: null,
    lastError: null,
  } satisfies TriggerRecord);
}

export const deleteTrigger = (store: FeatureStore, id: string) => store.delete(triggerKey(id));

/** One look at every trigger that is due and whose assignment runs here. */
export async function checkTriggers(env: ConnectorEnv, signal?: AbortSignal, now = Date.now()) {
  if (!runner) return;
  for (const trigger of await listTriggers(env.store)) {
    if (signal?.aborted) return;
    if (!due(trigger.lastCheckedAt, now) || !runner.runsHere(trigger.assignmentId)) continue;
    const connector = getConnector(env.sync, trigger.connectorId);
    const stamp = new Date(now).toISOString();
    if (!connector?.enabled || !reachableFromWeb(connector)) {
      await env.store.put(triggerKey(trigger.id), { ...trigger, lastCheckedAt: stamp });
      continue;
    }
    let current: Item[];
    try {
      if (trigger.kind === "resource_updated") {
        const read = await readResource(env, connector, trigger.config.uri ?? "");
        const value = await digest((read as { contents?: unknown } | null)?.contents ?? null);
        current = [{ id: value, title: trigger.config.uri ?? "" }];
      } else {
        const result = await callTool(
          env,
          connector,
          trigger.config.tool ?? "",
          trigger.config.arguments ?? {},
          signal,
        );
        current = itemsFromResult(result);
      }
    } catch (error) {
      await env.store.put(triggerKey(trigger.id), {
        ...trigger,
        lastCheckedAt: stamp,
        lastError: error instanceof Error ? error.message : "error",
      });
      continue;
    }
    const decision = decide(trigger, current);
    await env.store.put(triggerKey(trigger.id), {
      ...trigger,
      seen: decision.seen,
      armed: decision.armed,
      lastCheckedAt: stamp,
      lastError: null,
    });
    for (const item of decision.fire)
      await runner
        .run(
          trigger.assignmentId,
          `${trigger.id}:${item.id}`,
          describeEvent(trigger.kind, connector.name, item),
        )
        .catch(() => undefined);
  }
}
