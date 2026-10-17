// Copying steps between workflows: the selected steps and the connections
// between them, as tagged JSON on the system clipboard, pasted back with new
// ids beside where they were. "Paste with connections" also keeps the
// connections that came into the copied steps from steps still on the
// canvas.

import type { Workflow, WorkflowBlock, WorkflowEdge, WorkflowNode } from "./schema";

const FORMAT = "subrosa-workflow-steps";
const VERSION = 1;
/** How far a pasted copy sits from what it copied. */
const OFFSET = 48;

export interface StepClip {
  format: typeof FORMAT;
  version: number;
  nodes: WorkflowNode[];
  /** Between copied steps. */
  edges: WorkflowEdge[];
  /** From a step that was not copied into one that was. */
  incoming: WorkflowEdge[];
  /** The blocks the copied block steps are instances of, and the blocks
   * inside those: a block step pasted elsewhere brings its steps. */
  blocks?: WorkflowBlock[];
}

/** The blocks these steps need, nested ones included. */
function blocksUsed(nodes: WorkflowNode[], blocks: readonly WorkflowBlock[]): WorkflowBlock[] {
  const used = new Map<string, WorkflowBlock>();
  const visit = (steps: WorkflowNode[]) => {
    for (const step of steps) {
      if (step.type !== "block") continue;
      const block = blocks.find((entry) => entry.id === step.params.blockId);
      if (!block || used.has(block.id)) continue;
      used.set(block.id, block);
      visit(block.nodes);
    }
  };
  visit(nodes);
  return [...used.values()];
}

export function copySteps(
  graph: Pick<Workflow, "nodes" | "edges" | "blocks">,
  ids: ReadonlySet<string>,
): string {
  const nodes = graph.nodes.filter((node) => ids.has(node.id));
  const blocks = blocksUsed(nodes, graph.blocks ?? []);
  const clip: StepClip = {
    format: FORMAT,
    version: VERSION,
    nodes,
    ...(blocks.length > 0 ? { blocks } : {}),
    edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    incoming: graph.edges.filter((edge) => !ids.has(edge.source) && ids.has(edge.target)),
  };
  return JSON.stringify(clip);
}

/** A clipboard text as copied steps, or nothing when it is something else. */
export function readClip(text: string): StepClip | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<StepClip>;
    if (parsed?.format !== FORMAT || typeof parsed.version !== "number") return undefined;
    if (parsed.version > VERSION) return undefined;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return undefined;
    return { incoming: [], ...parsed } as StepClip;
  } catch {
    return undefined;
  }
}

/** The pasted steps with fresh ids, offset from their originals, and the
 * connections to add. */
export function pasteSteps(
  clip: StepClip,
  existing: ReadonlySet<string>,
  withConnections: boolean,
  newId: () => string = () => crypto.randomUUID(),
): { nodes: WorkflowNode[]; edges: WorkflowEdge[]; blocks?: WorkflowBlock[] } {
  const ids = new Map(clip.nodes.map((node) => [node.id, newId()]));
  const nodes = clip.nodes.map((node) => ({
    ...node,
    id: ids.get(node.id) as string,
    position: { x: node.position.x + OFFSET, y: node.position.y + OFFSET },
    params: { ...node.params },
  }));
  const edges = clip.edges.map((edge) => ({
    ...edge,
    id: newId(),
    source: ids.get(edge.source) as string,
    target: ids.get(edge.target) as string,
  }));
  if (withConnections) {
    for (const edge of clip.incoming) {
      if (!existing.has(edge.source)) continue;
      edges.push({ ...edge, id: newId(), target: ids.get(edge.target) as string });
    }
  }
  return { nodes, edges, ...(clip.blocks?.length ? { blocks: clip.blocks } : {}) };
}
