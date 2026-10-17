// A switch (ComfyUI's lazy switch): passes on one of two inputs. Set by a
// setting, it is resolved before the run like a step switched off, so the
// other side is neither priced nor made (modes.ts). Decided by a condition
// that arrives during the run, the scheduler starts neither side until the
// condition is known, then only the chosen one (engine.ts `runReady`), and
// the price counts the dearer side, since either may run (cost.ts).

import type { Workflow, WorkflowEdge, WorkflowNode } from "./schema";

/** A switch whose choice is made by its condition input during the run. */
export function isDecidedLive(
  node: Pick<WorkflowNode, "id" | "type">,
  edges: readonly WorkflowEdge[],
): boolean {
  return (
    node.type === "switch" &&
    edges.some((edge) => edge.target === node.id && edge.targetPort === "when")
  );
}

/** Which side a condition picks: A when it says the words the switch waits
 * for (any case), else B. No words set: A whenever it says anything. */
export function decideSwitch(params: Record<string, unknown>, condition: string): "a" | "b" {
  const words = typeof params.contains === "string" ? params.contains.trim().toLowerCase() : "";
  const said = condition.trim().toLowerCase();
  if (!words) return said ? "a" : "b";
  return said.includes(words) ? "a" : "b";
}

/** The side a switch passes on when no condition decides it. */
export function fixedSide(params: Record<string, unknown>): "a" | "b" {
  return params.branch === "b" ? "b" : "a";
}

function ancestors(start: Iterable<string>, edges: readonly WorkflowEdge[]): Set<string> {
  const into = new Map<string, string[]>();
  for (const edge of edges) into.set(edge.target, [...(into.get(edge.target) ?? []), edge.source]);
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(into.get(id) ?? []));
  }
  return seen;
}

export interface SwitchBranches {
  switchId: string;
  /** Steps that run only if the switch takes this side. */
  a: Set<string>;
  b: Set<string>;
}

/** For each switch decided during the run, the steps only one of its sides
 * needs: what waits for its condition, and what is not made if the other
 * side is taken. A step any other part of the graph needs is in neither. */
export function liveSwitchBranches(workflow: Pick<Workflow, "nodes" | "edges">): SwitchBranches[] {
  const live = workflow.nodes.filter((node) => isDecidedLive(node, workflow.edges));
  if (live.length === 0) return [];
  const feeds = new Set(workflow.edges.map((edge) => edge.source));
  const ends = workflow.nodes.filter((node) => !feeds.has(node.id)).map((node) => node.id);
  return live.map((node) => {
    const side = (port: "a" | "b") =>
      workflow.edges
        .filter((edge) => edge.target === node.id && edge.targetPort === port)
        .map((edge) => edge.source);
    // Everything still needed once the switch's two sides are taken away.
    const without = workflow.edges.filter(
      (edge) => !(edge.target === node.id && (edge.targetPort === "a" || edge.targetPort === "b")),
    );
    const needed = ancestors([...ends, node.id], without);
    const a = ancestors(side("a"), workflow.edges);
    const b = ancestors(side("b"), workflow.edges);
    const only = (mine: Set<string>, theirs: Set<string>) =>
      new Set([...mine].filter((id) => !needed.has(id) && !theirs.has(id)));
    return { switchId: node.id, a: only(a, b), b: only(b, a) };
  });
}
