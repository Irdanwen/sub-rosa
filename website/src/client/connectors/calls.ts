/**
 * Every connector call a turn makes, filed in this browser: "ask" is a
 * record, not a promise (ADR-0092). An ask files a pending call and puts a
 * `subrosa:connector` card under the reply; approving claims it (pending to
 * running, once, under a browser lock so two tabs cannot both run it), runs
 * it, and hands the result back to the conversation as a new turn. Calls
 * that run without asking are filed too, so the card shows what ran.
 */
import type { FeatureStore } from "../feature";
import { resultLinks, resultText } from "./mcp";

export type CallStatus = "pending" | "running" | "done" | "failed" | "denied";

export interface CallRecord {
  id: string;
  chatId: string | null;
  connectorId: string;
  tool: string;
  arguments: Record<string, unknown>;
  status: CallStatus;
  /** What it returned, bounded: its text and its links. */
  result: { text: string; links: { title: string; url: string }[]; isError: boolean } | null;
  error: string | null;
  /** The interactive view this call produced, when it did. */
  appId: string | null;
  createdAt: string;
}

const MAX_RESULT_CHARS = 4_000;

/** `calls::bounded`. */
export function bounded(result: unknown): NonNullable<CallRecord["result"]> {
  return {
    text: resultText(result, MAX_RESULT_CHARS),
    links: resultLinks(result),
    isError: (result as { isError?: unknown } | null)?.isError === true,
  };
}

export const callKey = (id: string) => `call:${id}`;

export async function fileCall(
  store: FeatureStore,
  call: Omit<CallRecord, "id" | "createdAt" | "result" | "error" | "appId">,
): Promise<CallRecord> {
  const record: CallRecord = {
    ...call,
    id: crypto.randomUUID(),
    result: null,
    error: null,
    appId: null,
    createdAt: new Date().toISOString(),
  };
  await store.put(callKey(record.id), record);
  return record;
}

export function getCall(store: FeatureStore, id: string) {
  return store.get<CallRecord>(callKey(id));
}

export async function updateCall(store: FeatureStore, id: string, change: Partial<CallRecord>) {
  const current = await getCall(store, id);
  if (!current) return null;
  const next = { ...current, ...change };
  await store.put(callKey(id), next);
  return next;
}

/** Calls waiting for the person in one chat, oldest first. */
export async function pendingCalls(store: FeatureStore, chatId: string): Promise<CallRecord[]> {
  return (await store.list<CallRecord>("call:"))
    .map((entry) => entry.value)
    .filter((call) => call.chatId === chatId && call.status === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Runs `work` while holding the call, or answers false when another tab or
 * another tap holds it. In-process first, then the browser's own lock. */
const held = new Set<string>();
export async function exclusively(id: string, work: () => Promise<void>): Promise<boolean> {
  if (held.has(id)) return false;
  held.add(id);
  try {
    const locks = (navigator as { locks?: LockManager }).locks;
    if (!locks) {
      await work();
      return true;
    }
    let ran = false;
    await locks.request(`subrosa-connector-call:${id}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      ran = true;
      await work();
    });
    return ran;
  } finally {
    held.delete(id);
  }
}

/** Claims a pending call: true once, false for every later or parallel try. */
export async function claim(store: FeatureStore, id: string): Promise<boolean> {
  const current = await getCall(store, id);
  if (current?.status !== "pending") return false;
  await updateCall(store, id, { status: "running" });
  return true;
}

export const callFence = (id: string) =>
  `\`\`\`subrosa:connector\n{"v":1,"callId":"${id}"}\n\`\`\``;
export const appFence = (id: string) => `\`\`\`subrosa:app\n{"v":1,"appId":"${id}"}\n\`\`\``;

/** `calls::with_cards`: the reply with this turn's cards under it, once
 * each; a card the model already copied is not repeated. */
export function withCards(answer: string, fences: string[]): string {
  let out = answer;
  for (const fence of fences) {
    const marker = fence.split("\n")[1] ?? "";
    if (!out.includes(marker)) out += `\n\n${fence}`;
  }
  return out;
}
