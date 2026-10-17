// Running part of a workflow: the steps asked for and everything they need,
// nothing else (ComfyUI's partial execution targets). The pruned graph is
// what a run freezes as its definition (ADR-0021), so a resume never runs
// the steps that were left out; what is upstream and unchanged comes back
// from the step cache (ADR-0115) instead of being bought again.

import type { Workflow } from "./schema";

/** The targets, their ancestors, and the edges between them. */
export function pruneToTargets<W extends Pick<Workflow, "nodes" | "edges">>(
  workflow: W,
  targets: readonly string[],
): W {
  const keep = new Set<string>();
  const parentsOf = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    const list = parentsOf.get(edge.target) ?? [];
    list.push(edge.source);
    parentsOf.set(edge.target, list);
  }
  const stack = targets.filter((id) => workflow.nodes.some((node) => node.id === id));
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (keep.has(id)) continue;
    keep.add(id);
    stack.push(...(parentsOf.get(id) ?? []));
  }
  return {
    ...workflow,
    nodes: workflow.nodes.filter((node) => keep.has(node.id)),
    edges: workflow.edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target)),
  };
}
