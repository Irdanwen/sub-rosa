// Workflow execution: nodes run level by level (Kahn topological order),
// each level in parallel. Node outputs are typed, never string-tagged, and
// edges land on named ports — a video node's prompt, opening frame, end frame
// and references are four different inputs, not one merged stream.
//
// Media persists at the node that produced it (through the injected storage),
// carrying real provenance: the resolved prompt, the model, and — when a shot
// continues another through a lastFrame node — the parent links of ADR-0019.
// A workflow-produced chain is therefore a real chain: visible in the gallery,
// continuable by hand, and trimmed at its handoffs by the assemble node.
//
// This file is the scheduler. What each node does lives in execute-node.ts,
// the gate in gate.ts, the outage patience in transient.ts and the shared
// types in run-types.ts.

import { t } from "../../i18n";
import {
  isPaidNode,
  maybeNodeSchema,
  outputKindOf,
  resolveInputPort,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
} from "./schema";
import { validateWorkflow } from "./validator";
import {
  type NodeOutput,
  type NodeRunResult,
  GateHold,
  type RunWorkflowOptions,
  WorkflowRunError,
} from "./run-types";
import { executeNode } from "./execute-node";
import { withTransientTolerance } from "./transient";
import { gateDecision } from "./gate";

export { awaitingGateIds, WorkflowRunError } from "./run-types";
export type {
  ChainRef,
  DurableRenderRequest,
  LoadedAsset,
  NodeOutput,
  NodeRunResult,
  RunWorkflowOptions,
  SavedMedia,
  SaveMediaMeta,
  WorkflowStorage,
} from "./run-types";
export { INPUT_MARKER, placeLines, resolvePrompt } from "./execute-node";
export {
  isTransientSpendFailure,
  TRANSIENT_WAIT_BUDGET_MS,
  transientDelays,
  withTransientTolerance,
} from "./transient";

/** Groups node ids into topological levels: nodes within a level share no
 * dependency and can run in parallel. Throws on cycles. */
export function topoLevels(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[][] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }
  for (const edge of edges) {
    if (!inDegree.has(edge.source) || !inDegree.has(edge.target)) continue;
    adjacency.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }
  const levels: string[][] = [];
  let frontier = nodes.filter((node) => inDegree.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  while (frontier.length > 0) {
    levels.push(frontier);
    visited += frontier.length;
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of adjacency.get(id) ?? []) {
        const degree = (inDegree.get(child) ?? 1) - 1;
        inDegree.set(child, degree);
        if (degree === 0) next.push(child);
      }
    }
    frontier = next;
  }
  if (visited !== nodes.length) {
    throw new Error(t("The workflow contains a cycle."));
  }
  return levels;
}

/**
 * Upstream outputs grouped by the port each edge lands on, in edge order.
 * Edges whose port cannot be resolved were already flagged by validation;
 * here they are simply skipped.
 */
function portInputs(
  node: WorkflowNode,
  edges: WorkflowEdge[],
  results: Map<string, NodeRunResult>,
  nodeById: Map<string, WorkflowNode>,
): Map<string, NodeOutput[]> {
  const schema = maybeNodeSchema(node.type);
  const ports = new Map<string, NodeOutput[]>();
  if (!schema) return ports;
  for (const edge of edges) {
    if (edge.target !== node.id) continue;
    const parent = nodeById.get(edge.source);
    const output = results.get(edge.source)?.output;
    if (!parent || !output) continue;
    // Resolved against the node itself, so an input its model does not carry
    // (a frame on a reference-to-video model) is dropped here rather than
    // reaching the request builder, which would send a field the model
    // ignores while still billing the render.
    const port = resolveInputPort(node, edge, outputKindOf(parent, { nodeById, edges }));
    if (!port) continue;
    const bucket = ports.get(port.id);
    if (bucket) bucket.push(output);
    else ports.set(port.id, [output]);
  }
  return ports;
}

/** Runs the workflow and resolves with every node's final result. Rejects
 * with WorkflowRunError (carrying the partial results) when validation or a
 * node fails, and with an AbortError DOMException on cancellation. */
export async function runWorkflow(
  workflow: Workflow,
  options: RunWorkflowOptions = {},
): Promise<Map<string, NodeRunResult>> {
  const results = new Map<string, NodeRunResult>();
  for (const node of workflow.nodes) {
    results.set(node.id, { nodeId: node.id, status: "pending" });
  }

  const validation = validateWorkflow(workflow);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new WorkflowRunError(
      first ? first.message : "The workflow is invalid.",
      results,
      first?.nodeId,
    );
  }

  const levels = topoLevels(workflow.nodes, workflow.edges);
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const beforeNode = options.beforeNode;
  const update = (result: NodeRunResult) => {
    results.set(result.nodeId, result);
    options.onUpdate?.(result);
  };

  for (const level of levels) {
    if (options.signal?.aborted) {
      throw new DOMException("The workflow run was cancelled.", "AbortError");
    }
    const failures: Array<{ nodeId: string; message: string }> = [];
    let aborted = false;
    let held = false;
    // allSettled semantics: siblings that finish keep their results even when
    // another node in the level fails.
    await Promise.all(
      level.map(async (nodeId) => {
        const node = nodeById.get(nodeId);
        if (!node) return;
        // Unknown schemas were rejected by validation; this is a type guard.
        if (!maybeNodeSchema(node.type)) return;
        // A resumed run replays finished nodes from their cached outputs
        // instead of re-executing (and re-spending) them.
        const cached = options.completed?.get(nodeId);
        if (cached) {
          update({ nodeId, status: "done", output: cached });
          return;
        }
        update({ nodeId, status: "running" });
        try {
          const ports = portInputs(node, workflow.edges, results, nodeById);
          // A gate checks the budget itself, and only when its judge is
          // about to read: an approval already given spends nothing.
          if (node.type !== "gate" && isPaidNode(node)) {
            await options.beforeNode?.(node);
          }
          const output =
            node.type === "gate"
              ? await gateDecision(node, workflow.edges, results, options.approvedGates, {
                  signal: options.signal,
                  beforeJudge: beforeNode ? () => beforeNode(node) : undefined,
                })
              : await withTransientTolerance(
                  () =>
                    executeNode(node, ports, {
                      signal: options.signal,
                      storage: options.storage,
                      costCredits: options.nodeCosts?.[nodeId],
                      durableMedia: options.durableMedia,
                      onProgress: (fraction) =>
                        update({ nodeId, status: "running", progress: fraction }),
                    }),
                  {
                    signal: options.signal,
                    budgetMs: options.transientWaitMs,
                    onWait: (note) => update({ nodeId, status: "running", note }),
                  },
                );
          update({ nodeId, status: "done", output });
        } catch (error) {
          if (error instanceof GateHold) {
            // Not a failure: the production is waiting for the user.
            held = true;
            update({ nodeId, status: "awaiting", note: error.note });
            return;
          }
          if (error instanceof DOMException && error.name === "AbortError") {
            // Cancellation is not a node failure; leave the node pending.
            aborted = true;
            update({ nodeId, status: "pending" });
            return;
          }
          const message = error instanceof Error ? error.message : "The node failed.";
          update({ nodeId, status: "error", error: message });
          failures.push({ nodeId, message });
        }
      }),
    );
    if (aborted || options.signal?.aborted) {
      throw new DOMException("The workflow run was cancelled.", "AbortError");
    }
    const firstFailure = failures[0];
    if (firstFailure) {
      throw new WorkflowRunError(firstFailure.message, results, firstFailure.nodeId);
    }
    // A held gate ends the run here, cleanly: what finished stays finished,
    // everything downstream stays pending, and the caller reads the awaiting
    // nodes off the results (see `awaitingGateIds`).
    if (held) return results;
  }
  return results;
}
