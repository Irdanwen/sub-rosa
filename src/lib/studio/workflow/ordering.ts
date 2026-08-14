// Connection order on multi ports, as data. The order of a multi port's
// inputs IS the order of its edges in the workflow's edge array — the engine
// has always consumed them that way (assemble's cut list, a video node's
// reference_image_urls, an image edit's sources, a gate's candidates). These
// helpers make that order inspectable and editable without the engine
// changing by a line: reordering is reordering the array.

import {
  closedInputPort,
  isPortOpen,
  maybeNodeSchema,
  nodeLabel,
  openInputPorts,
  outputKindOf,
  resolveInputPort,
  type InputPort,
  type Workflow,
  type WorkflowEdge,
} from "./schema";

type Graph = Pick<Workflow, "nodes" | "edges">;

function contextOf(workflow: Graph) {
  return {
    nodeById: new Map(workflow.nodes.map((node) => [node.id, node])),
    edges: workflow.edges,
  };
}

/** The edges landing on one port of a node, in connection order — explicit
 * `targetPort` and kind-affinity edges alike, exactly as the engine buckets
 * them. */
export function edgesOnPort(workflow: Graph, targetId: string, portId: string): WorkflowEdge[] {
  const context = contextOf(workflow);
  const target = context.nodeById.get(targetId);
  if (!target || !maybeNodeSchema(target.type)) return [];
  return workflow.edges.filter((edge) => {
    if (edge.target !== targetId) return false;
    const source = context.nodeById.get(edge.source);
    if (!source) return false;
    return resolveInputPort(target, edge, outputKindOf(source, context))?.id === portId;
  });
}

/**
 * The nodes feeding this node's text input, named.
 *
 * What an editor needs before offering to write `{{input}}`: the marker only
 * means something when something upstream is actually talking to the node, and
 * naming the source is what turns an opaque token into a sentence the user can
 * check. Empty when the node has no text input, or nothing is wired to it.
 */
export function textSourceLabels(workflow: Graph, nodeId: string): string[] {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  const schema = node ? maybeNodeSchema(node.type) : undefined;
  if (!node || !schema) return [];
  const port = openInputPorts(schema, node.params).find((candidate) => candidate.kind === "text");
  if (!port) return [];
  const byId = new Map(workflow.nodes.map((entry) => [entry.id, entry]));
  return edgesOnPort(workflow, nodeId, port.id).flatMap((edge) => {
    const source = byId.get(edge.source);
    return source ? [nodeLabel(source)] : [];
  });
}

/** A connection whose port the target node's model has closed. */
export interface StrandedEdge {
  edge: WorkflowEdge;
  /** The closed port it was landing on, for naming it to the user. */
  port: InputPort;
  /** The node it came from, likewise. */
  sourceId: string;
}

/**
 * Connections with nowhere to land because the target's model closed the port.
 *
 * Two moments need this: picking a model that drops an input the node used to
 * carry, and *opening* a workflow saved before that model was understood - an
 * edge pinned to a handle the node no longer draws renders as a dangling wire.
 * Both let the connection go rather than leave it, and say so.
 *
 * An edge naming a port the node type does not have **at all** is deliberately
 * not one of these: that is stale data, and silently deleting it would repair
 * a bug out of sight instead of letting the validator report it.
 */
export function strandedEdges(workflow: Graph): StrandedEdge[] {
  const context = contextOf(workflow);
  const stranded: StrandedEdge[] = [];
  for (const edge of workflow.edges) {
    const target = context.nodeById.get(edge.target);
    const source = context.nodeById.get(edge.source);
    const schema = target ? maybeNodeSchema(target.type) : undefined;
    if (!target || !source || !schema) continue;
    const kind = outputKindOf(source, context);
    if (resolveInputPort(target, edge, kind)) continue;
    // Which closed port to name: the one the edge points at, or - for a
    // portless edge - the port its kind used to take.
    const port =
      edge.targetPort !== undefined
        ? closedInputPort(schema, target.params, edge.targetPort)
        : schema.inputs.find(
            (candidate) => candidate.kind === kind && !isPortOpen(candidate, target.params),
          );
    if (port) stranded.push({ edge, port, sourceId: edge.source });
  }
  return stranded;
}

/**
 * Move one connection up (-1) or down (+1) within its port's order.
 *
 * The move swaps the edge with its port neighbor *in the global array*, so
 * every other port's order — and everything else about the graph — is
 * untouched. Returns the same array reference when the move is impossible
 * (edge unknown, already at the boundary).
 */
export function reorderPortEdge(workflow: Graph, edgeId: string, delta: -1 | 1): WorkflowEdge[] {
  const edge = workflow.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) return workflow.edges;
  const context = contextOf(workflow);
  const target = context.nodeById.get(edge.target);
  const source = context.nodeById.get(edge.source);
  if (!target || !source) return workflow.edges;
  const port = resolveInputPort(target, edge, outputKindOf(source, context));
  if (!port) return workflow.edges;

  const portEdges = edgesOnPort(workflow, edge.target, port.id);
  const position = portEdges.findIndex((candidate) => candidate.id === edgeId);
  const neighbor = portEdges[position + delta];
  if (!neighbor) return workflow.edges;

  const edges = [...workflow.edges];
  const from = edges.findIndex((candidate) => candidate.id === edgeId);
  const to = edges.findIndex((candidate) => candidate.id === neighbor.id);
  [edges[from], edges[to]] = [edges[to], edges[from]];
  return edges;
}

/** Rewrite one port's connections into `orderedIds` order, leaving every
 * other edge exactly where it is: the reordered edges land back into the
 * array positions the port's edges already occupied. */
export function applyPortOrder(edges: WorkflowEdge[], orderedIds: string[]): WorkflowEdge[] {
  const byId = new Map(edges.map((edge) => [edge.id, edge]));
  const moving = new Set(orderedIds.filter((id) => byId.has(id)));
  const queue = orderedIds.filter((id) => byId.has(id));
  return edges.map((edge) => {
    if (!moving.has(edge.id)) return edge;
    const nextId = queue.shift();
    // `queue` and the positions being rewritten have the same length by
    // construction; this is a type guard, not a reachable branch.
    return nextId ? (byId.get(nextId) ?? edge) : edge;
  });
}

/**
 * For an assemble node: the clip connections reordered to follow the graph's
 * own chains — B continues A when B's opening frame is a frame taken out of
 * A (video → lastFrame → video). Returns the edge ids in chain order, or
 * undefined when there is nothing to suggest: fewer than two clips, clips
 * that do not form one single chain, or an order that already matches.
 * Deliberately all-or-nothing — a half-derived order would look authoritative
 * while being a guess.
 */
export function chainOrderSuggestion(workflow: Graph, assembleId: string): string[] | undefined {
  const clips = edgesOnPort(workflow, assembleId, "clips");
  if (clips.length < 2) return undefined;
  const context = contextOf(workflow);

  /** The clip-source node this clip-source node continues, if any. */
  const continuesOf = (sourceId: string): string | undefined => {
    const opening = workflow.edges.find((edge) => {
      if (edge.target !== sourceId) return false;
      const target = context.nodeById.get(edge.target);
      const source = context.nodeById.get(edge.source);
      if (!target || !source) return false;
      return resolveInputPort(target, edge, outputKindOf(source, context))?.id === "openingFrame";
    });
    const frameNode = opening ? context.nodeById.get(opening.source) : undefined;
    if (frameNode?.type !== "lastFrame") return undefined;
    return edgesOnPort(workflow, frameNode.id, "video")[0]?.source;
  };

  const sources = clips.map((edge) => edge.source);
  const inSet = new Set(sources);
  const parents = new Map<string, string | undefined>(
    sources.map((sourceId) => {
      const parent = continuesOf(sourceId);
      return [sourceId, parent !== undefined && inSet.has(parent) ? parent : undefined];
    }),
  );

  const roots = sources.filter((sourceId) => parents.get(sourceId) === undefined);
  if (roots.length !== 1) return undefined;
  const childOf = new Map<string, string>();
  for (const [child, parent] of parents) {
    if (parent === undefined) continue;
    // Two clips continuing the same one is a fork: no single order exists.
    if (childOf.has(parent)) return undefined;
    childOf.set(parent, child);
  }
  const ordered: string[] = [];
  for (
    let cursor: string | undefined = roots[0];
    cursor !== undefined;
    cursor = childOf.get(cursor)
  ) {
    ordered.push(cursor);
  }
  if (ordered.length !== sources.length) return undefined;

  const edgeBySource = new Map(clips.map((edge) => [edge.source, edge.id]));
  const suggestion = ordered.map((sourceId) => edgeBySource.get(sourceId) ?? "");
  if (suggestion.some((id) => id === "")) return undefined;
  const current = clips.map((edge) => edge.id);
  return suggestion.every((id, index) => id === current[index]) ? undefined : suggestion;
}
