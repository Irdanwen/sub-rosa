// Workflow studio: a node canvas over lib/studio/workflow. The declarative
// node schemas drive everything here — the palette, each node's mini form,
// its input ports, and connection compatibility — so adding a node type to
// the lib lights it up in the UI without canvas changes. Runs execute level
// by level with live per-node status; produced media lands in the gallery at
// the node that made it, with real provenance and chain links.

import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
  ReactFlow,
  useStore,
  type Connection,
  type Edge as FlowEdge,
  type EdgeChange,
  type EdgeProps,
  type Node as FlowNode,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { IconArrowDown } from "central-icons/IconArrowDown";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatCredits } from "../../lib/studio/catalog";
import { referenceMention } from "../../lib/studio/seedance";
import type { ArtifactKind, MediaCatalog } from "../../lib/studio/types";
import {
  activeWorkflowRuns,
  dismissWorkflowRun,
  listResumableRuns,
  resumeWorkflowRun,
  runAndSaveWorkflow,
  type WorkflowRunSummary,
} from "../../lib/studio/workflow-run";
import {
  applyPortOrder,
  chainOrderSuggestion,
  createWorkflow,
  defaultParams,
  deleteWorkflow,
  edgesOnPort,
  estimateNodeCost,
  estimateWorkflowCost,
  fetchVideoQuotes,
  isInputCompatible,
  listWorkflows,
  maybeNodeSchema,
  modelsForParam,
  needsRunConfirmation,
  NODE_SCHEMAS,
  nodeCostMap,
  nodeSchema,
  outputKindOf,
  portCapacity,
  reorderPortEdge,
  resolveInputPort,
  saveWorkflow,
  templateWorkflows,
  validateWorkflow,
  WorkflowRunError,
  type NodeRunResult,
  type ParamSchema,
  type Workflow,
  type WorkflowCostEstimate,
  type WorkflowNode,
  type WorkflowNodeType,
} from "../../lib/studio/workflow";
import { Dialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { Switch } from "../ui/Switch";
import { GalleryPicker } from "./GalleryPicker";
import { NotePicker } from "./NotePicker";

/** One connection into a multi port, as the ordering list shows it. */
interface PortSourceEntry {
  edgeId: string;
  sourceId: string;
  label: string;
  /** A small preview when the source has produced an image this run. */
  image?: string;
}

interface StudioNodeData extends Record<string, unknown> {
  wfNode: WorkflowNode;
  catalog: MediaCatalog;
  result?: NodeRunResult;
  onParamsChange: (id: string, params: Record<string, unknown>) => void;
  onRemove: (id: string) => void;
  /** Gate nodes only: the upstream candidates an approval can pick from. */
  gateSources?: Array<{ id: string; label: string }>;
  /** Gate nodes only: decide this gate and continue the held production. */
  onApproveGate?: (gateId: string, choice: string | undefined) => void;
  /** Multi ports with two or more connections: their sources, in order. */
  portSources?: Record<string, PortSourceEntry[]>;
  /** Move one connection up or down within its port's order. */
  onReorderEdge?: (edgeId: string, delta: -1 | 1) => void;
  /** Assemble nodes only: apply the graph's chain order to the clips port. */
  chainSuggestion?: string[];
  onApplyChainOrder?: (nodeId: string, orderedEdgeIds: string[]) => void;
}

type StudioFlowNode = FlowNode<StudioNodeData, "studio">;

/** How far out the canvas can zoom before the order badges become noise.
 * A fit-to-view of a production-sized graph sits around 0.6-0.8, and the
 * badges must be there in that default state — they only vanish once the
 * nodes themselves have shrunk past reading. */
const EDGE_ORDER_MIN_ZOOM = 0.45;

/** The default bezier edge plus a connection-order badge pinned at the port
 * end. The badge only exists on edges into a multi port with two or more
 * connections, and fades out when the canvas is zoomed too far to wire. */
function StudioEdge(props: EdgeProps) {
  const [path] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });
  const zoom = useStore((state) => state.transform[2]);
  const order = (props.data as { order?: number } | undefined)?.order;
  return (
    <>
      <BaseEdge id={props.id} path={path} style={props.style} markerEnd={props.markerEnd} />
      {order !== undefined && zoom >= EDGE_ORDER_MIN_ZOOM ? (
        <EdgeLabelRenderer>
          <span
            className="studio-edge-order"
            style={{
              // Edges of one port share a handle, so a fixed offset would
              // stack every badge on the same pixel. Stagger them along the
              // arrival tangent instead: 1 sits closest to the port, 2 behind
              // it — the row reads like the port's ordered list.
              transform: `translate(-50%, -50%) translate(${
                props.targetX - 18 - (order - 1) * 18
              }px, ${props.targetY}px)`,
            }}
          >
            {order}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const EDGE_TYPES = { studio: StudioEdge };

const SAVE_DEBOUNCE_MS = 300;

function toFlowNodes(
  workflow: Workflow,
  catalog: MediaCatalog,
  results: Map<string, NodeRunResult>,
  onParamsChange: (id: string, params: Record<string, unknown>) => void,
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
      result: results.get(node.id),
      onParamsChange,
      onRemove,
      onApproveGate,
      gateSources:
        node.type === "gate"
          ? workflow.edges
              .filter((edge) => edge.target === node.id)
              .map((edge) => nodeById.get(edge.source))
              .filter((source): source is WorkflowNode => source !== undefined)
              .map((source) => ({ id: source.id, label: source.label || source.type }))
          : undefined,
    },
  }));
}

/** Edges land on named handles. Portless edges (saved before ports existed)
 * are displayed on the port they actually resolve to, so what the canvas
 * shows is what the engine will do; the next save makes it explicit. */
function toFlowEdges(workflow: Workflow): FlowEdge[] {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const kindContext = { nodeById, edges: workflow.edges };
  return workflow.edges.map((edge) => {
    let port = edge.targetPort;
    if (port === undefined) {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      const schema = target ? maybeNodeSchema(target.type) : undefined;
      if (source && schema) {
        port = resolveInputPort(schema, edge, outputKindOf(source, kindContext))?.id;
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

function toWorkflowEdge(edge: FlowEdge) {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    targetPort: edge.targetHandle ?? undefined,
  };
}

function fromFlow(base: Workflow, nodes: StudioFlowNode[], edges: FlowEdge[]): Workflow {
  return {
    ...base,
    nodes: nodes.map((node) => ({
      ...node.data.wfNode,
      position: { x: node.position.x, y: node.position.y },
    })),
    edges: edges.map(toWorkflowEdge),
  };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

/** Gallery buckets an asset node's picker should offer for its chosen kind. */
function assetPickerKinds(node: WorkflowNode): ArtifactKind[] {
  const kind = node.params.assetKind;
  if (kind === "video") return ["video"];
  if (kind === "audio") return ["music", "speech", "sfx"];
  return ["image"];
}

function ParamField({
  node,
  param,
  catalog,
  onMerge,
}: {
  node: WorkflowNode;
  param: ParamSchema;
  catalog: MediaCatalog;
  onMerge: (partial: Record<string, unknown>) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const value = node.params[param.name];
  if (param.type === "model") {
    const models = modelsForParam(catalog, param);
    return (
      <select
        className="studio-native-select nodrag"
        value={typeof value === "string" ? value : ""}
        aria-label={param.label}
        onChange={(event) => onMerge({ [param.name]: event.target.value })}
      >
        <option value="">Choose a model</option>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
    );
  }
  if (param.type === "artifact") {
    const label = stringOr(node.params.assetLabel, "");
    return (
      <>
        <button
          type="button"
          className="studio-node-picker nodrag"
          onClick={() => setPickerOpen(true)}
        >
          {label || "Choose from the gallery"}
        </button>
        {pickerOpen ? (
          <GalleryPicker
            kinds={assetPickerKinds(node)}
            resolveData={false}
            title="Pick an asset"
            description="This item feeds every node the asset connects to."
            onPick={(_, artifact) =>
              onMerge({
                [param.name]: artifact.id,
                assetLabel: artifact.prompt || artifact.fileName,
              })
            }
            onClose={() => setPickerOpen(false)}
          />
        ) : null}
      </>
    );
  }
  if (param.type === "note") {
    const label = stringOr(node.params.noteTitle, "");
    return (
      <>
        <button
          type="button"
          className="studio-node-picker nodrag"
          onClick={() => setPickerOpen(true)}
        >
          {label || "Choose a note"}
        </button>
        {pickerOpen ? (
          <NotePicker
            onPick={(note) =>
              onMerge({ [param.name]: note.id, noteTitle: note.title || "Untitled note" })
            }
            onClose={() => setPickerOpen(false)}
          />
        ) : null}
      </>
    );
  }
  if (param.type === "text") {
    return (
      <textarea
        className="studio-textarea nodrag nowheel"
        rows={2}
        value={typeof value === "string" ? value : ""}
        placeholder={param.label}
        aria-label={param.label}
        onChange={(event) => onMerge({ [param.name]: event.target.value })}
      />
    );
  }
  if (param.type === "boolean") {
    return (
      <div className="studio-node-switch nodrag">
        <span className="studio-node-kind">{param.label}</span>
        <Switch
          checked={value === true}
          onCheckedChange={(checked) => onMerge({ [param.name]: checked })}
          aria-label={param.label}
        />
      </div>
    );
  }
  if (param.type === "enum") {
    return (
      <select
        className="studio-native-select nodrag"
        value={typeof value === "string" ? value : String(param.default ?? "")}
        aria-label={param.label}
        onChange={(event) => {
          // Switching an asset's kind invalidates the picked item.
          if (node.type === "asset" && param.name === "assetKind") {
            onMerge({ assetKind: event.target.value, artifactId: "", assetLabel: "" });
            return;
          }
          onMerge({ [param.name]: event.target.value });
        }}
      >
        {(param.enumValues ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (param.type === "number") {
    return (
      <input
        className="studio-input nodrag"
        type="number"
        min={param.min}
        max={param.max}
        step={param.step}
        value={typeof value === "number" ? value : ""}
        placeholder={param.label}
        aria-label={param.label}
        onChange={(event) =>
          onMerge({
            [param.name]: event.target.value === "" ? undefined : Number(event.target.value),
          })
        }
      />
    );
  }
  return (
    <input
      className="studio-input nodrag"
      value={typeof value === "string" ? value : ""}
      placeholder={param.label}
      aria-label={param.label}
      onChange={(event) => onMerge({ [param.name]: event.target.value })}
    />
  );
}

function NodeOutputView({ result }: { result: NodeRunResult }) {
  if (result.status === "error") {
    return <p className="studio-node-error">{result.error}</p>;
  }
  const output = result.output;
  if (!output) return null;
  if (output.kind === "text") {
    return <div className="studio-node-output nowheel">{output.text}</div>;
  }
  if (output.kind === "image") {
    return (
      <div className="studio-node-output">
        <img src={`data:${output.mimeType};base64,${output.base64}`} alt="Node output" />
      </div>
    );
  }
  if (output.kind === "audio") {
    const src =
      output.src ??
      output.url ??
      (output.base64 ? `data:${output.mimeType};base64,${output.base64}` : "");
    return (
      <div className="studio-node-output">
        {/* biome-ignore lint/a11y/useMediaCaption: generated audio has no track */}
        {src ? <audio controls src={src} className="studio-audio-player nodrag" /> : null}
      </div>
    );
  }
  return (
    <div className="studio-node-output">
      {output.src ? (
        // biome-ignore lint/a11y/useMediaCaption: generated clips have no track
        <video controls playsInline src={output.src} className="studio-node-video nodrag" />
      ) : (
        <span>Video ready - saved to the gallery.</span>
      )}
    </div>
  );
}

/** The controls a gate shows while it holds the production: pick a candidate
 * (when several are wired in) and approve. */
function GateApproval({ data }: { data: StudioNodeData }) {
  const sources = data.gateSources ?? [];
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const note = typeof data.wfNode.params.note === "string" ? data.wfNode.params.note.trim() : "";
  return (
    <div className="studio-gate-approval nodrag">
      <p className="studio-gate-note">{note || "The production is waiting for your approval."}</p>
      {sources.length > 1 ? (
        <select
          className="studio-native-select nodrag"
          value={choice ?? sources[0]?.id ?? ""}
          aria-label="Candidate to continue with"
          onChange={(event) => setChoice(event.target.value)}
        >
          {sources.map((source, index) => (
            <option key={source.id} value={source.id}>
              {`${index + 1}. ${source.label}${index === 0 ? " (default)" : ""}`}
            </option>
          ))}
        </select>
      ) : null}
      <button
        type="button"
        className="studio-primary-button"
        onClick={() => data.onApproveGate?.(data.wfNode.id, choice ?? sources[0]?.id)}
      >
        Approve and continue
      </button>
    </div>
  );
}

function StudioNode({ data }: NodeProps<StudioFlowNode>) {
  const { wfNode, catalog, result, onParamsChange, onRemove } = data;
  const schema = nodeSchema(wfNode.type);
  const cost = estimateNodeCost(wfNode, catalog);
  const runState =
    result?.status === "running"
      ? "running"
      : result?.status === "done"
        ? "done"
        : result?.status === "error"
          ? "error"
          : result?.status === "awaiting"
            ? "awaiting"
            : undefined;
  return (
    <div className="studio-node" data-run={runState}>
      <div className="studio-node-head">
        <span className="studio-node-title">{schema.label}</span>
        <span className="studio-card-actions">
          {cost.kind === "flat" && cost.credits !== undefined && cost.credits > 0 ? (
            <span className="studio-node-kind">~{formatCredits(cost.credits)}</span>
          ) : null}
          {result?.status === "running" && typeof result.progress === "number" ? (
            <span className="studio-node-kind">{Math.round(result.progress * 100)}%</span>
          ) : null}
          {result?.status === "running" ? <Spinner aria-hidden /> : null}
          <button
            type="button"
            className="studio-icon-button nodrag"
            aria-label="Remove node"
            onClick={() => onRemove(wfNode.id)}
          >
            <IconCrossSmall size={14} />
          </button>
        </span>
      </div>
      {schema.inputs.length > 0 ? (
        <div className="studio-node-ports">
          {schema.inputs.map((port) => (
            <div key={port.id} className="studio-node-port">
              <Handle type="target" position={Position.Left} id={port.id} />
              <span className="studio-node-port-label">{port.label}</span>
            </div>
          ))}
        </div>
      ) : null}
      {schema.inputs
        .filter((port) => port.multi && (data.portSources?.[port.id]?.length ?? 0) > 1)
        .map((port) => {
          const sources = data.portSources?.[port.id] ?? [];
          // Image inputs of a prompted node can be talked about by position:
          // clicking an entry drops the mention into the prompt, spelled the
          // way the target model reads it (seedance wants `<Image 1>`, and
          // gets the wrong workflow when handed plain prose).
          const mentionable =
            port.kind === "image" && schema.params.some((param) => param.name === "prompt");
          const modelId = typeof wfNode.params.model === "string" ? wfNode.params.model : "";
          const mentionFor = (index: number) =>
            referenceMention(modelId ? { id: modelId } : undefined, "image", index + 1);
          return (
            <div key={port.id} className="studio-port-order nodrag">
              <span className="studio-port-order-head">{port.label} order</span>
              <ol className="studio-port-order-list">
                {sources.map((source, index) => (
                  <li key={source.edgeId}>
                    <button
                      type="button"
                      className="studio-port-order-entry"
                      disabled={!mentionable}
                      title={mentionable ? `Add "${mentionFor(index)}" to the prompt` : undefined}
                      onClick={() => {
                        const prompt =
                          typeof wfNode.params.prompt === "string" ? wfNode.params.prompt : "";
                        const mention = mentionFor(index);
                        onParamsChange(wfNode.id, {
                          ...wfNode.params,
                          prompt: prompt ? `${prompt.trimEnd()} ${mention}` : mention,
                        });
                      }}
                    >
                      <span className="studio-port-order-index">{index + 1}</span>
                      {source.image ? <img src={source.image} alt="" /> : null}
                      <span className="studio-port-order-label">{source.label}</span>
                    </button>
                    <span className="studio-port-order-actions">
                      <button
                        type="button"
                        className="studio-icon-button"
                        aria-label={`Move ${source.label} up`}
                        disabled={index === 0}
                        onClick={() => data.onReorderEdge?.(source.edgeId, -1)}
                      >
                        <IconArrowUp size={12} />
                      </button>
                      <button
                        type="button"
                        className="studio-icon-button"
                        aria-label={`Move ${source.label} down`}
                        disabled={index === sources.length - 1}
                        onClick={() => data.onReorderEdge?.(source.edgeId, 1)}
                      >
                        <IconArrowDown size={12} />
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
              {wfNode.type === "assemble" && port.id === "clips" && data.chainSuggestion ? (
                <button
                  type="button"
                  className="btn btn-secondary studio-port-order-chain"
                  title="These clips continue each other; cut them in chain order."
                  onClick={() => data.onApplyChainOrder?.(wfNode.id, data.chainSuggestion ?? [])}
                >
                  Order by chain
                </button>
              ) : null}
            </div>
          );
        })}
      {schema.params.map((param) => (
        <ParamField
          key={param.name}
          node={wfNode}
          param={param}
          catalog={catalog}
          onMerge={(partial) => onParamsChange(wfNode.id, { ...wfNode.params, ...partial })}
        />
      ))}
      {result?.status === "awaiting" ? <GateApproval data={data} /> : null}
      {result ? <NodeOutputView result={result} /> : null}
      {schema.output !== "none" ? <Handle type="source" position={Position.Right} /> : null}
    </div>
  );
}

const NODE_TYPES = { studio: StudioNode };

function costSummary(estimate: WorkflowCostEstimate): string {
  if (estimate.credits > 0 && estimate.metered > 0) {
    return `~${formatCredits(estimate.credits)} + usage`;
  }
  if (estimate.credits > 0) return `~${formatCredits(estimate.credits)}`;
  return "Usage priced";
}

/** The pre-spend handshake: every paying node's figure, the total, and the
 * one button that actually starts the run. */
function RunCostDialog({
  estimate,
  onConfirm,
  onClose,
}: {
  estimate: WorkflowCostEstimate;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const paying = estimate.nodes.filter((node) => node.kind !== "free");
  return (
    <Dialog
      open
      onClose={onClose}
      title="Run this production?"
      description="What one run of this workflow is expected to spend."
      width={440}
    >
      <div className="dialog-body">
        <ul className="studio-cost-rows">
          {paying.map((node) => (
            <li key={node.nodeId}>
              <span>{node.label}</span>
              <span>
                {node.kind === "flat" && node.credits !== undefined
                  ? `~${formatCredits(node.credits)}`
                  : "usage priced"}
              </span>
            </li>
          ))}
        </ul>
        <p className="studio-cost-total">
          <span>Total</span>
          <span>
            {estimate.metered > 0
              ? `at least ~${formatCredits(estimate.credits)}`
              : `~${formatCredits(estimate.credits)}`}
          </span>
        </p>
        <p className="studio-cost-note">
          These are estimates, not a receipt. Usage priced nodes bill by what they consume.
        </p>
        <div className="studio-cost-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="studio-primary-button" onClick={onConfirm}>
            Run workflow
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function WorkflowStudio({ catalog }: { catalog: MediaCatalog }) {
  const [workflows, setWorkflows] = useState<Workflow[]>(() => listWorkflows());
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
  /** The durable run this canvas is showing (started or resumed here), so a
   * gate approval knows which run to continue. */
  const runIdRef = useRef<string | undefined>(undefined);
  /** Stable identity for node data; retargeted once the handler exists. */
  const approveGateRef = useRef<(gateId: string, choice: string | undefined) => void>(() => {});
  const onApproveGate = useCallback(
    (gateId: string, choice: string | undefined) => approveGateRef.current(gateId, choice),
    [],
  );
  const mirrorUpdate = useCallback((result: NodeRunResult) => {
    setResults((currentResults) => {
      const next = new Map(currentResults);
      next.set(result.nodeId, result);
      return next;
    });
  }, []);

  const onParamsChange = useCallback((id: string, params: Record<string, unknown>) => {
    setFlowNodes((nodes) =>
      nodes.map((node) =>
        node.id === id
          ? { ...node, data: { ...node.data, wfNode: { ...node.data.wfNode, params } } }
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
    (workflow: Workflow | undefined) => {
      setCurrent(workflow);
      setResults(new Map());
      setRunError(undefined);
      setFlowNodes(
        workflow
          ? toFlowNodes(workflow, catalog, new Map(), onParamsChange, onRemove, onApproveGate)
          : [],
      );
      setFlowEdges(workflow ? toFlowEdges(workflow) : []);
    },
    [catalog, onParamsChange, onRemove, onApproveGate],
  );

  // First mount: open the most recent workflow, or seed from templates.
  useEffect(() => {
    const existing = listWorkflows();
    if (existing.length > 0) {
      hydrate(existing[0]);
      return;
    }
    const seeded = createWorkflow("My first workflow");
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
    if (!base) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const serialized = fromFlow(base, flowNodes, flowEdges);
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

  const onApplyChainOrder = useCallback((_nodeId: string, orderedEdgeIds: string[]) => {
    setFlowEdges((edges) => {
      const applied = applyPortOrder(edges.map(toWorkflowEdge), orderedEdgeIds);
      const byId = new Map(edges.map((edge) => [edge.id, edge]));
      return applied.flatMap((entry) => byId.get(entry.id) ?? []);
    });
  }, []);

  // Keep node data in sync with run results without disturbing positions.
  // Connection-order lists, gate candidates, and the assemble node's chain
  // suggestion refresh here too, so they always describe the wiring as it is.
  useEffect(() => {
    setFlowNodes((nodes) => {
      const graph = {
        nodes: nodes.map((node) => node.data.wfNode),
        edges: flowEdges.map(toWorkflowEdge),
      };
      const labelOf = new Map(
        nodes.map((node) => [node.id, node.data.wfNode.label || node.data.wfNode.type]),
      );
      const imageOf = (nodeId: string): string | undefined => {
        const output = results.get(nodeId)?.output;
        return output?.kind === "image"
          ? `data:${output.mimeType};base64,${output.base64}`
          : undefined;
      };
      return nodes.map((node) => {
        const wfNode = node.data.wfNode;
        const schema = maybeNodeSchema(wfNode.type);
        let portSources: Record<string, PortSourceEntry[]> | undefined;
        for (const port of schema?.inputs ?? []) {
          if (!port.multi) continue;
          const portEdges = edgesOnPort(graph, node.id, port.id);
          if (portEdges.length < 2) continue;
          portSources ??= {};
          portSources[port.id] = portEdges.map((edge) => ({
            edgeId: edge.id,
            sourceId: edge.source,
            label: labelOf.get(edge.source) ?? edge.source,
            image: imageOf(edge.source),
          }));
        }
        return {
          ...node,
          data: {
            ...node.data,
            result: results.get(node.id),
            catalog,
            onReorderEdge,
            onApplyChainOrder,
            portSources,
            chainSuggestion:
              wfNode.type === "assemble" ? chainOrderSuggestion(graph, node.id) : undefined,
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
  }, [results, catalog, flowEdges, onReorderEdge, onApplyChainOrder]);

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
      if (!schema || schema.inputs.length === 0) return false;
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
        schema,
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
        label: nodeSchema(type).label,
        position: { x: 80 + (offset % 4) * 60, y: 80 + offset * 40 },
        params: defaultParams(type),
      };
      setFlowNodes((nodes) => [
        ...nodes,
        {
          id: wfNode.id,
          type: "studio" as const,
          position: wfNode.position,
          data: { wfNode, catalog, onParamsChange, onRemove, onApproveGate },
        },
      ]);
    },
    [flowNodes.length, catalog, onParamsChange, onRemove, onApproveGate],
  );

  const applyTemplate = useCallback(
    (templateId: string) => {
      const template = templateWorkflows().find((entry) => entry.id === templateId);
      if (!template) return;
      const workflow = createWorkflow(template.name);
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
    },
    [hydrate],
  );

  const serialized = current ? fromFlow(current, flowNodes, flowEdges) : undefined;
  const validation = useMemo(
    () => (serialized ? validateWorkflow(serialized) : undefined),
    [serialized],
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
      for (const port of maybeNodeSchema(node.type)?.inputs ?? []) {
        if (!port.multi) continue;
        const portEdges = edgesOnPort(graph, node.id, port.id);
        if (portEdges.length < 2) continue;
        portEdges.forEach((edge, index) => {
          orders.set(edge.id, index + 1);
        });
      }
    }
    return flowEdges.map((edge) => ({
      ...edge,
      type: "studio" as const,
      data: { order: orders.get(edge.id) },
    }));
    // orderGraphKey stands in for the node list: order only depends on the
    // parts of it the key captures.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  }, [flowEdges, orderGraphKey]);
  const estimate = useMemo(
    () => (serialized ? estimateWorkflowCost(serialized, catalog) : undefined),
    [serialized, catalog],
  );
  const [pendingRun, setPendingRun] = useState<WorkflowCostEstimate | undefined>(undefined);
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

  const run = useCallback(
    async (nodeCosts?: Record<string, number>) => {
      if (!serialized || running || !validation?.ok) return;
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      setRunning(true);
      setRunError(undefined);
      setResults(new Map());
      try {
        // Durable run (ADR-0021): state persists as rows, long renders ride
        // the Rust job pollers, and produced media lands in the gallery at
        // the node that made it, with provenance and chain links.
        await runAndSaveWorkflow(serialized, {
          signal: controller.signal,
          nodeCosts,
          onRunRecorded: (runId) => {
            runIdRef.current = runId;
          },
          onUpdate: mirrorUpdate,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          // Cancelled on purpose; per-node statuses already reset.
        } else if (error instanceof WorkflowRunError) {
          setRunError(error.message);
        } else {
          setRunError(error instanceof Error ? error.message : "The run failed.");
        }
      } finally {
        setRunning(false);
      }
    },
    [serialized, running, validation, mirrorUpdate],
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
      const mirrorsCanvas = current?.id === entry.workflowId;
      try {
        await resumeWorkflowRun(entry.id, {
          signal: controller.signal,
          onUpdate: mirrorsCanvas ? mirrorUpdate : undefined,
        });
        setResumable((entries) => entries.filter((candidate) => candidate.id !== entry.id));
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          // Cancelled on purpose; the run stays resumable.
        } else {
          setRunError(error instanceof Error ? error.message : "The resume failed.");
          setResumable((entries) => entries.filter((candidate) => candidate.id !== entry.id));
        }
      } finally {
        setRunning(false);
      }
    },
    [running, current, mirrorUpdate],
  );

  /** Decide one gate and continue the held production. Gates left undecided
   * simply hold again — approving is always one gate at a time here. */
  const continueHeldRun = useCallback(
    async (gateId: string, choice: string | undefined) => {
      const runId = runIdRef.current;
      if (!runId || running) return;
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      setRunning(true);
      setRunError(undefined);
      try {
        await resumeWorkflowRun(runId, {
          signal: controller.signal,
          approvedGates: new Map([[gateId, choice]]),
          onUpdate: mirrorUpdate,
        });
        setResumable((entries) => entries.filter((candidate) => candidate.id !== runId));
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          // Cancelled on purpose; the gate holds.
        } else {
          setRunError(error instanceof Error ? error.message : "The approval failed.");
        }
      } finally {
        setRunning(false);
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
  const startRun = useCallback(async () => {
    if (!serialized || running || quoting || !validation?.ok) return;
    const staticEstimate = estimateWorkflowCost(serialized, catalog);
    if (!needsRunConfirmation(staticEstimate)) {
      void run(nodeCostMap(staticEstimate));
      return;
    }
    setQuoting(true);
    try {
      const quotes = await fetchVideoQuotes(serialized, catalog);
      setPendingRun(estimateWorkflowCost(serialized, catalog, quotes));
    } finally {
      setQuoting(false);
    }
  }, [serialized, running, quoting, validation, catalog, run]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const removeCurrent = useCallback(() => {
    if (!current) return;
    deleteWorkflow(current.id);
    const remaining = listWorkflows();
    setWorkflows(remaining);
    hydrate(remaining[0]);
  }, [current, hydrate]);

  const newWorkflow = useCallback(() => {
    const workflow = createWorkflow("Untitled workflow");
    saveWorkflow(workflow);
    setWorkflows(listWorkflows());
    hydrate(workflow);
  }, [hydrate]);

  return (
    <div className="studio-workflows">
      <div className="studio-workflows-toolbar">
        <Select
          value={current?.id ?? null}
          placeholder="Choose a workflow"
          ariaLabel="Workflow"
          onChange={(id) => hydrate(workflows.find((entry) => entry.id === id))}
          options={workflows.map((entry) => ({ value: entry.id, label: entry.name }))}
        />
        <input
          className="studio-input studio-workflow-name"
          value={current?.name ?? ""}
          placeholder="Workflow name"
          aria-label="Workflow name"
          onChange={(event) =>
            setCurrent((existing) =>
              existing ? { ...existing, name: event.target.value } : existing,
            )
          }
        />
        <button type="button" className="btn btn-secondary" onClick={newWorkflow}>
          New
        </button>
        <Select
          value={null}
          placeholder="Templates"
          ariaLabel="Start from a template"
          onChange={applyTemplate}
          options={templateWorkflows().map((entry) => ({ value: entry.id, label: entry.name }))}
        />
        <Select
          value={null}
          placeholder="Add node"
          ariaLabel="Add a node"
          onChange={(type) => addNode(type as WorkflowNodeType)}
          options={Object.values(NODE_SCHEMAS).map((schema) => ({
            value: schema.type,
            label: schema.label,
          }))}
        />
        <span className="studio-spacer" />
        {current ? (
          <button type="button" className="btn btn-secondary" onClick={removeCurrent}>
            Delete
          </button>
        ) : null}
        {estimate && (estimate.credits > 0 || estimate.metered > 0) ? (
          <span className="studio-workflow-cost" title="Estimated cost of one run">
            {costSummary(estimate)}
          </span>
        ) : null}
        {running ? (
          <button type="button" className="btn btn-secondary" onClick={stop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="studio-primary-button"
            disabled={!validation?.ok || !serialized || serialized.nodes.length === 0 || quoting}
            title={validation?.errors.map((issue) => issue.message).join("\n") || undefined}
            onClick={() => void startRun()}
          >
            {quoting ? "Pricing..." : "Run workflow"}
          </button>
        )}
      </div>
      {pendingRun ? (
        <RunCostDialog
          estimate={pendingRun}
          onConfirm={() => {
            const costs = nodeCostMap(pendingRun);
            setPendingRun(undefined);
            void run(costs);
          }}
          onClose={() => setPendingRun(undefined)}
        />
      ) : null}
      {!running && liveProductions.length > 0 ? (
        <div className="studio-resume-banner">
          {liveProductions.map((entry) => (
            <div key={entry.id} className="studio-resume-row">
              <span>
                Still producing: <strong>{entry.name || "Untitled workflow"}</strong>. Its media
                lands in the gallery as it finishes.
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
                An interrupted production: <strong>{entry.name || "Untitled workflow"}</strong>.
                Finished steps are kept; resuming only runs what is left.
              </span>
              <span className="studio-resume-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={running}
                  onClick={() => void dismissResumable(entry)}
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  className="studio-primary-button"
                  disabled={running}
                  onClick={() => void resume(entry)}
                >
                  Resume
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {runError ? <p className="studio-error">{runError}</p> : null}
      {validation && (validation.errors.length > 0 || validation.warnings.length > 0) ? (
        <div className="studio-validation">
          {[...validation.errors, ...validation.warnings].map((issue) => (
            <span
              key={`${issue.severity}:${issue.nodeId ?? issue.edgeId ?? ""}:${issue.message}`}
              data-severity={issue.severity}
            >
              {issue.message}
            </span>
          ))}
        </div>
      ) : null}
      <div className="studio-workflow-canvas">
        <ReactFlow
          nodes={flowNodes}
          edges={displayEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
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
