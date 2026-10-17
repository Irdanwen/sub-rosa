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
  MiniMap,
  ReactFlow,
  reconnectEdge,
  type Connection,
  type Edge as FlowEdge,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import { IconArrowRedoDown } from "central-icons/IconArrowRedoDown";
import { IconArrowUndoUp } from "central-icons/IconArrowUndoUp";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useArtifactIndex } from "../../lib/artifact-media";
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
  defaultParams,
  deleteWorkflow,
  edgesOnPort,
  estimateWorkflowCost,
  fetchVideoQuotes,
  listWorkflows,
  maybeNodeSchema,
  needsRunConfirmation,
  NODE_SCHEMAS,
  nodeCostMap,
  openInputPorts,
  outputKindOf,
  reorderPortEdge,
  resolveInputPort,
  saveWorkflow,
  strandedEdges,
  templateWorkflows,
  validateWorkflow,
  withReusedSteps,
  WorkflowRunError,
  type NodeRunResult,
  type Workflow,
  type WorkflowCostEstimate,
  type WorkflowBlock,
  type WorkflowEdge,
  type WorkflowFrame,
  type WorkflowNode,
  type WorkflowNodeType,
} from "../../lib/studio/workflow";
import { invoke } from "@tauri-apps/api/core";
import { nodeEtaKey } from "../../lib/studio/workflow/eta";
import { nodeTypeLabel } from "../../lib/studio/workflow/labels";
import { migrateWorkflow } from "../../lib/studio/workflow/migrate";
import type { LinkFilter, NodeSearchHit } from "../../lib/studio/workflow/node-search";
import { pruneToTargets } from "../../lib/studio/workflow/partial";
import { align, distribute, layered } from "../../lib/studio/workflow/arrange";
import { spendGuard } from "../../lib/studio/workflow/spend";
import { stableJson } from "../../lib/studio/workflow/stable-json";
import {
  blockFromSelection,
  edgeSourceKind,
  replaceBlock,
  ungroupBlock,
} from "../../lib/studio/workflow/blocks";
import { writtenGraph } from "../../lib/studio/workflow/flatten";
import { flatTargets, liftResults } from "../../lib/studio/workflow/lift";
import { readSpendCeiling } from "../../lib/studio/workflow/spend-ceiling";
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
  type StudioFlowNode,
  type StudioNodeData,
  SAVE_DEBOUNCE_MS,
  toFlowNodes,
  toFlowEdges,
  canConnect,
  toWorkflowEdge,
  modelChangeNotice,
  openNotice,
} from "./workflow/flow";
import { type StudioEdgeData, EDGE_TYPES } from "./workflow/StudioEdge";
import type { FrameFlowNode } from "./workflow/FrameNode";
import { NODE_TYPES } from "./workflow/StudioNode";
import { costSummary, RunCostDialog } from "./workflow/RunCostDialog";
import { ARRANGE_GAP, ArrangePopover } from "./workflow/ArrangePopover";
import { NodeSearch } from "./workflow/NodeSearch";
import { RunBanners } from "./workflow/RunBanners";
import { RunHistoryPanel } from "./workflow/RunHistoryPanel";
import { SelectionToolbar } from "./workflow/SelectionToolbar";
import { useCanvasEditing } from "./workflow/useCanvasEditing";
import { stepBoxes, useFrames } from "./workflow/useFrames";
import { useNodeDataSync } from "./workflow/useNodeDataSync";
import { BlockBreadcrumb } from "./workflow/BlockBreadcrumb";
import { BlockPanel } from "./workflow/BlockPanel";
import { composeRoot, useBlockScope, withLevel } from "./workflow/useBlockScope";
import { useRunPicture } from "./workflow/useRunPicture";

/**
 * The Workflows tab. The library is read before anything is drawn: an editor
 * that rendered on an empty cache would seed a first workflow over the ones
 * already stored (ADR-0075).
 */
export function WorkflowStudio({
  catalog,
  pendingWorkflowId,
  onPendingWorkflowOpened,
}: {
  catalog: MediaCatalog;
  /** A workflow to open, asked for from elsewhere (the gallery). */
  pendingWorkflowId?: string;
  onPendingWorkflowOpened?: () => void;
}) {
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
  return (
    <WorkflowEditor
      catalog={catalog}
      pendingWorkflowId={pendingWorkflowId}
      onPendingWorkflowOpened={onPendingWorkflowOpened}
    />
  );
}

function WorkflowEditor({
  catalog,
  pendingWorkflowId,
  onPendingWorkflowOpened,
}: {
  catalog: MediaCatalog;
  pendingWorkflowId?: string;
  onPendingWorkflowOpened?: () => void;
}) {
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

  const onModeChange = useCallback((id: string, mode: "bypass" | "mute" | undefined) => {
    setFlowNodes((nodes) =>
      nodes.map((node) => {
        if (node.id !== id) return node;
        const { mode: _previous, ...rest } = node.data.wfNode;
        return { ...node, data: { ...node.data, wfNode: mode ? { ...rest, mode } : rest } };
      }),
    );
  }, []);

  const { frames, setFrames, frameNodes, takeFrameChanges, frameSelection } = useFrames({
    readOnly: Boolean(current?.readOnly),
    flowNodesRef,
    setFlowNodes,
    onModeChange,
  });

  const onLayoutChange = useCallback(
    (id: string, change: Partial<Pick<WorkflowNode, "collapsed" | "pinned" | "color">>) => {
      setFlowNodes((nodes) =>
        nodes.map((node) => {
          if (node.id !== id) return node;
          const wfNode = { ...node.data.wfNode, ...change };
          for (const key of ["collapsed", "pinned", "color"] as const) {
            if (wfNode[key] === undefined || wfNode[key] === false) delete wfNode[key];
          }
          return {
            ...node,
            draggable: !wfNode.pinned,
            data: { ...node.data, wfNode },
          };
        }),
      );
    },
    [],
  );

  const onRemove = useCallback((id: string) => {
    setFlowNodes((nodes) => nodes.filter((node) => node.id !== id));
    setFlowEdges((edges) => edges.filter((edge) => edge.source !== id && edge.target !== id));
  }, []);

  /** Put a graph on the canvas afresh: its steps and wires, no results. */
  const draw = useCallback(
    (workflow: Workflow) => {
      setFlowNodes(
        toFlowNodes(
          workflow,
          catalogRef.current,
          artifacts,
          new Map(),
          onParamsChange,
          onRename,
          onRemove,
          onApproveGate,
        ),
      );
      setFlowEdges(toFlowEdges(workflow));
    },
    [artifacts, onParamsChange, onRename, onRemove, onApproveGate],
  );
  /** The level shown: the workflow, or inside a block step (ADR-0116). */
  const blockScope = useBlockScope({
    currentRef,
    setCurrent,
    setFrames,
    draw,
    // A block of two steps drawn at three times their size reads as broken.
    fitView: () => void flowRef.current?.fitView({ duration: 250, maxZoom: 1 }),
  });

  // (Re)hydrate the canvas whenever another workflow is selected.
  const hydrate = useCallback(
    (stored: Workflow | undefined) => {
      // Brought forward on open (renamed steps, reshaped settings); a newer
      // version's workflow is shown as it was written.
      const workflow = stored && !stored.readOnly ? migrateWorkflow(stored) : stored;
      blockScope.reset();
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
      setFrames(opened?.frames ?? []);
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
    [
      catalog,
      artifacts,
      onParamsChange,
      onRename,
      onRemove,
      onApproveGate,
      setFrames,
      blockScope.reset,
    ],
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

  const drawn = current
    ? composeRoot(current, blockScope.scope, flowNodes, flowEdges, frames)
    : undefined;
  const drawnKey = drawn ? stableJson(drawn) : "";
  /** The graph as drawn, the same object for as long as it says the same
   * thing: refreshing what the steps show (prices, issues, reuse) must not
   * read as an edit, or that refresh would feed itself without end. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: drawnKey stands in for the graph.
  const serialized = useMemo(() => drawn, [drawnKey]);

  // Debounced persistence of every change (drag, edit, connect, rename),
  // inside a block too: what is saved is always the whole workflow.
  useEffect(() => {
    if (!serialized || serialized.readOnly) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      // Opening a workflow redraws its canvas; that is not an edit, and
      // saving it would move the card to the top with today's date.
      const stored = listWorkflows().find((entry) => entry.id === serialized.id);
      if (stored && sameWorkflow(stored, serialized)) return;
      saveWorkflow(serialized);
      currentRef.current = serialized;
      setWorkflows(listWorkflows());
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(saveTimer.current);
  }, [serialized]);
  /** Bumped when a run ends, so the cache is asked again what it now holds. */
  const [runEpoch, setRunEpoch] = useState(0);
  const {
    effective,
    validation,
    reused,
    reusedShown,
    liveQuotes,
    estimate,
    priceByNode,
    issuesByNode,
    stepView,
  } = useRunPicture(serialized, catalog, runEpoch, blockScope.path);
  /** What the run made, with each block step's own (lift.ts). */
  const shownResults = useMemo(
    () => (stepView ? liftResults(results, stepView) : results),
    [results, stepView],
  );
  /** Put a block step's steps back, or go inside it; retargeted each
   * render (they need the graph). */
  const ungroupRef = useRef<(nodeId: string) => void>(() => {});
  const onUngroup = useCallback((nodeId: string) => ungroupRef.current(nodeId), []);
  const openBlockRef = useRef<(nodeId: string) => void>(() => {});
  const onOpenBlock = useCallback((nodeId: string) => openBlockRef.current(nodeId), []);
  /** Hovering Run lights up the steps that will spend. */
  const [hoverRun, setHoverRun] = useState(false);

  /** "Run this step", with a stable identity for node data; retargeted at
   * every render to the current run handler. */
  const runStepRef = useRef<(nodeId: string) => void>(() => {});
  const onRunStep = useCallback((nodeId: string) => runStepRef.current(nodeId), []);

  useNodeDataSync({
    setFlowNodes,
    flowEdges,
    results: shownResults,
    reusedShown,
    issuesByNode,
    priceByNode,
    hoverRun,
    catalog,
    artifacts,
    constraintEpoch,
    blocks: serialized?.blocks,
    onRunStep,
    onModeChange,
    onLayoutChange,
    onReorderEdge,
    onHighlightEdge,
    onApplyChainOrder,
    onUngroup,
    onOpenBlock,
  });

  const onNodesChange = useCallback(
    (changes: NodeChange<StudioFlowNode | FrameFlowNode>[]) => {
      const steps = takeFrameChanges(changes);
      if (steps.length > 0) setFlowNodes((nodes) => applyNodeChanges(steps, nodes));
    },
    [takeFrameChanges],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => setFlowEdges((edges) => applyEdgeChanges(changes, edges)),
    [],
  );
  const onConnect = useCallback((connection: Connection) => {
    setFlowEdges((edges) => addEdge(connection, edges));
  }, []);

  /** Connections must land on a port that accepts the source's kind and still
   * has room. What this rejects, the validator would flag anyway — refusing
   * the drop is just the earlier, kinder place to say no. */
  const isValidConnection = useCallback(
    (connection: Connection | FlowEdge) =>
      canConnect(
        {
          nodes: flowNodes.map((node) => node.data.wfNode),
          edges: flowEdges.map(toWorkflowEdge),
          blocks: current?.blocks,
        },
        connection,
      ),
    [flowNodes, flowEdges, current?.blocks],
  );

  const addNode = useCallback(
    (
      type: WorkflowNodeType,
      at?: { x: number; y: number },
      extraParams?: Record<string, unknown>,
    ): string => {
      const offset = flowNodes.length;
      const wfNode: WorkflowNode = {
        id: crypto.randomUUID(),
        type,
        // Unnamed: the type shows through as a placeholder until the user
        // gives it one, which is what keeps "never named" tellable.
        label: "",
        // Where it was asked for (the search opens where the pointer was);
        // from the toolbar list, stepped down from the top left.
        position: at ?? { x: 80 + (offset % 4) * 60, y: 80 + offset * 40 },
        params: { ...defaultParams(type), ...extraParams },
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
      return wfNode.id;
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

  /** Which steps are being made right now, as a stable key. */
  const runningKey = [...shownResults.values()]
    .filter((result) => result.status === "running")
    .map((result) => result.nodeId)
    .sort()
    .join("|");
  const removeEdge = useCallback((edgeId: string) => {
    setFlowEdges((edges) => edges.filter((edge) => edge.id !== edgeId));
  }, []);

  /** Connection-order badges: edges into a multi port with two or more
   * connections carry their 1-based position; everything else stays bare. */
  // orderGraphKey stands in for the step list the memo reads from its ref:
  // order and kinds only depend on the parts of it the key captures.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
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
    const blockGraph = { ...graph, blocks: current?.blocks };
    const runningNow = new Set(runningKey.split("|"));
    return flowEdges.map((edge) => {
      return {
        ...edge,
        type: "studio" as const,
        // A wire moves only while the step it feeds is being made: an
        // always-animated canvas is motion seen a hundred times a day.
        animated: runningNow.has(edge.target),
        data: {
          order: orders.get(edge.id),
          sourceRank: sourceRanks.get(edge.id),
          highlight: edge.id === highlightedEdge,
          kind: edgeSourceKind(
            { source: edge.source, sourcePort: edge.sourceHandle ?? undefined },
            blockGraph,
          ),
          onDelete: current?.readOnly ? undefined : removeEdge,
        } satisfies StudioEdgeData,
      };
    });
  }, [
    flowEdges,
    orderGraphKey,
    highlightedEdge,
    runningKey,
    current?.readOnly,
    current?.blocks,
    removeEdge,
  ]);
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
      const runnable =
        effective && targets && stepView
          ? pruneToTargets(effective, flatTargets(targets, stepView))
          : effective;
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
          beforeNode: spendGuard(priced, { unpriced: "allow", ceiling: readSpendCeiling() }),
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
    [effective, stepView, running, mirrorUpdate],
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
      if (!effective || !stepView || running || quoting) return;
      const resolved = effective;
      const flat = targets ? flatTargets(targets, stepView) : undefined;
      if (flat && !flat.some((id) => resolved.nodes.some((node) => node.id === id))) {
        setRunError(t("This step is set aside, so it does not run."));
        return;
      }
      const runnable = flat ? pruneToTargets(resolved, flat) : resolved;
      // Only what will run has to be valid: a broken step elsewhere does
      // not block running this one.
      const check = validateWorkflow(runnable);
      if (!check.ok) {
        const first = check.errors[0];
        setRunError(first?.message ?? t("The workflow is invalid."));
        if (first?.nodeId) locateNode(first.nodeId);
        return;
      }
      const staticEstimate = withReusedSteps(
        estimateWorkflowCost(runnable, catalog, liveQuotes),
        reused,
      );
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
    [effective, stepView, running, quoting, catalog, run, reused, locateNode, liveQuotes],
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

  // Asked from elsewhere (the gallery): open that workflow, or say it is gone.
  useEffect(() => {
    if (!pendingWorkflowId) return;
    const found = listWorkflows().find((entry) => entry.id === pendingWorkflowId);
    if (found) openWorkflow(found);
    else setRunError(t("The workflow that made this file has been deleted."));
    onPendingWorkflowOpened?.();
  }, [pendingWorkflowId, openWorkflow, onPendingWorkflowOpened]);

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
      // A run with blocks froze the graph as written too (flatten.ts).
      const written = writtenGraph(definition);
      hydrate({
        ...base,
        nodes: (written ?? definition).nodes,
        edges: (written ?? definition).edges,
        ...(written ? { blocks: written.blocks } : {}),
      });
      setResults(past);
    },
    [hydrate],
  );

  /** The canvas's own editing: undo, clipboard, shortcuts, palette. */
  const startRunRef = useRef(startRun);
  startRunRef.current = startRun;
  /** A whole graph from the undo history: the workflow as it was, shown at
   * the level the canvas is on when that level still exists. */
  const applyGraph = useCallback(
    (graph: {
      nodes: WorkflowNode[];
      edges: WorkflowEdge[];
      frames?: WorkflowFrame[];
      blocks?: WorkflowBlock[];
    }) => {
      const base = currentRef.current;
      if (!base) return;
      const { blocks: _blocks, frames: _frames, ...rest } = base;
      blockScope.applyRoot({
        ...rest,
        nodes: graph.nodes,
        edges: graph.edges,
        ...(graph.frames?.length ? { frames: graph.frames } : {}),
        ...(graph.blocks?.length ? { blocks: graph.blocks } : {}),
      });
    },
    [blockScope.applyRoot],
  );
  /** The block whose inside the canvas shows, if any. */
  const insideBlock = serialized?.blocks?.find(
    (block) => block.id === blockScope.scope.at(-1)?.blockId,
  );
  /** The level the canvas shows, as a graph an edit can work on. */
  const levelGraph = () => ({
    nodes: flowNodesRef.current.map((node) => node.data.wfNode),
    edges: flowEdges.map(toWorkflowEdge),
    blocks: serialized?.blocks,
  });
  /** The selected steps as one block step (⇧⌘E), and a block step's steps
   * put back. Both edit the workflow as a whole, so undo takes them back. */
  const makeBlock = () => {
    const ids = new Set(
      flowNodesRef.current.filter((node) => node.selected).map((node) => node.id),
    );
    const name = t("Block {count}", { count: (serialized?.blocks?.length ?? 0) + 1 });
    const made = blockFromSelection(levelGraph(), ids, name);
    if (made && serialized)
      blockScope.applyRoot(withLevel(serialized, blockScope.scope, made.graph));
  };
  ungroupRef.current = (nodeId) => {
    const next = ungroupBlock(levelGraph(), nodeId);
    if (next && serialized) blockScope.applyRoot(withLevel(serialized, blockScope.scope, next));
  };
  openBlockRef.current = (nodeId) => {
    const step = flowNodesRef.current.find((node) => node.id === nodeId)?.data.wfNode;
    const blockId = step?.type === "block" ? String(step.params.blockId) : "";
    if (serialized?.blocks?.some((block) => block.id === blockId))
      blockScope.enter(serialized, nodeId, blockId);
  };
  const openSearchRef = useRef<(x: number, y: number) => void>(() => {});
  const editing = useCanvasEditing({
    active: view === "canvas" && current !== undefined && !current.readOnly,
    workflowId: current?.id,
    graph: serialized,
    canvasGraph:
      blockScope.scope.length > 0
        ? {
            nodes: flowNodes.map((node) => node.data.wfNode),
            edges: flowEdges.map(toWorkflowEdge),
            blocks: serialized?.blocks,
          }
        : undefined,
    selectedIds: () =>
      new Set(flowNodesRef.current.filter((node) => node.selected).map((node) => node.id)),
    applyGraph,
    addSteps: (graph) => {
      const base = currentRef.current;
      if (!base) return;
      // Pasted block steps bring their blocks, unless this workflow has them.
      const known = new Set((base.blocks ?? []).map((block) => block.id));
      const brought = (graph.blocks ?? []).filter((block) => !known.has(block.id));
      if (brought.length > 0) {
        const next = { ...base, blocks: [...(base.blocks ?? []), ...brought] };
        currentRef.current = next;
        setCurrent(next);
      }
      const added = toFlowNodes(
        { ...base, nodes: graph.nodes, edges: graph.edges },
        catalogRef.current,
        artifacts,
        new Map(),
        onParamsChange,
        onRename,
        onRemove,
        onApproveGate,
      ).map((node) => ({ ...node, selected: true }));
      setFlowNodes((nodes) => [...nodes.map((node) => ({ ...node, selected: false })), ...added]);
      setFlowEdges((edges) => [
        ...edges,
        ...toFlowEdges({ ...base, nodes: [...base.nodes, ...graph.nodes], edges: graph.edges }),
      ]);
    },
    selectAll: () => setFlowNodes((nodes) => nodes.map((node) => ({ ...node, selected: true }))),
    removeSteps: (ids) => {
      setFlowNodes((nodes) => nodes.filter((node) => !ids.has(node.id)));
      setFlowEdges((edges) =>
        edges.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target)),
      );
    },
    fitView: () => void flowRef.current?.fitView({ duration: 250 }),
    run: () => void startRunRef.current(),
    toggleHistory: () => setHistoryOpen((open) => !open),
    frameSelection,
    makeBlock,
    openSearch: () => {
      const box = canvasRef.current?.getBoundingClientRect();
      if (box) openSearchRef.current(box.left + box.width / 2 - 128, box.top + 80);
    },
  });

  /** The step search, where it opened, and the connection it continues. */
  const [search, setSearch] = useState<
    | {
        at: { x: number; y: number };
        flow: { x: number; y: number };
        link?: { nodeId: string; handle: "source" | "target"; port?: string; filter: LinkFilter };
      }
    | undefined
  >(undefined);
  const canvasRef = useRef<HTMLDivElement>(null);
  const openSearch = useCallback(
    (clientX: number, clientY: number, link?: NonNullable<typeof search>["link"]) => {
      const box = canvasRef.current?.getBoundingClientRect();
      const flow = flowRef.current?.screenToFlowPosition({ x: clientX, y: clientY }) ?? {
        x: 80,
        y: 80,
      };
      setSearch({
        at: { x: clientX - (box?.left ?? 0), y: clientY - (box?.top ?? 0) },
        flow,
        link,
      });
    },
    [],
  );
  const pickFromSearch = useCallback(
    (hit: NodeSearchHit) => {
      const opened = search;
      setSearch(undefined);
      if (!opened) return;
      const id = addNode(hit.type, opened.flow, hit.params);
      const link = opened.link;
      if (!link) return;
      if (link.handle === "source" && link.filter.from === "output") {
        const created = { type: hit.type, params: { ...defaultParams(hit.type), ...hit.params } };
        const port = resolveInputPort(created, {}, link.filter.kind);
        if (!port) return;
        setFlowEdges((edges) =>
          addEdge(
            { source: link.nodeId, target: id, sourceHandle: null, targetHandle: port.id },
            edges,
          ),
        );
      } else if (link.handle === "target") {
        setFlowEdges((edges) =>
          addEdge(
            {
              source: id,
              target: link.nodeId,
              sourceHandle: null,
              targetHandle: link.port ?? null,
            },
            edges,
          ),
        );
      }
    },
    [search, addNode],
  );
  openSearchRef.current = (x, y) => openSearch(x, y);
  /** A connection let go over empty canvas opens the search for what fits. */
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid || !state.fromNode || !state.fromHandle) return;
      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      const from = flowNodesRef.current.find((node) => node.id === state.fromNode?.id)?.data.wfNode;
      if (!from || !point) return;
      if (state.fromHandle.type === "source") {
        const kind = outputKindOf(from, {
          nodeById: new Map(flowNodesRef.current.map((node) => [node.id, node.data.wfNode])),
          edges: flowEdgesRef.current.map(toWorkflowEdge),
        });
        // Let go on a step's body rather than on one of its inputs: it lands
        // on the input that takes what the connection carries.
        const onto = state.toNode
          ? flowNodesRef.current.find((node) => node.id === state.toNode?.id)?.data.wfNode
          : undefined;
        if (onto && onto.id !== from.id) {
          const port = resolveInputPort(onto, {}, kind);
          const connection = {
            source: from.id,
            target: onto.id,
            sourceHandle: null,
            targetHandle: port?.id ?? null,
          };
          if (port && isValidConnection(connection)) {
            setFlowEdges((edges) => addEdge(connection, edges));
          }
          return;
        }
        openSearch(point.clientX, point.clientY, {
          nodeId: from.id,
          handle: "source",
          filter: { from: "output", kind },
        });
      } else {
        const schema = maybeNodeSchema(from.type);
        const port = schema
          ? openInputPorts(schema, from.params).find((entry) => entry.id === state.fromHandle?.id)
          : undefined;
        if (!port) return;
        openSearch(point.clientX, point.clientY, {
          nodeId: from.id,
          handle: "target",
          port: port.id,
          filter: { from: "input", kind: port.kind },
        });
      }
    },
    [openSearch, isValidConnection],
  );

  /** Frames behind, steps in front. */
  const canvasNodes = useMemo(() => [...frameNodes, ...flowNodes], [frameNodes, flowNodes]);
  /** The selected steps, for the bar over them. */
  const selectedIds = flowNodes.filter((node) => node.selected).map((node) => node.id);
  const allSetAside =
    selectedIds.length > 0 &&
    flowNodes.filter((node) => node.selected).every((node) => node.data.wfNode.mode);
  const moveNodes = useCallback((moved: Map<string, { x: number; y: number }>) => {
    if (moved.size === 0) return;
    setFlowNodes((nodes) =>
      nodes.map((node) => {
        const to = moved.get(node.id);
        return to
          ? {
              ...node,
              position: to,
              data: { ...node.data, wfNode: { ...node.data.wfNode, position: to } },
            }
          : node;
      }),
    );
  }, []);
  const boxesOf = useCallback(
    (ids: string[]) => stepBoxes(flowNodesRef.current.filter((node) => ids.includes(node.id))),
    [],
  );
  /** Arrange: the positions before it started, and the gap being tried. */
  const [arranging, setArranging] = useState<
    { before: Map<string, { x: number; y: number }>; gap: number } | undefined
  >(undefined);
  const arrangeWith = useCallback(
    (gap: number) => {
      const ids = flowNodesRef.current.map((node) => node.id);
      moveNodes(layered(boxesOf(ids), flowEdgesRef.current, gap));
    },
    [moveNodes, boxesOf],
  );
  const startArranging = useCallback(() => {
    const before = new Map(
      flowNodesRef.current.map((node) => [node.id, { ...node.position }] as const),
    );
    setArranging({ before, gap: ARRANGE_GAP.initial });
    arrangeWith(ARRANGE_GAP.initial);
    window.setTimeout(() => void flowRef.current?.fitView({ duration: 250 }), 0);
  }, [arrangeWith]);

  /** Shift held while dragging snaps steps to the grid. */
  const [snapping, setSnapping] = useState(false);
  useEffect(() => {
    const watch = (event: KeyboardEvent) => setSnapping(event.shiftKey);
    window.addEventListener("keydown", watch);
    window.addEventListener("keyup", watch);
    return () => {
      window.removeEventListener("keydown", watch);
      window.removeEventListener("keyup", watch);
    };
  }, []);

  const productionBanners = (
    <RunBanners
      running={running}
      liveProductions={liveProductions}
      resumable={resumable}
      dismissResumable={dismissResumable}
      resume={resume}
    />
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
        <button
          type="button"
          className="studio-icon-button"
          aria-label={t("Undo")}
          title={t("Undo (⌘Z)")}
          disabled={current?.readOnly === true}
          onClick={editing.undo}
        >
          <IconArrowUndoUp size={16} />
        </button>
        <button
          type="button"
          className="studio-icon-button"
          aria-label={t("Redo")}
          title={t("Redo (⇧⌘Z)")}
          disabled={current?.readOnly === true}
          onClick={editing.redo}
        >
          <IconArrowRedoDown size={16} />
        </button>
        <Select
          value={null}
          placeholder={t("Add node")}
          ariaLabel={t("Add a node")}
          onChange={(type) => addNode(type as WorkflowNodeType)}
          options={Object.values(NODE_SCHEMAS)
            .filter((schema) => schema.type !== "block")
            .map((schema) => ({ value: schema.type, label: nodeTypeLabel(schema.type) }))}
        />
        <button
          type="button"
          className="btn btn-secondary"
          aria-pressed={arranging !== undefined}
          disabled={!current || current.readOnly === true || flowNodes.length < 2}
          onClick={() => (arranging ? setArranging(undefined) : startArranging())}
        >
          {t("Arrange")}
        </button>
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
            onPointerEnter={() => setHoverRun(true)}
            onPointerLeave={() => setHoverRun(false)}
            onFocus={() => setHoverRun(true)}
            onBlur={() => setHoverRun(false)}
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
      {current && blockScope.scope.length > 0 ? (
        <BlockBreadcrumb
          workflowName={current.name}
          scope={blockScope.scope}
          blocks={serialized?.blocks}
          onLeave={(depth) => serialized && blockScope.leave(serialized, depth)}
        />
      ) : null}
      {insideBlock && serialized && !current?.readOnly ? (
        <BlockPanel
          block={insideBlock}
          onChange={(next) => {
            // The block's face only: its steps stay on the canvas as they are.
            const root = replaceBlock(serialized, next);
            currentRef.current = root;
            setCurrent(root);
          }}
        />
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
        ref={canvasRef}
        className="studio-workflow-canvas"
        data-readonly={current?.readOnly ? "true" : undefined}
      >
        {arranging ? (
          <ArrangePopover
            gap={arranging.gap}
            onGap={(gap) => {
              setArranging((state) => (state ? { ...state, gap } : state));
              arrangeWith(gap);
            }}
            onDone={() => setArranging(undefined)}
            onCancel={() => {
              moveNodes(arranging.before);
              setArranging(undefined);
            }}
          />
        ) : null}
        {search ? (
          <NodeSearch
            at={search.at}
            filter={search.link?.filter}
            onPick={pickFromSearch}
            onClose={() => setSearch(undefined)}
          />
        ) : null}
        <ReactFlow<StudioFlowNode | FrameFlowNode>
          nodes={canvasNodes}
          // A selected frame stays behind the steps it holds.
          elevateNodesOnSelect={false}
          edges={displayEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onConnectEnd={onConnectEnd}
          onReconnect={(oldEdge, connection) =>
            setFlowEdges((edges) => reconnectEdge(oldEdge, connection, edges))
          }
          // Far enough out to see a production of a hundred steps whole,
          // drawn compact below half size (StudioNode).
          minZoom={0.15}
          snapToGrid={snapping}
          snapGrid={[16, 16]}
          onPaneClick={(event) => {
            // The second click of a double-click on empty canvas opens the
            // step search there.
            if (event.detail === 2 && !current?.readOnly) openSearch(event.clientX, event.clientY);
          }}
          zoomOnDoubleClick={false}
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
          <MiniMap
            pannable
            zoomable
            ariaLabel={t("Overview of the workflow")}
            nodeClassName={(node) => {
              if (node.type === "frame") return "minimap-frame";
              const status = results.get(node.id)?.status;
              const mode = (node.data as StudioNodeData | undefined)?.wfNode.mode;
              return mode
                ? "minimap-set-aside"
                : status === "error"
                  ? "minimap-error"
                  : status === "running"
                    ? "minimap-running"
                    : (node.data as StudioNodeData | undefined)?.willReuse ||
                        results.get(node.id)?.reused
                      ? "minimap-reused"
                      : "minimap-step";
            }}
          />
          <SelectionToolbar
            selected={selectedIds}
            allSetAside={allSetAside}
            allPinned={
              selectedIds.length > 0 &&
              flowNodes.filter((node) => node.selected).every((node) => node.data.wfNode.pinned)
            }
            onLayout={(change) => {
              for (const id of selectedIds) onLayoutChange(id, change);
            }}
            onRun={() => void startRun(selectedIds)}
            onSetAside={(mode) => {
              for (const id of selectedIds) onModeChange(id, mode);
            }}
            onDuplicate={editing.duplicate}
            onFrame={frameSelection}
            onMakeBlock={makeBlock}
            onAlign={(to) => moveNodes(align(boxesOf(selectedIds), to))}
            onDistribute={() => {
              const boxes = boxesOf(selectedIds);
              const width =
                Math.max(...boxes.map((box) => box.x)) - Math.min(...boxes.map((box) => box.x));
              const height =
                Math.max(...boxes.map((box) => box.y)) - Math.min(...boxes.map((box) => box.y));
              moveNodes(distribute(boxes, width >= height ? "horizontal" : "vertical"));
            }}
            onDelete={() => {
              const ids = new Set(selectedIds);
              setFlowNodes((nodes) => nodes.filter((node) => !ids.has(node.id)));
              setFlowEdges((edges) =>
                edges.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target)),
              );
            }}
          />
        </ReactFlow>
      </div>
    </div>
  );
}
