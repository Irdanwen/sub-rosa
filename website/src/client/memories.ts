/**
 * Managing memories from the browser, as Settings › Memory manages them in
 * the app (`memory/mod.rs`): list every memory, add one, edit its text, pause
 * it (`disabled`), forget it. Forgetting is a deletion that travels, so every
 * device forgets it too; pausing keeps it, unused, until it is resumed.
 *
 * A project's own memories ("Project only", ADR-0085) carry the project's
 * folder id in `scope`: they are listed with the project they belong to, and
 * a turn outside that project never reads them.
 */
import { type Row, timestamp } from "./codec";
import type { SyncClient } from "./sync";

export interface ManagedMemory {
  id: string;
  text: string;
  importance: number;
  disabled: boolean;
  /** null for the person's own memory, a project folder id otherwise. */
  scope: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

/** The app's cap on a memory's text. */
export const MAX_MEMORY_CHARS = 2000;
/** Importance of a memory the person or the `remember` tool adds. */
export const MANUAL_IMPORTANCE = 3;

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Every memory, paused ones included, newest first, as `memory_list`. */
export function allMemories(sync: SyncClient): ManagedMemory[] {
  return sync
    .rows("memories")
    .map((memory) => ({
      id: memory.id,
      text: text(memory.row.text),
      importance: Number(memory.row.importance ?? 5),
      disabled: Number(memory.row.disabled ?? 0) !== 0,
      scope: text(memory.row.scope) || null,
      source: text(memory.row.source),
      createdAt: text(memory.row.created_at),
      updatedAt: text(memory.row.updated_at),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The memories a turn in `scope` reads: live ones, most important first. */
export function memoriesInScope(sync: SyncClient, scope: string | null) {
  return allMemories(sync)
    .filter((memory) => !memory.disabled && memory.scope === scope)
    .sort((a, b) =>
      a.importance === b.importance
        ? b.createdAt.localeCompare(a.createdAt)
        : a.importance - b.importance,
    );
}

/** `memory_add` and the `remember` tool: a manual memory, once per scope. */
export async function addMemory(
  sync: SyncClient,
  fact: string,
  scope: string | null = null,
): Promise<"stored" | "known" | "empty"> {
  const clean = Array.from(fact.trim()).slice(0, MAX_MEMORY_CHARS).join("");
  if (!clean) return "empty";
  if (
    allMemories(sync).some(
      (memory) => memory.scope === scope && memory.text.toLowerCase() === clean.toLowerCase(),
    )
  )
    return "known";
  const now = timestamp();
  await sync.write("memories", {
    id: crypto.randomUUID(),
    text: clean,
    source: "manual",
    importance: MANUAL_IMPORTANCE,
    disabled: 0,
    created_at: now,
    updated_at: now,
    // A person's own memory travels without the column, as the app sends it.
    ...(scope ? { scope } : {}),
  });
  return "stored";
}

/** `memory_update`: new text, or paused and resumed. */
export async function updateMemory(
  sync: SyncClient,
  id: string,
  change: { text?: string; disabled?: boolean },
): Promise<boolean> {
  const memory = sync.objects.get(id);
  if (!memory || memory.deleted || memory.table !== "memories") return false;
  const next: Row = { ...memory.row, updated_at: timestamp() };
  if (change.text !== undefined) {
    const clean = Array.from(change.text.trim()).slice(0, MAX_MEMORY_CHARS).join("");
    if (!clean) return false;
    next.text = clean;
  }
  if (change.disabled !== undefined) next.disabled = change.disabled ? 1 : 0;
  await sync.write("memories", next);
  return true;
}

/** `memory_delete`: forgotten on every device. */
export async function forgetMemory(sync: SyncClient, id: string): Promise<boolean> {
  const memory = sync.objects.get(id);
  if (!memory || memory.deleted || memory.table !== "memories") return false;
  await sync.write("memories", memory.row, { deleted: true });
  return true;
}
