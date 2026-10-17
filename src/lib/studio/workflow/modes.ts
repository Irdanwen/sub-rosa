// A step can be set aside without unwiring it (ComfyUI's bypass and mute):
//
// - **Skipped** (`bypass`): the step does not run, and what reaches it passes
//   straight on: its first input of the kind it would have made goes to
//   every step it fed. A step with no such input is switched off instead.
// - **Off** (`mute`): the step does not run, and neither does anything that
//   can no longer run without it.
//
// Both are resolved into an ordinary graph before a run, so the engine, the
// cache, the price and the validator only ever see steps that run.

import { outputKindOf, type Workflow, type WorkflowEdge, type WorkflowNode } from "./schema";
import { validateWorkflow } from "./validator";

/** Steps that are there to be read or looked at, never run. */
const SHOWN_ONLY = new Set<WorkflowNode["type"]>(["note", "compare"]);

export type NodeMode = NonNullable<WorkflowNode["mode"]>;

/** The graph a run executes: skipped steps passed through, switched-off
 * steps and what can no longer run without them removed. Returns the same object when no step
 * is set aside. */
export function applyModes<W extends Pick<Workflow, "nodes" | "edges">>(workflow: W): W {
  if (
    !workflow.nodes.some((node) => node.mode || node.type === "relay" || SHOWN_ONLY.has(node.type))
  )
    return workflow;
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const kindContext = { nodeById, edges: workflow.edges };
  let edges: WorkflowEdge[] = [...workflow.edges];
  const removed = new Set<string>();

  // Skipped steps, upstream first, so a chain of them resolves to the first
  // step that really runs.
  // A relay is a step that only passes its input on: resolved like a
  // skipped one, so a run never sees it.
  for (const node of workflow.nodes) {
    if (node.mode !== "bypass" && node.type !== "relay") continue;
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
    // A note and a comparison are for the reader's eyes: they never run.
    if (node.mode === "mute" || SHOWN_ONLY.has(node.type) || removed.has(node.id)) {
      removed.add(node.id);
    }
  }
  edges = edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target));

  // A step that lost an input this way is taken down only if it can no
  // longer run without it (a required input left empty, a prompt that was
  // all it had): a shot with a prompt of its own still runs without the
  // frame that was switched off.
  const lostInput = new Set(
    workflow.edges
      .filter((edge) => removed.has(edge.source) && !removed.has(edge.target))
      .map((edge) => edge.target),
  );
  for (;;) {
    const nodes = workflow.nodes.filter((node) => !removed.has(node.id));
    const broken = validateWorkflow({ nodes, edges })
      .errors.map((issue) => issue.nodeId)
      .filter((id): id is string => id !== undefined && lostInput.has(id) && !removed.has(id));
    if (broken.length === 0) break;
    for (const id of broken) {
      removed.add(id);
      for (const edge of edges) if (edge.source === id) lostInput.add(edge.target);
    }
    edges = edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target));
  }
  return {
    ...workflow,
    nodes: workflow.nodes.filter((node) => !removed.has(node.id)),
    edges,
  };
}
