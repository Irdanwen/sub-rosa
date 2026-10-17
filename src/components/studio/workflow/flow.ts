// The seam between a stored Workflow and React Flow's nodes and edges: the
// data each canvas node carries, and the conversions both ways.

import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import type { useArtifactIndex } from "../../../lib/artifact-media";
import type { MediaCatalog } from "../../../lib/studio/types";
import {
  nodeLabel,
  outputKindOf,
  resolveInputPort,
  type NodeRunResult,
  type StrandedEdge,
  type Workflow,
  type WorkflowNode,
} from "../../../lib/studio/workflow";

/** One connection into a multi port, as the ordering list shows it. */
export interface PortSourceEntry {
  edgeId: string;
  sourceId: string;
  label: string;
  /** A small preview when the source has produced an image this run. */
  image?: string;
  /** The gallery artifact a source asset node holds. */
  artifactId?: string;
}

/** The editor's one gallery listing, shared by every node that shows an
 * asset (see `useArtifactIndex`). */
export type ArtifactIndex = ReturnType<typeof useArtifactIndex>;

export interface StudioNodeData extends Record<string, unknown> {
  wfNode: WorkflowNode;
  catalog: MediaCatalog;
  artifacts: ArtifactIndex;
  /** Bumped when a failed render taught us what a model accepts, so the
   * option lists under it re-derive. */
  constraintEpoch: number;
  result?: NodeRunResult;
  onParamsChange: (id: string, params: Record<string, unknown>) => void;
  /** Rename this node, so several of one type can be told apart. */
  onRename: (id: string, label: string) => void;
  onRemove: (id: string) => void;
  /** Gate nodes only: the upstream candidates an approval can pick from. */
  gateSources?: Array<{ id: string; label: string }>;
  /** Gate nodes only: decide this gate and continue the held production. */
  onApproveGate?: (gateId: string, choice: string | undefined) => void;
  /** Multi ports with two or more connections: their sources, in order. */
  portSources?: Record<string, PortSourceEntry[]>;
  /** The nodes feeding this node's text input, named. */
  textSources?: string[];
  /** Move one connection up or down within its port's order. */
  onReorderEdge?: (edgeId: string, delta: -1 | 1) => void;
  /** Light up one connection on the canvas (hovering its list entry). */
  onHighlightEdge?: (edgeId: string | undefined) => void;
  /** Assemble nodes only: apply the graph's chain order to the clips port. */
  chainSuggestion?: string[];
  onApplyChainOrder?: (nodeId: string, orderedEdgeIds: string[]) => void;
}

export type StudioFlowNode = FlowNode<StudioNodeData, "studio">;

export const SAVE_DEBOUNCE_MS = 300;

export function toFlowNodes(
  workflow: Workflow,
  catalog: MediaCatalog,
  artifacts: ArtifactIndex,
  results: Map<string, NodeRunResult>,
  onParamsChange: (id: string, params: Record<string, unknown>) => void,
  onRename: (id: string, label: string) => void,
  onRemove: (id: string) => void,
  onApproveGate?: (gateId: string, choice: string | undefined) => void,
): StudioFlowNode[] {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  return workflow.nodes.map((node) => ({
    id: node.id,
    type: "studio" as const,
    position: node.position,
    data: {
      wfNode: node,
      catalog,
      artifacts,
      // Nothing has been learned yet on a freshly opened workflow; the sync
      // effect hands the live epoch down from there.
      constraintEpoch: 0,
      result: results.get(node.id),
      onParamsChange,
      onRename,
      onRemove,
      onApproveGate,
      gateSources:
        node.type === "gate"
          ? workflow.edges
              .filter((edge) => edge.target === node.id)
              .map((edge) => nodeById.get(edge.source))
              .filter((source): source is WorkflowNode => source !== undefined)
              .map((source) => ({ id: source.id, label: nodeLabel(source) }))
          : undefined,
    },
  }));
}

/** Edges land on named handles. Portless edges (saved before ports existed)
 * are displayed on the port they actually resolve to, so what the canvas
 * shows is what the engine will do; the next save makes it explicit. */
export function toFlowEdges(workflow: Workflow): FlowEdge[] {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const kindContext = { nodeById, edges: workflow.edges };
  return workflow.edges.map((edge) => {
    let port = edge.targetPort;
    if (port === undefined) {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      if (source && target) {
        port = resolveInputPort(target, edge, outputKindOf(source, kindContext))?.id;
      }
    }
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      targetHandle: port,
      animated: true,
    };
  });
}

export function toWorkflowEdge(edge: FlowEdge) {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    targetPort: edge.targetHandle ?? undefined,
  };
}

export function fromFlow(base: Workflow, nodes: StudioFlowNode[], edges: FlowEdge[]): Workflow {
  return {
    ...base,
    nodes: nodes.map((node) => ({
      ...node.data.wfNode,
      position: { x: node.position.x, y: node.position.y },
    })),
    edges: edges.map(toWorkflowEdge),
  };
}

export function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

/** The closed inputs behind a set of dropped connections, named once each. */
export function strandedPorts(stranded: StrandedEdge[]): string {
  const labels = [...new Set(stranded.map((entry) => entry.port.label.toLowerCase()))];
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}` : labels[0];
}

/** What was let go, named when there is one of it and counted when there are
 * several - a list of five node names in a one-line notice reads as noise. */
export function strandedWhat(stranded: StrandedEdge[], nodes: StudioFlowNode[]): string {
  if (stranded.length > 1) return `${stranded.length} connections were`;
  const source = nodes.find((node) => node.id === stranded[0].sourceId)?.data.wfNode;
  return `the connection from "${source ? nodeLabel(source) : "an upstream node"}" was`;
}
