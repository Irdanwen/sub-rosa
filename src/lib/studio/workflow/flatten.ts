// A workflow with blocks, as the engine runs it: every block step replaced
// by its block's steps, wired where the block was (ADR-0116). The engine,
// the validator, the prices, the step cache and the run's frozen graph all
// read this flat graph; the canvas keeps the written one, and the display
// table lifts what happened to a flat step back onto the block step it came
// from.
//
// A flat step's id is its path: `instance/inner`, and `outer/inner/step`
// for a block inside a block. Ids are not part of a step's signature
// (signature.ts), so a step reused before it was put in a block is reused
// after.

import { t } from "../../i18n";
import { blockOf, instanceParams, MAX_BLOCK_DEPTH, settingsOf } from "./blocks";
import type { Workflow, WorkflowBlock, WorkflowEdge, WorkflowNode } from "./schema";
import type { ValidationIssue } from "./validator";

export interface Flattened {
  workflow: Workflow;
  /** Flat step id → the top-level block step it belongs to. */
  display: Map<string, string>;
  /** What could not be put in place, on the block step concerned. */
  issues: ValidationIssue[];
  /** Block step (by its path, `outer/inner` inside a block) → the flat step
   * whose result it shows: its first output. */
  primary: Map<string, string>;
}

interface Expanded {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Where an edge landing on this graph's step and port really lands. */
  target: (nodeId: string, port: string | undefined) => { node: string; port?: string } | undefined;
  /** Which flat step an edge leaving this graph's step really leaves. */
  source: (nodeId: string, port: string | undefined) => string | undefined;
}

/** The graph as the engine runs it. A graph without blocks comes back as
 * it was, the same object. */
export function flattenBlocks(workflow: Workflow): Flattened {
  if (!workflow.nodes.some((node) => node.type === "block"))
    return { workflow, display: new Map(), issues: [], primary: new Map() };
  const display = new Map<string, string>();
  const issues: ValidationIssue[] = [];
  const primary = new Map<string, string>();
  const expanded = expand(workflow.nodes, workflow.edges, workflow.blocks ?? [], "", 0, [], {
    owner: undefined,
    display,
    issues,
    primary,
  });
  const { blocks: _blocks, ...rest } = workflow;
  return {
    workflow: {
      ...rest,
      nodes: expanded.nodes,
      edges: expanded.edges,
      // What the person wrote, frozen with the run, so reopening it shows
      // the blocks rather than their steps.
      extra: {
        ...workflow.extra,
        written: { nodes: workflow.nodes, edges: workflow.edges, blocks: workflow.blocks ?? [] },
      },
    },
    display,
    issues,
    primary,
  };
}

interface Ledger {
  /** The top-level block step the steps being expanded belong to. */
  owner: string | undefined;
  display: Map<string, string>;
  issues: ValidationIssue[];
  primary: Map<string, string>;
}

function expand(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  blocks: readonly WorkflowBlock[],
  prefix: string,
  depth: number,
  stack: string[],
  record: Ledger,
): Expanded {
  const { owner, display, issues, primary } = record;
  const flatNodes: WorkflowNode[] = [];
  const innerEdges: WorkflowEdge[] = [];
  const inner = new Map<string, { block: WorkflowBlock; graph: Expanded }>();
  const plain = new Set<string>();
  for (const node of nodes) {
    const id = `${prefix}${node.id}`;
    if (node.type !== "block") {
      plain.add(node.id);
      flatNodes.push({ ...node, id });
      if (owner) display.set(id, owner);
      continue;
    }
    const block = blockOf(node, blocks);
    if (!block) {
      issues.push({
        severity: "error",
        nodeId: id,
        code: "blockMissing",
        message: t(
          "This block's steps are missing. Remove it, or paste it again from where it was copied.",
        ),
      });
      continue;
    }
    if (depth >= MAX_BLOCK_DEPTH || stack.includes(block.id)) {
      issues.push({
        severity: "error",
        nodeId: id,
        code: "blockLoop",
        message: t("{block} sits inside itself, or too many blocks deep.", { block: block.name }),
      });
      continue;
    }
    const settings = settingsOf(node);
    const steps = block.nodes.map((entry) => {
      // A block set aside sets aside what is in it.
      return {
        ...entry,
        params: instanceParams(block, entry, settings),
        ...(node.mode && !entry.mode ? { mode: node.mode } : {}),
      };
    });
    const graph = expand(steps, block.edges, blocks, `${id}/`, depth + 1, [...stack, block.id], {
      ...record,
      owner: owner ?? id,
    });
    inner.set(node.id, { block, graph });
    const first = block.outputs[0];
    const shown = first ? graph.source(first.nodeId, first.port) : undefined;
    if (shown) primary.set(id, shown);
    flatNodes.push(...graph.nodes);
    innerEdges.push(...graph.edges);
  }

  const target: Expanded["target"] = (nodeId, port) => {
    if (plain.has(nodeId)) return { node: `${prefix}${nodeId}`, ...(port ? { port } : {}) };
    const found = inner.get(nodeId);
    const input = found?.block.inputs.find((entry) => entry.id === port);
    return found && input ? found.graph.target(input.nodeId, input.port) : undefined;
  };
  const source: Expanded["source"] = (nodeId, port) => {
    if (plain.has(nodeId)) return `${prefix}${nodeId}`;
    const found = inner.get(nodeId);
    const output =
      found?.block.outputs.find((entry) => entry.id === port) ?? found?.block.outputs[0];
    return found && output ? found.graph.source(output.nodeId, output.port) : undefined;
  };

  const flatEdges: WorkflowEdge[] = [];
  for (const edge of edges) {
    const from = source(edge.source, edge.sourcePort);
    const to = target(edge.target, edge.targetPort);
    if (!from || !to) {
      // Only a block's missing inside can lose a wire here; one between two
      // plain steps always resolves.
      const block = inner.has(edge.target) ? edge.target : edge.source;
      if (inner.has(edge.source) || inner.has(edge.target))
        issues.push({
          severity: "error",
          nodeId: `${prefix}${block}`,
          code: "blockPort",
          message: t("A connection to this block reaches no step inside it."),
        });
      continue;
    }
    flatEdges.push({
      id: `${prefix}${edge.id}`,
      source: from,
      target: to.node,
      ...(to.port !== undefined ? { targetPort: to.port } : {}),
    });
  }
  return { nodes: flatNodes, edges: [...flatEdges, ...innerEdges], target, source };
}

/** The written graph a run froze with its flat one (see `flattenBlocks`). */
export function writtenGraph(
  definition: Workflow,
): Pick<Workflow, "nodes" | "edges" | "blocks"> | undefined {
  const written = definition.extra?.written as
    | Pick<Workflow, "nodes" | "edges" | "blocks">
    | undefined;
  return written && Array.isArray(written.nodes) && Array.isArray(written.edges)
    ? written
    : undefined;
}
