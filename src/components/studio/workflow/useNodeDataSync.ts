// Keeping what each step shows in step with the graph and the run, without
// disturbing where the steps stand: results, prices, problems, what the
// cache will answer, the connection lists and the gate candidates.

import type { Edge as FlowEdge } from "@xyflow/react";
import { type Dispatch, type SetStateAction, useEffect } from "react";
import { artifactSrc } from "../../../lib/studio/artifacts";
import type { MediaCatalog } from "../../../lib/studio/types";
import {
  chainOrderSuggestion,
  edgesOnPort,
  maybeNodeSchema,
  type NodeCostEstimate,
  type NodeRunResult,
  openInputPorts,
  textSourceLabels,
  type ValidationIssue,
  type WorkflowBlock,
  type WorkflowNode,
} from "../../../lib/studio/workflow";
import { blockStepLabel } from "../../../lib/studio/workflow/blocks";
import {
  type ArtifactIndex,
  type PortSourceEntry,
  type StudioFlowNode,
  toWorkflowEdge,
} from "./flow";

export function useNodeDataSync(options: {
  setFlowNodes: Dispatch<SetStateAction<StudioFlowNode[]>>;
  flowEdges: FlowEdge[];
  results: ReadonlyMap<string, NodeRunResult>;
  reusedShown: ReadonlySet<string>;
  issuesByNode: ReadonlyMap<string, ValidationIssue[]>;
  priceByNode: ReadonlyMap<string, NodeCostEstimate>;
  hoverRun: boolean;
  catalog: MediaCatalog;
  artifacts: ArtifactIndex;
  constraintEpoch: number;
  blocks: WorkflowBlock[] | undefined;
  onRunStep: (nodeId: string) => void;
  onModeChange: (nodeId: string, mode: WorkflowNode["mode"]) => void;
  onLayoutChange: (
    nodeId: string,
    change: Partial<Pick<WorkflowNode, "collapsed" | "pinned" | "color">>,
  ) => void;
  onReorderEdge: (edgeId: string, delta: -1 | 1) => void;
  onHighlightEdge: (edgeId: string | undefined) => void;
  onApplyChainOrder: (nodeId: string, orderedEdgeIds: string[]) => void;
  onUngroup: (nodeId: string) => void;
  onOpenBlock: (nodeId: string) => void;
}) {
  const {
    setFlowNodes,
    flowEdges,
    results,
    reusedShown,
    issuesByNode,
    priceByNode,
    hoverRun,
    catalog,
    artifacts,
    constraintEpoch,
    blocks,
    onRunStep,
    onModeChange,
    onLayoutChange,
    onReorderEdge,
    onHighlightEdge,
    onApplyChainOrder,
    onUngroup,
    onOpenBlock,
  } = options;
  // Keep node data in sync with run results without disturbing positions.
  // Connection-order lists, gate candidates, and the assemble node's chain
  // suggestion refresh here too, so they always describe the wiring as it is.
  useEffect(() => {
    setFlowNodes((nodes) => {
      const graph = {
        nodes: nodes.map((node) => node.data.wfNode),
        edges: flowEdges.map(toWorkflowEdge),
      };
      // A block step goes by its block's name until it has its own.
      const labelOf = new Map(
        nodes.map((node) => [node.id, blockStepLabel(node.data.wfNode, blocks)]),
      );
      const imageOf = (nodeId: string): string | undefined => {
        const output = results.get(nodeId)?.output;
        if (output?.kind === "image") return `data:${output.mimeType};base64,${output.base64}`;
        // Before any run, an asset node already knows what it points at, and
        // a reference list of thumbnails is the only version of it that can be
        // read at a glance. The asset protocol streams the file, so this costs
        // nothing (the canvas is desktop-only; see `useArtifactPreview` for
        // why iOS answers differently).
        const source = nodes.find((entry) => entry.id === nodeId)?.data.wfNode;
        if (source?.type !== "asset") return undefined;
        const artifactId = source.params.artifactId;
        const artifact =
          typeof artifactId === "string" ? artifacts.byId.get(artifactId) : undefined;
        return artifact?.kind === "image" ? artifactSrc(artifact) : undefined;
      };
      const artifactOf = (nodeId: string): string | undefined => {
        const source = nodes.find((entry) => entry.id === nodeId)?.data.wfNode;
        const artifactId = source?.type === "asset" ? source.params.artifactId : undefined;
        return typeof artifactId === "string" ? artifactId : undefined;
      };
      return nodes.map((node) => {
        const wfNode = node.data.wfNode;
        const schema = maybeNodeSchema(wfNode.type);
        let portSources: Record<string, PortSourceEntry[]> | undefined;
        for (const port of schema ? openInputPorts(schema, wfNode.params) : []) {
          if (!port.multi) continue;
          const portEdges = edgesOnPort(graph, node.id, port.id);
          if (portEdges.length < 2) continue;
          portSources ??= {};
          portSources[port.id] = portEdges.map((edge) => ({
            edgeId: edge.id,
            sourceId: edge.source,
            label: labelOf.get(edge.source) ?? edge.source,
            image: imageOf(edge.source),
            artifactId: artifactOf(edge.source),
          }));
        }
        return {
          ...node,
          data: {
            ...node.data,
            result: results.get(node.id),
            catalog,
            artifacts,
            constraintEpoch,
            onReorderEdge,
            onHighlightEdge,
            onApplyChainOrder,
            portSources,
            textSources: textSourceLabels(graph, node.id),
            chainSuggestion:
              wfNode.type === "assemble" ? chainOrderSuggestion(graph, node.id) : undefined,
            willReuse: reusedShown.has(node.id),
            blocks: wfNode.type === "block" ? blocks : undefined,
            onUngroup,
            onOpenBlock,
            issues: issuesByNode.get(node.id),
            price: priceByNode.get(node.id),
            willPay: (() => {
              const price = priceByNode.get(node.id);
              return hoverRun && price !== undefined && price.kind !== "free" && !price.reused;
            })(),
            onRunStep,
            onModeChange,
            onLayoutChange,
            gateSources:
              wfNode.type === "gate"
                ? edgesOnPort(graph, node.id, "in").map((edge) => ({
                    id: edge.source,
                    label: labelOf.get(edge.source) ?? "",
                  }))
                : undefined,
            preview:
              wfNode.type === "preview"
                ? (() => {
                    const sourceId = edgesOnPort(graph, node.id, "in")[0]?.source;
                    const source = graph.nodes.find((entry) => entry.id === sourceId);
                    const result = sourceId ? results.get(sourceId) : undefined;
                    return source && result ? { node: source, result } : undefined;
                  })()
                : undefined,
            zoneSource:
              wfNode.type === "zoneEdit"
                ? imageOf(edgesOnPort(graph, node.id, "image")[0]?.source ?? "")
                : undefined,
            // A comparison shows what reaches it, as soon as it exists.
            compare:
              wfNode.type === "compare"
                ? {
                    before: imageOf(edgesOnPort(graph, node.id, "before")[0]?.source ?? ""),
                    after: imageOf(edgesOnPort(graph, node.id, "after")[0]?.source ?? ""),
                  }
                : undefined,
          },
        };
      });
    });
  }, [
    setFlowNodes,
    blocks,
    onUngroup,
    onOpenBlock,
    results,
    reusedShown,
    issuesByNode,
    priceByNode,
    hoverRun,
    onRunStep,
    onModeChange,
    onLayoutChange,
    catalog,
    artifacts,
    constraintEpoch,
    flowEdges,
    onReorderEdge,
    onHighlightEdge,
    onApplyChainOrder,
  ]);
}
