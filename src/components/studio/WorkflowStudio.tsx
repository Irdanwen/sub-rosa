// Workflow studio: a node canvas over lib/studio/workflow. The declarative
// node schemas drive everything here — the palette, each node's mini form,
// its input ports, and connection compatibility — so adding a node type to
// the lib lights it up in the UI without canvas changes. Runs execute level
// by level with live per-node status; produced media lands in the gallery at
// the node that made it, with real provenance and chain links.

import { t } from "../../lib/i18n";
import { ErrorMessage } from "../ui/ErrorMessage";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  ReactFlow,
  type Connection,
  type Edge as FlowEdge,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useArtifactIndex } from "../../lib/artifact-media";
import { artifactSrc } from "../../lib/studio/artifacts";
import { rememberConstraintError } from "../../lib/studio/model-constraints";
import type { MediaCatalog } from "../../lib/studio/types";
import {
  activeWorkflowRuns,
  dismissWorkflowRun,
  listResumableRuns,
  resumeWorkflowRun,
  runAndSaveWorkflow,
  pruneWorkflowRuns,
  runDefinition,
  runResults,
  workflowRunHistory,
  workflowStepCache,
  type WorkflowRunSummary,
} from "../../lib/studio/workflow-run";
import {
  applyPortOrder,
  chainOrderSuggestion,
  defaultParams,
  deleteWorkflow,
  edgesOnPort,
  estimateWorkflowCost,
  fetchVideoQuotes,
  isInputCompatible,
  listWorkflows,
  maybeNodeSchema,
  needsRunConfirmation,
  NODE_SCHEMAS,
  nodeCostMap,
  nodeLabel,
  openInputPorts,
  outputKindOf,
  portCapacity,
  reorderPortEdge,
  resolveInputPort,
  saveWorkflow,
  strandedEdges,
  templateWorkflows,
  textSourceLabels,
  validateWorkflow,
  withReusedSteps,
  WorkflowRunError,
  type NodeRunResult,
  type ValidationIssue,
  type Workflow,
  type WorkflowCostEstimate,
  type WorkflowNode,
  type WorkflowNodeType,
} from "../../lib/studio/workflow";
import { invoke } from "@tauri-apps/api/core";
import { nodeEtaKey } from "../../lib/studio/workflow/eta";
import { nodeTypeLabel } from "../../lib/studio/workflow/labels";
import { migrateWorkflow } from "../../lib/studio/workflow/migrate";
import { pruneToTargets } from "../../lib/studio/workflow/partial";
import { spendGuard } from "../../lib/studio/workflow/spend";
import { rememberRenderMs } from "../../lib/studio/render-eta";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { workflowFileText } from "../../lib/studio/workflow/comfy/file";
import {
  coverArtifactOf,
  coverOffer,
  makeWorkflowCover,
  sameWorkflow,
} from "../../lib/studio/workflow/library";
import {
  blankWorkflow,
  loadWorkflowLibrary,
  setWorkflowCover,
  workflowLibraryLoaded,
} from "../../lib/studio/workflow/store";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { type ImportedWorkflow, WorkflowLibrary } from "./WorkflowLibrary";
import "@xyflow/react/dist/style.css";
import {
  type PortSourceEntry,
  type StudioFlowNode,
  SAVE_DEBOUNCE_MS,
  toFlowNodes,
  toFlowEdges,
  toWorkflowEdge,
  fromFlow,
  modelChangeNotice,
  openNotice,
} from "./workflow/flow";
import { type StudioEdgeData, EDGE_TYPES } from "./workflow/StudioEdge";
import { NODE_TYPES } from "./workflow/StudioNode";
import { costSummary, RunCostDialog } from "./workflow/RunCostDialog";
import { RunHistoryPanel } from "./workflow/RunHistoryPanel";
import { useReusePrediction } from "./workflow/useReusePrediction";

/**
 * The Workflows tab. The library is read before anything is drawn: an editor
 * that rendered on an empty cache would seed a first workflow over the ones
 * already stored (ADR-0075).
 */
export function WorkflowStudio({ catalog }: { catalog: MediaCatalog }) {
  const [ready, setReady] = useState(workflowLibraryLoaded);
  useEffect(() => {
    if (ready) return;
    let cancelled = false;
    void loadWorkflowLibrary().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [ready]);
  if (!ready) {
    return (
      <div className="studio-loading">
        <Spinner aria-label={t("Loading")} />
      </div>
    );
  }
  return <WorkflowEditor catalog={catalog} />;
}

function WorkflowEditor({ catalog }: { catalog: MediaCatalog }) {
  const [workflows, setWorkflows] = useState<Workflow[]>(() => listWorkflows());
  /** The library of cards, or the canvas of the workflow being edited. */
  const [view, setView] = useState<"library" | "canvas">("library");
  /** Focus follows the switch, or it falls back to the page body. */
  const [leftCanvas, setLeftCanvas] = useState(false);
  const libraryButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (view === "canvas") libraryButtonRef.current?.focus();
  }, [view]);

  const [current, setCurrent] = useState<Workflow | undefined>(() => listWorkflows()[0]);
  const [flowNodes, setFlowNodes] = useState<StudioFlowNode[]>([]);
  const [flowEdges, setFlowEdges] = useState<FlowEdge[]>([]);
  const [results, setResults] = useState<Map<string, NodeRunResult>>(new Map());
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const saveTimer = useRef<number | undefined>(undefined);
  const currentRef = useRef<Workflow | undefined>(current);
  currentRef.current = current;
  const flowNodesRef = useRef<StudioFlowNode[]>([]);
  flowNodesRef.current = flowNodes;
  const flowEdgesRef = useRef<FlowEdge[]>([]);
  flowEdgesRef.current = flowEdges;
  /** Read by handlers that must not re-identify when the catalog refreshes:
   * `hydrate` depends on their identity and would re-open the workflow. */
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  /** One gallery listing for the whole canvas, so an asset node can show what
   * it points at without a listing per node. */
  const artifacts = useArtifactIndex();
  /** The connection the reference list is pointing at, lit on the canvas.
   * Reading a list entry and finding its wire is otherwise a guess once a
   * node has four references. */
  const [highlightedEdge, setHighlightedEdge] = useState<string | undefined>(undefined);
  /** What a model change dropped, said once next to the toolbar. */
  const [portNotice, setPortNotice] = useState<string | undefined>(undefined);
  /** Bumped when a failed render taught us what a model accepts, so every
   * option list under it re-derives. */
  const [constraintEpoch, setConstraintEpoch] = useState(0);
  /** The durable run this canvas is showing (started or resumed here), so a
   * gate approval knows which run to continue. */
  const runIdRef = useRef<string | undefined>(undefined);
  /** Stable identity for node data; retargeted once the handler exists. */
  const approveGateRef = useRef<(gateId: string, choice: string | undefined) => void>(() => {});
  const onApproveGate = useCallback(
    (gateId: string, choice: string | undefined) => approveGateRef.current(gateId, choice),
    [],
  );
  /** The last run's results as they arrive, read once the run is over. */
  const runResultsRef = useRef<Map<string, NodeRunResult>>(new Map());
  /** When each render of a run started here began. Only a run started on
   * this canvas is timed: a resumed node re-attaches to a job that began
   * earlier, and filing its shorter wait would teach every estimate a lie. */
  const renderStartsRef = useRef<Map<string, number> | undefined>(undefined);
  const mirrorUpdate = useCallback((result: NodeRunResult) => {
    runResultsRef.current.set(result.nodeId, result);
    const starts = renderStartsRef.current;
    if (starts) {
      if (result.status === "running") {
        if (!starts.has(result.nodeId)) starts.set(result.nodeId, Date.now());
      } else {
        const startedAt = starts.get(result.nodeId);
        starts.delete(result.nodeId);
        const node = flowNodesRef.current.find((entry) => entry.id === result.nodeId)?.data.wfNode;
        const etaKey = node ? nodeEtaKey(node) : undefined;
        if (result.status === "done" && startedAt !== undefined && etaKey) {
          rememberRenderMs(etaKey, Date.now() - startedAt);
        }
      }
    }
    setResults((currentResults) => {
      const next = new Map(currentResults);
      next.set(result.nodeId, result);
      return next;
    });
    // A rejected render carries the provider's own account of what the model
    // wanted, and the operator now enumerates it in full on the queue itself
    // (`400 VIDEO_PARAM_REJECTED`, every faulty field with its accepted list).
    // Reading it here is what makes the pickers right for the families the
    // catalog publishes nothing about - the video studio has always done this,
    // and a workflow that fails the same way should teach the same lesson.
    if (result.status !== "error" || !result.error) return;
    const model = flowNodesRef.current.find((node) => node.id === result.nodeId)?.data.wfNode.params
      .model;
    if (typeof model !== "string" || model === "") return;
    if (Object.keys(rememberConstraintError(model, result.error)).length > 0) {
      setConstraintEpoch((epoch) => epoch + 1);
    }
  }, []);

  const onParamsChange = useCallback((id: string, params: Record<string, unknown>) => {
    setFlowNodes((nodes) =>
      nodes.map((node) =>
        node.id === id
          ? { ...node, data: { ...node.data, wfNode: { ...node.data.wfNode, params } } }
          : node,
      ),
    );
    const nodes = flowNodesRef.current;
    const target = nodes.find((node) => node.id === id)?.data.wfNode;
    // The model is the only param that closes a port, and comparing it is
    // what keeps this off the path of every keystroke in a prompt.
    if (!target || target.params.model === params.model) return;
    // Changing the model can close an input the node no longer carries (a
    // reference-to-video model has no opening frame). An edge left on a closed
    // port would block the run with a validation error the user did not cause,
    // so it is let go here, where it can be seen, rather than at submit - the
    // way the video studio lets go of clips when the family changes.
    const stranded = strandedEdges({
      nodes: nodes.map((node) => (node.id === id ? { ...target, params } : node.data.wfNode)),
      edges: flowEdgesRef.current.map(toWorkflowEdge),
    });
    if (stranded.length === 0) return;
    const dropped = new Set(stranded.map((entry) => entry.edge.id));
    setFlowEdges((edges) => edges.filter((edge) => !dropped.has(edge.id)));
    const modelName =
      catalogRef.current.models.find((model) => model.id === params.model)?.name ?? t("This model");
    setPortNotice(modelChangeNotice(modelName, stranded, nodes));
  }, []);

  /** Naming a node is naming it everywhere: the connection lists, the gate
   * candidates, the cost breakdown and the assemble node's own artifact all
   * read the same label. */
  const onRename = useCallback((id: string, label: string) => {
    setFlowNodes((nodes) =>
      nodes.map((node) =>
        node.id === id
          ? { ...node, data: { ...node.data, wfNode: { ...node.data.wfNode, label } } }
          : node,
      ),
    );
  }, []);

  const onRemove = useCallback((id: string) => {
    setFlowNodes((nodes) => nodes.filter((node) => node.id !== id));
    setFlowEdges((edges) => edges.filter((edge) => edge.source !== id && edge.target !== id));
  }, []);

  // (Re)hydrate the canvas whenever another workflow is selected.
  const hydrate = useCallback(
    (stored: Workflow | undefined) => {
      // Brought forward on open (renamed steps, reshaped settings); a newer
      // version's workflow is shown as it was written.
      const workflow = stored && !stored.readOnly ? migrateWorkflow(stored) : stored;
      setCurrent(workflow);
      setResults(new Map());
      setRunError(undefined);
      setPortNotice(undefined);
      // A workflow saved before its models' inputs were understood can hold a
      // connection on a port the node no longer draws, which would render as a
      // wire pinned to a handle that is not there. Let it go on open, and say
      // so - the same handling as a model change, at the other moment it can
      // happen.
      const stranded = workflow ? strandedEdges(workflow) : [];
      const dropped = new Set(stranded.map((entry) => entry.edge.id));
      const opened = workflow
        ? { ...workflow, edges: workflow.edges.filter((edge) => !dropped.has(edge.id)) }
        : undefined;
      setFlowNodes(
        opened
          ? toFlowNodes(
              opened,
              catalog,
              artifacts,
              new Map(),
              onParamsChange,
              onRename,
              onRemove,
              onApproveGate,
            )
          : [],
      );
      setFlowEdges(opened ? toFlowEdges(opened) : []);
      if (stranded.length > 0) setPortNotice(openNotice(stranded));
      // What the last run made shows again on its steps: reopening a
      // workflow used to show none of its past results. Left alone if a run
      // has started meanwhile.
      if (opened) {
        const openedId = opened.id;
        void (async () => {
          const last = (await workflowRunHistory(openedId)).find(
            (entry) => entry.done > 0 && entry.status !== "running",
          );
          if (!last) return;
          const { results: past } = await runResults(last.id);
          if (currentRef.current?.id !== openedId) return;
          const present = new Set(opened.nodes.map((node) => node.id));
          setResults((live) =>
            live.size > 0 ? live : new Map([...past].filter(([nodeId]) => present.has(nodeId))),
          );
        })().catch(() => undefined);
      }
    },
    [catalog, artifacts, onParamsChange, onRename, onRemove, onApproveGate],
  );

  // First mount: open the most recent workflow, or seed from templates. Once:
  // `hydrate` changes with the catalog, and running again would seed a new
  // first workflow after the last was deleted, or switch the canvas.
  const firstMountRef = useRef(false);
  useEffect(() => {
    if (firstMountRef.current) return;
    firstMountRef.current = true;
    const existing = listWorkflows();
    if (existing.length > 0) {
      hydrate(existing[0]);
      return;
    }
    const seeded = blankWorkflow("My first workflow");
    const template = templateWorkflows()[0];
    const idMap = new Map(template.nodes.map((node) => [node.id, crypto.randomUUID()]));
    const workflow: Workflow = {
      ...seeded,
      nodes: template.nodes.map((node) => ({
        ...node,
        id: idMap.get(node.id) ?? node.id,
        params: { ...node.params },
      })),
      edges: template.edges.map((edge) => ({
        ...edge,
        id: crypto.randomUUID(),
        source: idMap.get(edge.source) ?? edge.source,
        target: idMap.get(edge.target) ?? edge.target,
      })),
    };
    saveWorkflow(workflow);
    setWorkflows(listWorkflows());
    hydrate(workflow);
  }, [hydrate]);

  // Debounced persistence of every canvas change (drag, edit, connect).
  useEffect(() => {
    const base = currentRef.current;
    if (!base || base.readOnly) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const serialized = fromFlow(base, flowNodes, flowEdges);
      // Opening a workflow redraws its canvas; that is not an edit, and
      // saving it would move the card to the top with today's date.
      const stored = listWorkflows().find((entry) => entry.id === serialized.id);
      if (stored && sameWorkflow(stored, serialized)) return;
      saveWorkflow(serialized);
      currentRef.current = serialized;
      setWorkflows(listWorkflows());
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(saveTimer.current);
    // `current` is a dependency so renames persist without a canvas change.
  }, [flowNodes, flowEdges, current]);

  /** Move one connection within its port's order. The engine reads edge
   * order, so this IS the reorder — nothing else changes. */
  const onReorderEdge = useCallback((edgeId: string, delta: -1 | 1) => {
    setFlowEdges((edges) => {
      const graph = {
        nodes: flowNodesRef.current.map((node) => node.data.wfNode),
        edges: edges.map(toWorkflowEdge),
      };
      const reordered = reorderPortEdge(graph, edgeId, delta);
      if (reordered === graph.edges) return edges;
      const byId = new Map(edges.map((edge) => [edge.id, edge]));
      return reordered.flatMap((entry) => byId.get(entry.id) ?? []);
    });
  }, []);

  const onHighlightEdge = useCallback((edgeId: string | undefined) => {
    setHighlightedEdge(edgeId);
  }, []);

  const onApplyChainOrder = useCallback((_nodeId: string, orderedEdgeIds: string[]) => {
    setFlowEdges((edges) => {
      const applied = applyPortOrder(edges.map(toWorkflowEdge), orderedEdgeIds);
      const byId = new Map(edges.map((edge) => [edge.id, edge]));
      return applied.flatMap((entry) => byId.get(entry.id) ?? []);
    });
  }, []);

  const serialized = current ? fromFlow(current, flowNodes, flowEdges) : undefined;
  const validation = useMemo(
    () => (serialized ? validateWorkflow(serialized) : undefined),
    [serialized],
  );
  /** Bumped when a run ends, so the cache is asked again what it now holds. */
  const [runEpoch, setRunEpoch] = useState(0);
  const reused = useReusePrediction(serialized, runEpoch);

  /** "Run this step", with a stable identity for node data; retargeted at
   * every render to the current run handler. */
  const runStepRef = useRef<(nodeId: string) => void>(() => {});
  const onRunStep = useCallback((nodeId: string) => runStepRef.current(nodeId), []);

  /** Each step's own problems, so they show on the step itself. */
  const issuesByNode = useMemo(() => {
    const byNode = new Map<string, ValidationIssue[]>();
    for (const issue of [...(validation?.errors ?? []), ...(validation?.warnings ?? [])]) {
      if (!issue.nodeId) continue;
      byNode.set(issue.nodeId, [...(byNode.get(issue.nodeId) ?? []), issue]);
    }
    return byNode;
  }, [validation]);

  // Keep node data in sync with run results without disturbing positions.
  // Connection-order lists, gate candidates, and the assemble node's chain
  // suggestion refresh here too, so they always describe the wiring as it is.
  useEffect(() => {
    setFlowNodes((nodes) => {
      const graph = {
        nodes: nodes.map((node) => node.data.wfNode),
        edges: flowEdges.map(toWorkflowEdge),
      };
      const labelOf = new Map(nodes.map((node) => [node.id, nodeLabel(node.data.wfNode)]));
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
            willReuse: reused.has(node.id),
            issues: issuesByNode.get(node.id),
            onRunStep,
            gateSources:
              wfNode.type === "gate"
                ? edgesOnPort(graph, node.id, "in").map((edge) => ({
                    id: edge.source,
                    label: labelOf.get(edge.source) ?? "",
                  }))
                : undefined,
          },
        };
      });
    });
  }, [
    results,
    reused,
    issuesByNode,
    onRunStep,
    catalog,
    artifacts,
    constraintEpoch,
    flowEdges,
    onReorderEdge,
    onHighlightEdge,
    onApplyChainOrder,
  ]);

  const onNodesChange = useCallback(
    (changes: NodeChange<StudioFlowNode>[]) =>
      setFlowNodes((nodes) => applyNodeChanges(changes, nodes)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => setFlowEdges((edges) => applyEdgeChanges(changes, edges)),
    [],
  );
  const onConnect = useCallback((connection: Connection) => {
    setFlowEdges((edges) => addEdge({ ...connection, animated: true }, edges));
  }, []);

  /** Connections must land on a port that accepts the source's kind and still
   * has room. What this rejects, the validator would flag anyway — refusing
   * the drop is just the earlier, kinder place to say no. */
  const isValidConnection = useCallback(
    (connection: Connection | FlowEdge) => {
      const source = flowNodes.find((node) => node.id === connection.source)?.data.wfNode;
      const target = flowNodes.find((node) => node.id === connection.target)?.data.wfNode;
      if (!source || !target || source.id === target.id) return false;
      const schema = maybeNodeSchema(target.type);
      if (!schema || openInputPorts(schema, target.params).length === 0) return false;
      // Graph context so a gate's output resolves to what it passes through.
      const sourceKind = outputKindOf(source, {
        nodeById: new Map(flowNodes.map((node) => [node.id, node.data.wfNode])),
        edges: flowEdges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          targetPort: edge.targetHandle ?? undefined,
        })),
      });
      const port = resolveInputPort(
        target,
        { targetPort: connection.targetHandle ?? undefined },
        sourceKind,
      );
      if (!port || !isInputCompatible(sourceKind, port.kind)) return false;
      const landing = flowEdges.filter(
        (edge) => edge.target === target.id && (edge.targetHandle ?? undefined) === port.id,
      ).length;
      // The cap can be per model (seedance 2.0 takes 9 reference photos,
      // 2.5 takes 30), so ask the port with the node's own params.
      const capacity = portCapacity(port, target.params) ?? Number.POSITIVE_INFINITY;
      return landing < capacity;
    },
    [flowNodes, flowEdges],
  );

  const addNode = useCallback(
    (type: WorkflowNodeType) => {
      const offset = flowNodes.length;
      const wfNode: WorkflowNode = {
        id: crypto.randomUUID(),
        type,
        // Unnamed: the type shows through as a placeholder until the user
        // gives it one, which is what keeps "never named" tellable.
        label: "",
        position: { x: 80 + (offset % 4) * 60, y: 80 + offset * 40 },
        params: defaultParams(type),
      };
      setFlowNodes((nodes) => [
        ...nodes,
        {
          id: wfNode.id,
          type: "studio" as const,
          position: wfNode.position,
          data: {
            wfNode,
            catalog,
            artifacts,
            constraintEpoch,
            onParamsChange,
            onRename,
            onRemove,
            onApproveGate,
          },
        },
      ]);
    },
    [
      flowNodes.length,
      catalog,
      artifacts,
      constraintEpoch,
      onParamsChange,
      onRename,
      onRemove,
      onApproveGate,
    ],
  );

  const applyTemplate = useCallback(
    (templateId: string) => {
      const template = templateWorkflows().find((entry) => entry.id === templateId);
      if (!template) return;
      const workflow = blankWorkflow(template.name);
      const idMap = new Map(template.nodes.map((node) => [node.id, crypto.randomUUID()]));
      const cloned: Workflow = {
        ...workflow,
        nodes: template.nodes.map((node) => ({
          ...node,
          id: idMap.get(node.id) ?? node.id,
          params: { ...node.params },
        })),
        edges: template.edges.map((edge) => ({
          ...edge,
          id: crypto.randomUUID(),
          source: idMap.get(edge.source) ?? edge.source,
          target: idMap.get(edge.target) ?? edge.target,
        })),
      };
      saveWorkflow(cloned);
      setWorkflows(listWorkflows());
      hydrate(cloned);
      setView("canvas");
    },
    [hydrate],
  );

  /** What edge-order resolution actually depends on: node identities, types,
   * and the asset kinds that drive affinity — NOT positions. Keying on this
   * keeps a node drag (which recreates `flowNodes` every frame) from
   * recomputing and re-identifying every edge. */
  const orderGraphKey = flowNodes
    .map(
      (node) =>
        `${node.id}:${node.data.wfNode.type}:${String(node.data.wfNode.params.assetKind ?? "")}`,
    )
    .join("|");

  /** Connection-order badges: edges into a multi port with two or more
   * connections carry their 1-based position; everything else stays bare. */
  const displayEdges = useMemo(() => {
    const graph = {
      nodes: flowNodesRef.current.map((node) => node.data.wfNode),
      edges: flowEdges.map(toWorkflowEdge),
    };
    const orders = new Map<string, number>();
    for (const node of graph.nodes) {
      const schema = maybeNodeSchema(node.type);
      for (const port of schema ? openInputPorts(schema, node.params) : []) {
        if (!port.multi) continue;
        const portEdges = edgesOnPort(graph, node.id, port.id);
        if (portEdges.length < 2) continue;
        portEdges.forEach((edge, index) => {
          orders.set(edge.id, index + 1);
        });
      }
    }
    // Where each badge stacks: one asset can be reference 1 of a shot and
    // reference 3 of the next, and both badges leave the same handle.
    const sourceRanks = new Map<string, number>();
    const perSource = new Map<string, number>();
    for (const edge of flowEdges) {
      if (orders.get(edge.id) === undefined) continue;
      const rank = perSource.get(edge.source) ?? 0;
      sourceRanks.set(edge.id, rank);
      perSource.set(edge.source, rank + 1);
    }
    return flowEdges.map((edge) => ({
      ...edge,
      type: "studio" as const,
      data: {
        order: orders.get(edge.id),
        sourceRank: sourceRanks.get(edge.id),
        highlight: edge.id === highlightedEdge,
      } satisfies StudioEdgeData,
    }));
    // orderGraphKey stands in for the node list: order only depends on the
    // parts of it the key captures.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  }, [flowEdges, orderGraphKey, highlightedEdge]);
  const estimate = useMemo(
    () =>
      serialized ? withReusedSteps(estimateWorkflowCost(serialized, catalog), reused) : undefined,
    [serialized, catalog, reused],
  );
  const [pendingRun, setPendingRun] = useState<
    { estimate: WorkflowCostEstimate; targets?: string[] } | undefined
  >(undefined);
  /** The canvas instance, for bringing a step into view. */
  const flowRef = useRef<ReactFlowInstance<StudioFlowNode> | undefined>(undefined);
  const locateNode = useCallback((nodeId: string) => {
    void flowRef.current?.fitView({ nodes: [{ id: nodeId }], duration: 250, maxZoom: 1 });
  }, []);
  const [quoting, setQuoting] = useState(false);
  /** Interrupted durable runs found on mount, offered for resume. */
  const [resumable, setResumable] = useState<WorkflowRunSummary[]>([]);
  /** Runs still executing in this webview (started here, tab switched away):
   * shown as running, never offered for a second "resume". */
  const [liveProductions, setLiveProductions] = useState(() => activeWorkflowRuns());

  useEffect(() => {
    let cancelled = false;
    void listResumableRuns().then((runs) => {
      if (!cancelled) setResumable(runs);
    });
    const tick = window.setInterval(() => setLiveProductions(activeWorkflowRuns()), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(tick);
    };
  }, []);

  /** The figures the run on screen was started or resumed with, so a gate
   * approved later is held to the same budget check. */
  const runEstimateRef = useRef<WorkflowCostEstimate | undefined>(undefined);

  const run = useCallback(
    async (priced: WorkflowCostEstimate, targets?: string[]) => {
      // Part of the graph: the steps asked for and what they need, frozen as
      // the run's definition; upstream comes back from the cache.
      const runnable = serialized && targets ? pruneToTargets(serialized, targets) : serialized;
      if (!runnable || running || !validateWorkflow(runnable).ok) return;
      runEstimateRef.current = priced;
      renderStartsRef.current = new Map();
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      setRunning(true);
      setRunError(undefined);
      // A partial run leaves what the other steps show alone.
      const inRun = new Set(runnable.nodes.map((node) => node.id));
      setResults((live) =>
        targets ? new Map([...live].filter(([nodeId]) => !inRun.has(nodeId))) : new Map(),
      );
      runResultsRef.current = new Map();
      try {
        // Durable run (ADR-0021): state persists as rows, long renders ride
        // the Rust job pollers, and produced media lands in the gallery at
        // the node that made it, with provenance and chain links.
        await runAndSaveWorkflow(runnable, {
          signal: controller.signal,
          scheduling: "ready",
          isolateFailures: true,
          nodeCosts: nodeCostMap(priced),
          beforeNode: spendGuard(priced, { unpriced: "allow" }),
          cache: workflowStepCache(runnable.id),
          onRunRecorded: (runId) => {
            runIdRef.current = runId;
          },
          onUpdate: mirrorUpdate,
        });
        void pruneWorkflowRuns(runnable.id);
        // The run's own result becomes the library card's picture: free, and
        // true to what the workflow makes.
        const cover = coverArtifactOf(runnable, runResultsRef.current);
        if (cover) {
          void setWorkflowCover(runnable.id, cover)
            .then(() => setWorkflows(listWorkflows()))
            .catch(() => undefined);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          // Cancelled on purpose; per-node statuses already reset.
        } else if (error instanceof WorkflowRunError) {
          setRunError(error.message);
        } else {
          setRunError(error instanceof Error ? error.message : t("The run failed."));
        }
      } finally {
        setRunning(false);
        setRunEpoch((epoch) => epoch + 1);
      }
    },
    [serialized, running, mirrorUpdate],
  );

  /** Pick an interrupted production back up. Node states light the canvas up
   * when the run came from the workflow currently on it; a run from another
   * (or a deleted) workflow still resumes, reported through the banner. */
  const resume = useCallback(
    async (entry: WorkflowRunSummary) => {
      if (running) return;
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      setRunning(true);
      setRunError(undefined);
      setResults(new Map());
      runIdRef.current = entry.id;
      runResultsRef.current = new Map();
      renderStartsRef.current = undefined;
      const mirrorsCanvas = current?.id === entry.workflowId;
      // Held to the same check as a fresh run: a resume that would spend past
      // what the account holds stops at the step, not after ten minutes of
      // payment refusals.
      const definition = runDefinition(entry);
      const priced = definition ? estimateWorkflowCost(definition, catalog) : undefined;
      runEstimateRef.current = priced;
      try {
        await resumeWorkflowRun(entry.id, {
          signal: controller.signal,
          beforeNode: priced ? spendGuard(priced, { unpriced: "allow" }) : undefined,
          cache: workflowStepCache(entry.workflowId),
          scheduling: "ready",
          isolateFailures: true,
          onUpdate: mirrorsCanvas ? mirrorUpdate : undefined,
        });
        // A resumed run's result is the card's picture too.
        const cover =
          mirrorsCanvas && current ? coverArtifactOf(current, runResultsRef.current) : undefined;
        if (cover) {
          void setWorkflowCover(entry.workflowId, cover)
            .then(() => setWorkflows(listWorkflows()))
            .catch(() => undefined);
        }
        setResumable((entries) => entries.filter((candidate) => candidate.id !== entry.id));
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          // Cancelled on purpose; the run stays resumable.
        } else {
          setRunError(error instanceof Error ? error.message : t("The resume failed."));
          setResumable((entries) => entries.filter((candidate) => candidate.id !== entry.id));
        }
      } finally {
        setRunning(false);
        setRunEpoch((epoch) => epoch + 1);
      }
    },
    [running, current, mirrorUpdate, catalog],
  );

  /** Decide one gate and continue the held production. Gates left undecided
   * simply hold again — approving is always one gate at a time here. */
  const continueHeldRun = useCallback(
    async (gateId: string, choice: string | undefined) => {
      const runId = runIdRef.current;
      if (!runId || running) return;
      renderStartsRef.current = undefined;
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      setRunning(true);
      setRunError(undefined);
      try {
        const priced = runEstimateRef.current;
        await resumeWorkflowRun(runId, {
          signal: controller.signal,
          beforeNode: priced ? spendGuard(priced, { unpriced: "allow" }) : undefined,
          cache: currentRef.current ? workflowStepCache(currentRef.current.id) : undefined,
          scheduling: "ready",
          isolateFailures: true,
          approvedGates: new Map([[gateId, choice]]),
          onUpdate: mirrorUpdate,
        });
        setResumable((entries) => entries.filter((candidate) => candidate.id !== runId));
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          // Cancelled on purpose; the gate holds.
        } else {
          setRunError(error instanceof Error ? error.message : t("The approval failed."));
        }
      } finally {
        setRunning(false);
        setRunEpoch((epoch) => epoch + 1);
      }
    },
    [running, mirrorUpdate],
  );

  useEffect(() => {
    approveGateRef.current = (gateId, choice) => {
      void continueHeldRun(gateId, choice);
    };
  }, [continueHeldRun]);

  const dismissResumable = useCallback(async (entry: WorkflowRunSummary) => {
    await dismissWorkflowRun(entry.id);
    setResumable((entries) => entries.filter((candidate) => candidate.id !== entry.id));
  }, []);

  /** Run, with the pre-spend handshake in between when the graph warrants
   * one: quotes refine the figures, then the dialog shows the bill. */
  const startRun = useCallback(
    async (targets?: string[]) => {
      if (!serialized || running || quoting) return;
      const runnable = targets ? pruneToTargets(serialized, targets) : serialized;
      // Only what will run has to be valid: a broken step elsewhere does
      // not block running this one.
      const check = validateWorkflow(runnable);
      if (!check.ok) {
        const first = check.errors[0];
        setRunError(first?.message ?? t("The workflow is invalid."));
        if (first?.nodeId) locateNode(first.nodeId);
        return;
      }
      const staticEstimate = withReusedSteps(estimateWorkflowCost(runnable, catalog), reused);
      if (!needsRunConfirmation(staticEstimate)) {
        void run(staticEstimate, targets);
        return;
      }
      setQuoting(true);
      try {
        const quotes = await fetchVideoQuotes(runnable, catalog);
        setPendingRun({
          estimate: withReusedSteps(estimateWorkflowCost(runnable, catalog, quotes), reused),
          targets,
        });
      } finally {
        setQuoting(false);
      }
    },
    [serialized, running, quoting, catalog, run, reused, locateNode],
  );
  runStepRef.current = (nodeId) => void startRun([nodeId]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const removeCurrent = useCallback(() => {
    if (!current) return;
    deleteWorkflow(current.id);
    const remaining = listWorkflows();
    setWorkflows(remaining);
    hydrate(remaining[0]);
  }, [current, hydrate]);

  const newWorkflow = useCallback(() => {
    const workflow = blankWorkflow("Untitled workflow");
    saveWorkflow(workflow);
    setWorkflows(listWorkflows());
    hydrate(workflow);
    setView("canvas");
  }, [hydrate]);

  const openWorkflow = useCallback(
    (workflow: Workflow) => {
      hydrate(workflow);
      setView("canvas");
    },
    [hydrate],
  );

  /** A file read and, for a ComfyUI one, translated and reviewed. */
  const importWorkflow = useCallback(
    (imported: ImportedWorkflow) => {
      const workflow = saveWorkflow({
        ...blankWorkflow(imported.name),
        ...(imported.description ? { description: imported.description } : {}),
        ...(imported.extra ? { extra: imported.extra } : {}),
        nodes: imported.nodes,
        edges: imported.edges,
        origin: "import",
      });
      setWorkflows(listWorkflows());
      hydrate(workflow);
      setView("canvas");
    },
    [hydrate],
  );

  const exportWorkflow = useCallback(async (workflow: Workflow) => {
    await invoke<string | null>("studio_workflow_export", {
      name: workflow.name,
      contents: workflowFileText(workflow),
    });
  }, []);

  const deleteFromLibrary = useCallback(
    (workflow: Workflow) => {
      deleteWorkflow(workflow.id);
      const remaining = listWorkflows();
      setWorkflows(remaining);
      if (currentRef.current?.id === workflow.id) hydrate(remaining[0]);
    },
    [hydrate],
  );

  const makeCover = useCallback(
    async (workflow: Workflow) => {
      const offer = coverOffer(catalog);
      if (!offer) return undefined;
      const made = await makeWorkflowCover(workflow, offer);
      setWorkflows(listWorkflows());
      return made;
    },
    [catalog],
  );

  const [historyOpen, setHistoryOpen] = useState(false);
  const showRun = useCallback(async (runId: string) => {
    const { results: past } = await runResults(runId);
    const present = new Set(flowNodesRef.current.map((node) => node.id));
    setResults(new Map([...past].filter(([nodeId]) => present.has(nodeId))));
  }, []);
  const restoreRun = useCallback(
    async (runId: string) => {
      const base = currentRef.current;
      const { definition, results: past } = await runResults(runId);
      if (!base || !definition) return;
      hydrate({ ...base, nodes: definition.nodes, edges: definition.edges });
      setResults(past);
    },
    [hydrate],
  );

  const productionBanners = (
    <>
      {!running && liveProductions.length > 0 ? (
        <div className="studio-resume-banner">
          {liveProductions.map((entry) => (
            <div key={entry.id} className="studio-resume-row">
              <span>
                {t("Still producing:")} <strong>{entry.name || t("Untitled workflow")}</strong>
                {t(". Its media lands in the gallery as it finishes.")}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {resumable.length > 0 ? (
        <div className="studio-resume-banner">
          {resumable.map((entry) => (
            <div key={entry.id} className="studio-resume-row">
              <span>
                {entry.status === "failed" ? (
                  <>
                    {t("A production that stopped:")}{" "}
                    <strong>{entry.name || t("Untitled workflow")}</strong>.{" "}
                    {entry.error || t("A step failed.")}{" "}
                    {t("Finished steps are kept; resuming retries the one that failed.")}
                  </>
                ) : entry.status === "cancelled" ? (
                  <>
                    {t("A production you stopped:")}{" "}
                    <strong>{entry.name || t("Untitled workflow")}</strong>
                    {t(". Finished steps are kept; resuming only runs what is left.")}
                  </>
                ) : entry.status === "awaitingGate" ? (
                  <>
                    {t("A production waiting on you:")}{" "}
                    <strong>{entry.name || t("Untitled workflow")}</strong>
                    {t(". Resume it to reach the gate and decide.")}
                  </>
                ) : (
                  <>
                    {t("An interrupted production:")}{" "}
                    <strong>{entry.name || t("Untitled workflow")}</strong>
                    {t(". Finished steps are kept; resuming only runs what is left.")}
                  </>
                )}
              </span>
              <span className="studio-resume-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={running}
                  onClick={() => void dismissResumable(entry)}
                >
                  {t("Dismiss")}
                </button>
                <button
                  type="button"
                  className="studio-primary-button"
                  disabled={running}
                  onClick={() => void resume(entry)}
                >
                  {t("Resume")}
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );

  if (view === "library") {
    return (
      <div className="studio-workflows">
        {productionBanners}
        {runError ? <ErrorMessage>{runError}</ErrorMessage> : null}
        <WorkflowLibrary
          catalog={catalog}
          workflows={workflows}
          templates={templateWorkflows()}
          onOpen={openWorkflow}
          onUseTemplate={applyTemplate}
          onNew={newWorkflow}
          onImported={importWorkflow}
          onExport={exportWorkflow}
          onDelete={deleteFromLibrary}
          onMakeCover={makeCover}
          autoFocus={leftCanvas}
        />
      </div>
    );
  }

  return (
    <div className="studio-workflows">
      <div className="studio-workflows-toolbar">
        <button
          ref={libraryButtonRef}
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setLeftCanvas(true);
            setView("library");
          }}
        >
          {t("Library")}
        </button>
        <input
          className="studio-input studio-workflow-name"
          value={current?.name ?? ""}
          placeholder={t("Workflow name")}
          aria-label={t("Workflow name")}
          onChange={(event) =>
            setCurrent((existing) =>
              existing ? { ...existing, name: event.target.value } : existing,
            )
          }
        />
        <button type="button" className="btn btn-secondary" onClick={newWorkflow}>
          {t("New")}
        </button>
        <Select
          value={null}
          placeholder={t("Add node")}
          ariaLabel={t("Add a node")}
          onChange={(type) => addNode(type as WorkflowNodeType)}
          options={Object.values(NODE_SCHEMAS).map((schema) => ({
            value: schema.type,
            label: nodeTypeLabel(schema.type),
          }))}
        />
        <button
          type="button"
          className="btn btn-secondary"
          aria-pressed={historyOpen}
          disabled={!current}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          {t("History")}
        </button>
        <span className="studio-spacer" />
        {current ? (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setConfirmingDelete(true)}
          >
            {t("Delete")}
          </button>
        ) : null}
        {estimate && (estimate.credits > 0 || estimate.metered > 0) ? (
          <span className="studio-workflow-cost" title={t("Estimated cost of one run")}>
            {costSummary(estimate)}
          </span>
        ) : null}
        {running ? (
          <button type="button" className="btn btn-secondary" onClick={stop}>
            {t("Stop")}
          </button>
        ) : (
          <button
            type="button"
            className="studio-primary-button"
            disabled={
              !validation?.ok ||
              !serialized ||
              serialized.nodes.length === 0 ||
              quoting ||
              current?.readOnly === true
            }
            title={validation?.errors.map((issue) => issue.message).join("\n") || undefined}
            onClick={() => void startRun()}
          >
            {quoting ? t("Pricing...") : t("Run workflow")}
          </button>
        )}
      </div>
      <ConfirmDialog
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title={t("Delete this workflow?")}
        description={t("Its results stay in the gallery.")}
        confirmLabel={t("Delete")}
        destructive
        onConfirm={() => {
          setConfirmingDelete(false);
          removeCurrent();
        }}
      />
      {pendingRun ? (
        <RunCostDialog
          estimate={pendingRun.estimate}
          onConfirm={() => {
            const { estimate: priced, targets } = pendingRun;
            setPendingRun(undefined);
            void run(priced, targets);
          }}
          onClose={() => setPendingRun(undefined)}
        />
      ) : null}
      {current?.readOnly ? (
        <div className="studio-port-notice" role="status">
          <span>
            {t(
              "A newer version of Sub Rosa made this workflow. Update the app to edit or run it; it is shown here as it was saved.",
            )}
          </span>
        </div>
      ) : null}
      {portNotice ? (
        <div className="studio-port-notice">
          <span>{portNotice}</span>
          <button
            type="button"
            className="studio-icon-button"
            aria-label={t("Dismiss")}
            onClick={() => setPortNotice(undefined)}
          >
            <IconCrossSmall size={14} />
          </button>
        </div>
      ) : null}
      {productionBanners}
      {runError ? <ErrorMessage>{runError}</ErrorMessage> : null}
      {validation && (validation.errors.length > 0 || validation.warnings.length > 0) ? (
        <div className="studio-validation">
          {[...validation.errors, ...validation.warnings].map((issue) => {
            const key = `${issue.severity}:${issue.nodeId ?? issue.edgeId ?? ""}:${issue.message}`;
            const nodeId = issue.nodeId;
            return nodeId ? (
              <button
                key={key}
                type="button"
                className="studio-validation-issue"
                data-severity={issue.severity}
                title={t("Show this step")}
                onClick={() => locateNode(nodeId)}
              >
                {issue.message}
              </button>
            ) : (
              <span key={key} data-severity={issue.severity}>
                {issue.message}
              </span>
            );
          })}
        </div>
      ) : null}
      {historyOpen && current ? (
        <RunHistoryPanel
          workflowId={current.id}
          refreshKey={runEpoch}
          onShow={(runId) => void showRun(runId)}
          onRestore={(runId) => void restoreRun(runId)}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}
      <div
        className="studio-workflow-canvas"
        data-readonly={current?.readOnly ? "true" : undefined}
      >
        <ReactFlow
          nodes={flowNodes}
          edges={displayEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onInit={(instance) => {
            // The display edges carry badge data the instance's type does
            // not need to know about.
            flowRef.current = instance as unknown as ReactFlowInstance<StudioFlowNode>;
          }}
          nodesDraggable={!current?.readOnly}
          nodesConnectable={!current?.readOnly}
          edgesReconnectable={!current?.readOnly}
          deleteKeyCode={current?.readOnly ? null : undefined}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
