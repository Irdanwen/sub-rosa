// A step can be set aside without unwiring it (ComfyUI's bypass and mute):
//
// - **Skipped** (`bypass`): the step does not run, and what reaches it passes
//   straight on: its first input of the kind it would have made goes to
//   every step it fed. A step with no such input is switched off instead.
// - **Off** (`mute`): the step does not run, and neither does anything that
//   only it fed.
//
// Both are resolved into an ordinary graph before a run, so the engine, the
// cache, the price and the validator only ever see steps that run.

import { outputKindOf, type Workflow, type WorkflowEdge, type WorkflowNode } from "./schema";

export type NodeMode = NonNullable<WorkflowNode["mode"]>;

/** The graph a run executes: skipped steps passed through, switched-off
 * steps and what only they fed removed. Returns the same object when no step
 * is set aside. */
export function applyModes<W extends Pick<Workflow, "nodes" | "edges">>(workflow: W): W {
  if (!workflow.nodes.some((node) => node.mode)) return workflow;
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const kindContext = { nodeById, edges: workflow.edges };
  let edges: WorkflowEdge[] = [...workflow.edges];
  const removed = new Set<string>();

  // Skipped steps, upstream first, so a chain of them resolves to the first
  // step that really runs.
  for (const node of workflow.nodes) {
    if (node.mode !== "bypass") continue;
    const made = outputKindOf(node, kindContext);
    const passing = edges.find((edge) => {
      if (edge.target !== node.id) return false;
      const source = nodeById.get(edge.source);
      if (!source || removed.has(source.id)) return false;
      const kind = outputKindOf(source, kindContext);
      return kind === made || (made === "text" && kind !== "none");
    });
    removed.add(node.id);
    if (!passing) continue;
    edges = edges.map((edge) =>
      edge.source === node.id ? { ...edge, source: passing.source } : edge,
    );
  }
  for (const node of workflow.nodes) {
    if (node.mode === "mute" || (node.mode === "bypass" && removed.has(node.id))) {
      removed.add(node.id);
    }
  }
  edges = edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target));

  // A switched-off step takes down what only it fed (a skipped one passed its
  // input on, so its consumers keep a source unless it had none).
  const fedBy = new Map<string, Set<string>>();
  for (const edge of workflow.edges) {
    const set = fedBy.get(edge.target) ?? new Set<string>();
    set.add(edge.source);
    fedBy.set(edge.target, set);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of workflow.nodes) {
      if (removed.has(node.id)) continue;
      const parents = fedBy.get(node.id);
      if (!parents || parents.size === 0) continue;
      const alive = edges.some((edge) => edge.target === node.id);
      if (!alive && [...parents].every((parent) => removed.has(parent))) {
        removed.add(node.id);
        edges = edges.filter((edge) => edge.source !== node.id && edge.target !== node.id);
        changed = true;
      }
    }
  }
  return {
    ...workflow,
    nodes: workflow.nodes.filter((node) => !removed.has(node.id)),
    edges,
  };
}
