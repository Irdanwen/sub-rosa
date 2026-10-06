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

function persist(workflow: Workflow): Promise<void> {
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
  }).catch(() => {
    // The cache still holds it for this session, and `loadWorkflowLibrary`
    // writes whatever the table lacks on the next launch.
  });
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
    await Promise.all(pending.map(persist));
    cache = sorted([...stored, ...pending]);
    try {
      window.localStorage.removeItem(LEGACY_KEY);
    } catch {
      // Left behind, it is moved again harmlessly: ids are kept.
    }
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

/** Upserts by id, refreshing updatedAt. Returns the stored copy. */
export function saveWorkflow(workflow: Workflow): Workflow {
  const updated: Workflow = { ...workflow, updatedAt: Date.now() };
  cache = [updated, ...cache.filter((existing) => existing.id !== workflow.id)];
  void persist(updated);
  return updated;
}

export function deleteWorkflow(id: string): void {
  cache = cache.filter((workflow) => workflow.id !== id);
  void invoke("studio_workflow_delete", { id }).catch(() => {
    // Gone from this session; a failed delete shows again next launch.
  });
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
