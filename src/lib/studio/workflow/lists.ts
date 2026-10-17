// Lists (ComfyUI's lists, ADR-0117): a step that holds several items, and
// what it feeds run once per item. Like blocks, lists are put in place
// before anything is validated, priced, looked up in the step cache or run:
// each item becomes a step of its own (`list#0`, `list#1`...), a step fed a
// list on an input that takes one thing is copied once per item
// (`step#0`...), and an input that gathers (an assembly's clips, a shot's
// references, a template's values) receives every item, in order. A split text is cut
// during the run, so it is put in place at the most lines it declares, and
// a line that does not arrive is not made, nor anything that needed it.

import {
  defaultParams,
  MAX_LIST_ITEMS,
  outputKindOf,
  resolveInputPort,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
} from "./schema";

/** Steps that hold several items. */
const LIST_STEPS = new Set<WorkflowNode["type"]>(["textList", "imageList", "splitText"]);

/** The step a list item or a copy came from (`step#2` → `step`). */
export function listBase(id: string): string {
  const at = id.indexOf("#");
  return at < 0 ? id : id.slice(0, at);
}

/** A text list's items: its non-empty lines, as many as a list may hold. */
export function textItems(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
}

/** A picture list's gallery items, as many as a list may hold. */
export function pictureItems(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((id): id is string => typeof id === "string" && id !== "")
        .slice(0, MAX_LIST_ITEMS)
    : [];
}

/** How many lines a split text is priced and put in place for. */
export function splitMax(params: Record<string, unknown>): number {
  const value = Math.round(Number(params.max));
  return Number.isFinite(value) ? Math.min(MAX_LIST_ITEMS, Math.max(1, value)) : 5;
}

function topological(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const waiting = new Map(nodes.map((node) => [node.id, 0]));
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    if (!waiting.has(edge.source) || !waiting.has(edge.target)) continue;
    waiting.set(edge.target, (waiting.get(edge.target) ?? 0) + 1);
    out.set(edge.source, [...(out.get(edge.source) ?? []), edge.target]);
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const queue = nodes.filter((node) => waiting.get(node.id) === 0).map((node) => node.id);
  const order: WorkflowNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(byId.get(id) as WorkflowNode);
    for (const next of out.get(id) ?? []) {
      const left = (waiting.get(next) ?? 1) - 1;
      waiting.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  // A cycle is the validator's to report: leave what it holds as it was.
  return order.length === nodes.length ? order : nodes;
}

/** The graph with its lists put in place. A graph without lists comes back
 * as it was, the same object. */
export function expandLists<W extends Pick<Workflow, "nodes" | "edges">>(workflow: W): W {
  if (!workflow.nodes.some((node) => LIST_STEPS.has(node.type))) return workflow;
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const kindContext = { nodeById: byId, edges: workflow.edges };
  const into = new Map<string, WorkflowEdge[]>();
  for (const edge of workflow.edges)
    into.set(edge.target, [...(into.get(edge.target) ?? []), edge]);
  /** The steps that stand for a list, by the step that made it. */
  const listOf = new Map<string, string[]>();
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  const item = (
    from: WorkflowNode,
    index: number,
    type: WorkflowNode["type"],
    params: Record<string, unknown>,
  ) =>
    ({
      id: `${from.id}#${index}`,
      type,
      label: from.label,
      position: from.position,
      params: { ...defaultParams(type), ...params },
      ...(from.mode ? { mode: from.mode } : {}),
    }) as WorkflowNode;

  for (const node of topological(workflow.nodes, workflow.edges)) {
    if (node.type === "textList") {
      const items = textItems(node.params.items).map((text, index) =>
        item(node, index, "textInput", { text }),
      );
      nodes.push(...items);
      listOf.set(
        node.id,
        items.map((entry) => entry.id),
      );
      continue;
    }
    if (node.type === "imageList") {
      const items = pictureItems(node.params.artifactIds).map((artifactId, index) =>
        item(node, index, "asset", { assetKind: "image", artifactId }),
      );
      nodes.push(...items);
      listOf.set(
        node.id,
        items.map((entry) => entry.id),
      );
      continue;
    }
    const incoming = into.get(node.id) ?? [];
    const portOf = (edge: WorkflowEdge) => {
      const source = byId.get(edge.source);
      return resolveInputPort(node, edge, source ? outputKindOf(source, kindContext) : "text");
    };
    // A list on an input that gathers gives the step every item; on any
    // other, the step is copied per item.
    const copying = incoming.filter((edge) => listOf.has(edge.source) && !portOf(edge)?.gathers);
    const count =
      copying.length === 0
        ? 1
        : Math.max(...copying.map((edge) => listOf.get(edge.source)?.length ?? 0));
    if (count === 0) {
      // Fed an empty list: nothing to run it on.
      listOf.set(node.id, []);
      continue;
    }
    const copies =
      copying.length === 0
        ? [node.id]
        : Array.from({ length: count }, (_, index) => `${node.id}#${index}`);
    for (const [index, id] of copies.entries()) {
      nodes.push({ ...node, id });
      const suffix = copies.length > 1 ? `#${index}` : "";
      for (const edge of incoming) {
        const items = listOf.get(edge.source);
        if (!items) {
          edges.push({ ...edge, id: `${edge.id}${suffix}`, target: id });
          continue;
        }
        if (portOf(edge)?.gathers) {
          for (const [at, source] of items.entries())
            edges.push({ ...edge, id: `${edge.id}${suffix}~${at}`, source, target: id });
        } else if (items.length > 0) {
          // A shorter list repeats its last item, as ComfyUI does.
          const source = items[Math.min(index, items.length - 1)];
          edges.push({ ...edge, id: `${edge.id}${suffix}`, source, target: id });
        }
      }
    }
    if (copying.length > 0) listOf.set(node.id, copies);
    if (node.type === "splitText" && copies.length === 1) {
      // Its lines, at the most it declares; one that does not arrive is
      // not made (execute-node.ts `listItem`).
      const lines = Array.from({ length: splitMax(node.params) }, (_, index) =>
        item(node, index, "listItem", { index }),
      );
      nodes.push(...lines);
      for (const line of lines)
        edges.push({ id: `${line.id}<`, source: node.id, target: line.id, targetPort: "text" });
      listOf.set(
        node.id,
        lines.map((entry) => entry.id),
      );
    }
  }
  return { ...workflow, nodes, edges };
}

/** Whether a graph holds a list step at all. */
export function hasLists(workflow: Pick<Workflow, "nodes">): boolean {
  return workflow.nodes.some((node) => LIST_STEPS.has(node.type));
}
