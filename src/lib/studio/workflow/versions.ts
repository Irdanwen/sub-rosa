// The versions of a workflow the person kept (⌘S): saved as the stored graph
// (the store's own form, so a version reads back exactly as a workflow
// does), compared with the graph as it now is, and gone back to.

import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import { stableJson } from "./stable-json";
import { definitionOf, fromStored } from "./store";
import { nodeLabel, type Workflow, WORKFLOW_FILE_VERSION } from "./schema";

export interface VersionEntry {
  id: string;
  label: string;
  createdAt: number;
}

interface StoredVersion extends VersionEntry {
  workflowId: string;
  definition: string;
  formatVersion: number;
}

export function listVersions(workflowId: string): Promise<VersionEntry[]> {
  return invoke<VersionEntry[]>("workflow_version_list", { workflowId });
}

/** Keep the workflow as it is now, under a name. */
export async function saveVersion(workflow: Workflow, label: string): Promise<VersionEntry> {
  const entry = { id: crypto.randomUUID(), label, createdAt: Date.now() };
  await invoke("workflow_version_save", {
    request: {
      ...entry,
      workflowId: workflow.id,
      definition: definitionOf(workflow),
      formatVersion: WORKFLOW_FILE_VERSION,
    },
  });
  return entry;
}

/** A kept version as a workflow: the one it belongs to, with its graph. */
export async function versionGraph(id: string, of: Workflow): Promise<Workflow | undefined> {
  const stored = await invoke<StoredVersion | null>("workflow_version_get", { id });
  if (!stored) return undefined;
  return fromStored({
    id: of.id,
    name: of.name,
    description: of.description ?? null,
    definition: stored.definition,
    formatVersion: stored.formatVersion,
    origin: of.origin ?? "mine",
    coverArtifactId: of.coverArtifactId ?? null,
    createdAt: of.createdAt,
    updatedAt: of.updatedAt,
  });
}

export function renameVersion(id: string, label: string): Promise<void> {
  return invoke("workflow_version_rename", { id, label });
}

export function deleteVersion(id: string): Promise<void> {
  return invoke("workflow_version_delete", { id });
}

export interface GraphDiff {
  added: string[];
  removed: string[];
  changed: string[];
  /** Wires added or taken away. */
  rewired: number;
}

/** What changed from one graph to the next, step by step: steps are matched
 * by id, a step is changed when its settings, mode or name differ (not when
 * it only moved), and wires are counted. */
export function graphDiff(
  before: Pick<Workflow, "nodes" | "edges">,
  after: Pick<Workflow, "nodes" | "edges">,
): GraphDiff {
  const old = new Map(before.nodes.map((node) => [node.id, node]));
  const now = new Map(after.nodes.map((node) => [node.id, node]));
  const essence = (node: Workflow["nodes"][number]) =>
    stableJson({
      type: node.type,
      label: node.label,
      params: node.params,
      mode: node.mode ?? null,
    });
  const added = after.nodes.filter((node) => !old.has(node.id)).map(nodeLabel);
  const removed = before.nodes.filter((node) => !now.has(node.id)).map(nodeLabel);
  const changed = after.nodes
    .filter((node) => {
      const was = old.get(node.id);
      return was !== undefined && essence(was) !== essence(node);
    })
    .map(nodeLabel);
  const wire = (edge: Workflow["edges"][number]) =>
    `${edge.source}>${edge.target}:${edge.targetPort ?? ""}:${edge.sourcePort ?? ""}`;
  const oldWires = new Set(before.edges.map(wire));
  const newWires = new Set(after.edges.map(wire));
  const rewired =
    [...newWires].filter((key) => !oldWires.has(key)).length +
    [...oldWires].filter((key) => !newWires.has(key)).length;
  return { added, removed, changed, rewired };
}

/** "2 steps added, 1 changed, 3 wires": what a diff says, in a line. */
export function diffSummary(diff: GraphDiff): string {
  const parts: string[] = [];
  if (diff.added.length)
    parts.push(
      diff.added.length === 1
        ? t("1 step added")
        : t("{count} steps added", { count: diff.added.length }),
    );
  if (diff.removed.length)
    parts.push(
      diff.removed.length === 1
        ? t("1 step removed")
        : t("{count} steps removed", { count: diff.removed.length }),
    );
  if (diff.changed.length)
    parts.push(
      diff.changed.length === 1
        ? t("1 step changed")
        : t("{count} steps changed", { count: diff.changed.length }),
    );
  if (diff.rewired)
    parts.push(diff.rewired === 1 ? t("1 wire") : t("{count} wires", { count: diff.rewired }));
  return parts.length > 0 ? parts.join(", ") : t("The same as now");
}
