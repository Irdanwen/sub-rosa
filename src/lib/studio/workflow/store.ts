// localStorage persistence for saved workflows. Pure functions, no store
// library: the workflow editor reads on mount and writes on change.

import type { Workflow } from "./schema";

const STORAGE_KEY = "os-june:studio-workflows";
const MAX_WORKFLOWS = 30;

function readAll(): Workflow[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Workflow[]) : [];
  } catch {
    return [];
  }
}

function writeAll(workflows: Workflow[]): void {
  const capped = [...workflows].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_WORKFLOWS);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(capped));
  } catch {
    // Quota pressure: drop the older half (keeping at least the newest) and
    // retry once. If that still fails, persistence is best-effort.
    const pruned = capped.slice(0, Math.max(1, Math.floor(capped.length / 2)));
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned));
    } catch {
      // Give up silently; the in-memory workflow is still usable.
    }
  }
}

/** Saved workflows, most recently updated first. */
export function listWorkflows(): Workflow[] {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Upserts by id, refreshing updatedAt. Returns the stored copy. */
export function saveWorkflow(workflow: Workflow): Workflow {
  const updated: Workflow = { ...workflow, updatedAt: Date.now() };
  writeAll([updated, ...readAll().filter((existing) => existing.id !== workflow.id)]);
  return updated;
}

export function deleteWorkflow(id: string): void {
  writeAll(readAll().filter((workflow) => workflow.id !== id));
}

/** Creates, persists, and returns an empty workflow. */
export function createWorkflow(name: string): Workflow {
  const now = Date.now();
  const workflow: Workflow = {
    id: crypto.randomUUID(),
    name,
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
  };
  writeAll([workflow, ...readAll()]);
  return workflow;
}
