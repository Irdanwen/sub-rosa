// The workflow library: SQLite through the native process (ADR-0075), read
// through a synchronous cache so the editor keeps its simple calls.
//
// Workflows used to live in local storage (thirty at most, gone with the
// storage). `loadWorkflowLibrary` reads the table once, moves anything still
// in local storage into it the first time, and only then lets the editor
// render: an editor drawn before that would see an empty library and seed a
// first workflow over a real one. Writes update the cache at once and reach
// the table behind it.

import { invoke } from "@tauri-apps/api/core";
import { type Workflow, WORKFLOW_FILE_VERSION } from "./schema";

const LEGACY_KEY = "os-june:studio-workflows";

interface StoredWorkflow {
  id: string;
  name: string;
  description?: string | null;
  definition: string;
  formatVersion: number;
  origin: string;
  coverArtifactId?: string | null;
  createdAt: number;
  updatedAt: number;
}

let cache: Workflow[] = readLegacy();
let loading: Promise<Workflow[]> | undefined;
let loaded = false;
/** Workflows whose last save did not reach the table; retried with the next
 * save that does. */
const unsaved = new Set<string>();

function readLegacy(): Workflow[] {
  try {
    const raw = window.localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Workflow[]) : [];
  } catch {
    return [];
  }
}

function writeLegacy(workflows: Workflow[]): void {
  try {
    if (workflows.length === 0) window.localStorage.removeItem(LEGACY_KEY);
    else window.localStorage.setItem(LEGACY_KEY, JSON.stringify(workflows));
  } catch {
    // Local storage is only the old home; the table is the record.
  }
}

function fromStored(row: StoredWorkflow): Workflow | undefined {
  try {
    const graph = JSON.parse(row.definition) as Pick<Workflow, "nodes" | "edges">;
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return undefined;
    return {
      id: row.id,
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      nodes: graph.nodes,
      edges: graph.edges,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      origin: row.origin === "import" ? "import" : "mine",
      ...(row.coverArtifactId ? { coverArtifactId: row.coverArtifactId } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Write one workflow to the table. Resolves whether it got there. */
function persist(workflow: Workflow): Promise<boolean> {
  return invoke<void>("studio_workflow_save", {
    request: {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description ?? null,
      definition: JSON.stringify({ nodes: workflow.nodes, edges: workflow.edges }),
      formatVersion: WORKFLOW_FILE_VERSION,
      origin: workflow.origin ?? "mine",
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
    },
  }).then(
    () => {
      unsaved.delete(workflow.id);
      retryUnsaved();
      return true;
    },
    () => {
      // The cache still holds it; the next save that reaches the table
      // brings it along.
      unsaved.add(workflow.id);
      return false;
    },
  );
}

function retryUnsaved(): void {
  for (const id of [...unsaved]) {
    const workflow = cache.find((entry) => entry.id === id);
    unsaved.delete(id);
    if (workflow) void persist(workflow);
  }
}

function sorted(workflows: Workflow[]): Workflow[] {
  return [...workflows].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Read the library once (moving local storage into it the first time).
 * Resolves with the workflows, newest first. */
export function loadWorkflowLibrary(): Promise<Workflow[]> {
  loading ??= (async () => {
    const rows = (await invoke<StoredWorkflow[] | null>("studio_workflow_list")) ?? [];
    const stored = rows.flatMap((row) => fromStored(row) ?? []);
    const known = new Set(stored.map((workflow) => workflow.id));
    // What is only in the cache: local storage not moved yet, or a save made
    // while the table was being read.
    const pending = cache.filter((workflow) => !known.has(workflow.id));
    const written = await Promise.all(pending.map(persist));
    cache = sorted([...stored, ...pending]);
    // Local storage keeps only what did not reach the table, for the next
    // launch to move again. Keeping all of it would bring back, at every
    // launch, whatever was deleted meanwhile.
    writeLegacy(pending.filter((_, index) => !written[index]));
    loaded = true;
    return cache;
  })().catch(() => {
    // Without the table the library still works for this session, from the
    // cache; the next launch tries again.
    loading = undefined;
    loaded = true;
    return cache;
  });
  return loading;
}

export function workflowLibraryLoaded(): boolean {
  return loaded;
}

/** Saved workflows, most recently updated first. */
export function listWorkflows(): Workflow[] {
  return sorted(cache);
}

/** Upserts by id, refreshing updatedAt. Returns the stored copy. What the
 * library keeps beside the graph (its picture, where it came from) survives
 * a save from an editor that never knew about it. */
export function saveWorkflow(workflow: Workflow): Workflow {
  const previous = cache.find((existing) => existing.id === workflow.id);
  const updated: Workflow = {
    ...workflow,
    // The library owns these; an editor's copy may carry an older value.
    coverArtifactId: previous ? previous.coverArtifactId : workflow.coverArtifactId,
    origin: previous?.origin ?? workflow.origin,
    // Strictly newer than what the table holds: two saves in the same
    // millisecond must not tie, or the older could win.
    updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1),
  };
  cache = [updated, ...cache.filter((existing) => existing.id !== workflow.id)];
  void persist(updated);
  return updated;
}

export function deleteWorkflow(id: string): void {
  cache = cache.filter((workflow) => workflow.id !== id);
  unsaved.delete(id);
  // Not moved yet? Then it must not be moved later.
  const legacy = readLegacy();
  if (legacy.some((workflow) => workflow.id === id))
    writeLegacy(legacy.filter((workflow) => workflow.id !== id));
  void invoke("studio_workflow_delete", { id }).catch(() => {
    // Gone from this session; a failed delete shows again next launch.
  });
}

/** An empty workflow, not stored yet: pass it to `saveWorkflow` once it has
 * its graph, so the table never races an empty row against the full one. */
export function blankWorkflow(name: string): Workflow {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name,
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
    origin: "mine",
  };
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
    origin: "mine",
  };
  cache = [workflow, ...cache];
  void persist(workflow);
  return workflow;
}

/** The gallery file a workflow's card shows, or none. */
export async function setWorkflowCover(id: string, artifactId: string | undefined): Promise<void> {
  cache = cache.map((workflow) =>
    workflow.id === id ? { ...workflow, coverArtifactId: artifactId } : workflow,
  );
  await invoke("studio_workflow_set_cover", { id, artifactId: artifactId ?? null });
}

/** Tests only: forget the cache and the load. */
export function resetWorkflowLibraryForTests(): void {
  cache = readLegacy();
  loading = undefined;
  loaded = false;
}
