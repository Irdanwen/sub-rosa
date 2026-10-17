// What an app needs to run its workflow away from the canvas (the phone's
// Apps, ADR-0119): the graph a run sees, the level its results are read at,
// what one run is expected to cost, and the candidates a held gate offers.
// The same steps the canvas takes (useRunPicture): blocks put in place, set
// aside steps taken out, lists laid out.

import type { MediaCatalog } from "../types";
import { estimateWorkflowCost, type WorkflowCostEstimate } from "./cost";
import { flattenBlocks } from "./flatten";
import { liftResults, type StepView, viewAt } from "./lift";
import { expandLists } from "./lists";
import { applyModes } from "./modes";
import { edgesOnPort } from "./ordering";
import type { NodeRunResult } from "./run-types";
import type { Workflow } from "./schema";
import { validateWorkflow } from "./validator";

export interface AppGraph {
  /** What a run sees. */
  effective: Workflow;
  /** The workflow's top level, for reading results back onto its steps. */
  view: StepView;
}

export function appGraph(workflow: Workflow): AppGraph {
  const flattened = flattenBlocks(workflow);
  return {
    effective: expandLists(applyModes(flattened.workflow)),
    view: viewAt({ ...flattened, workflow: expandLists(flattened.workflow) }, []),
  };
}

export function appEstimate(graph: AppGraph, catalog: MediaCatalog): WorkflowCostEstimate {
  return estimateWorkflowCost(graph.effective, catalog);
}

/** Why the app cannot run yet, in the first problem's words, or none. */
export function appBlocker(graph: AppGraph): string | undefined {
  const check = validateWorkflow(graph.effective);
  return check.ok ? undefined : check.errors[0]?.message;
}

/** A run's results as the app's steps show them. */
export function appResults(
  results: ReadonlyMap<string, NodeRunResult>,
  graph: AppGraph,
): Map<string, NodeRunResult> {
  return liftResults(results, graph.view);
}

/** The gate a run holds at, if any, with what it offers to continue with. */
export function heldGate(
  results: ReadonlyMap<string, NodeRunResult>,
  graph: AppGraph,
):
  | {
      gateId: string;
      note?: string;
      candidates: Array<{ id: string; label: string; result?: NodeRunResult }>;
    }
  | undefined {
  const held = [...results.values()].find((result) => result.status === "awaiting");
  if (!held) return undefined;
  const gate = graph.effective.nodes.find((node) => node.id === held.nodeId);
  const candidates = edgesOnPort(graph.effective, held.nodeId, "in").map((edge) => {
    const node = graph.effective.nodes.find((entry) => entry.id === edge.source);
    return { id: edge.source, label: node?.label ?? "", result: results.get(edge.source) };
  });
  const note =
    typeof gate?.params.note === "string" && gate.params.note.trim() ? gate.params.note : held.note;
  return { gateId: held.nodeId, ...(note ? { note } : {}), candidates };
}

/** Steps a phone cannot finish on its own while it sleeps: an assembly and
 * a sound mix are made in this window, not by the provider. */
export function needsWindowOpen(graph: AppGraph): boolean {
  return graph.effective.nodes.some((node) => node.type === "assemble" || node.type === "soundMix");
}
