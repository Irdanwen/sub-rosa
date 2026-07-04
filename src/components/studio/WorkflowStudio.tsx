// Workflow studio: a node canvas over lib/studio/workflow. The declarative
// node schemas drive everything here — the palette, each node's mini form,
// and connection compatibility — so adding a node type to the lib lights it
// up in the UI without canvas changes. Runs execute level by level with live
// per-node status; final outputs land in the gallery like any generation.

import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Connection,
  type Edge as FlowEdge,
  type EdgeChange,
  type Node as FlowNode,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { saveArtifactFromBase64, saveArtifactFromUrl } from "../../lib/studio/artifacts";
import { modelsOfType } from "../../lib/studio/catalog";
import type { MediaCatalog, MediaType } from "../../lib/studio/types";
import {
  createWorkflow,
  defaultParams,
  deleteWorkflow,
  listWorkflows,
  NODE_SCHEMAS,
  nodeSchema,
  runWorkflow,
  saveWorkflow,
  templateWorkflows,
  validateWorkflow,
  WorkflowRunError,
  type NodeRunResult,
  type ParamSchema,
  type Workflow,
  type WorkflowNode,
  type WorkflowNodeType,
} from "../../lib/studio/workflow";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { Switch } from "../ui/Switch";

interface StudioNodeData extends Record<string, unknown> {
  wfNode: WorkflowNode;
  catalog: MediaCatalog;
  result?: NodeRunResult;
  onParamsChange: (id: string, params: Record<string, unknown>) => void;
  onRemove: (id: string) => void;
}

type StudioFlowNode = FlowNode<StudioNodeData, "studio">;

const SAVE_DEBOUNCE_MS = 300;

function toFlowNodes(
  workflow: Workflow,
  catalog: MediaCatalog,
  results: Map<string, NodeRunResult>,
  onParamsChange: (id: string, params: Record<string, unknown>) => void,
  onRemove: (id: string) => void,
): StudioFlowNode[] {
  return workflow.nodes.map((node) => ({
    id: node.id,
    type: "studio" as const,
    position: node.position,
    data: { wfNode: node, catalog, result: results.get(node.id), onParamsChange, onRemove },
  }));
}

function toFlowEdges(workflow: Workflow): FlowEdge[] {
  return workflow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    animated: true,
  }));
}

function fromFlow(base: Workflow, nodes: StudioFlowNode[], edges: FlowEdge[]): Workflow {
  return {
    ...base,
    nodes: nodes.map((node) => ({
      ...node.data.wfNode,
      position: { x: node.position.x, y: node.position.y },
    })),
    edges: edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
  };
}

function ParamField({
  node,
  param,
  catalog,
  onChange,
}: {
  node: WorkflowNode;
  param: ParamSchema;
  catalog: MediaCatalog;
  onChange: (name: string, value: unknown) => void;
}) {
  const value = node.params[param.name];
  if (param.type === "model") {
    const models = modelsOfType(catalog, (param.mediaType ?? "text") as MediaType);
    return (
      <select
        className="studio-native-select nodrag"
        value={typeof value === "string" ? value : ""}
        aria-label={param.label}
        onChange={(event) => onChange(param.name, event.target.value)}
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
  if (param.type === "text") {
    return (
      <textarea
        className="studio-textarea nodrag nowheel"
        rows={2}
        value={typeof value === "string" ? value : ""}
        placeholder={param.label}
        aria-label={param.label}
        onChange={(event) => onChange(param.name, event.target.value)}
      />
    );
  }
  if (param.type === "boolean") {
    return (
      <div className="studio-node-switch nodrag">
        <span className="studio-node-kind">{param.label}</span>
        <Switch
          checked={value === true}
          onCheckedChange={(checked) => onChange(param.name, checked)}
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
        onChange={(event) => onChange(param.name, event.target.value)}
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
          onChange(param.name, event.target.value === "" ? undefined : Number(event.target.value))
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
      onChange={(event) => onChange(param.name, event.target.value)}
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
      output.url ?? (output.base64 ? `data:${output.mimeType};base64,${output.base64}` : "");
    return (
      <div className="studio-node-output">
        {/* biome-ignore lint/a11y/useMediaCaption: generated audio has no track */}
        {src ? <audio controls src={src} className="studio-audio-player nodrag" /> : null}
      </div>
    );
  }
  return (
    <div className="studio-node-output">
      <span>Video ready - saved to the gallery.</span>
    </div>
  );
}

function StudioNode({ data }: NodeProps<StudioFlowNode>) {
  const { wfNode, catalog, result, onParamsChange, onRemove } = data;
  const schema = nodeSchema(wfNode.type);
  const runState =
    result?.status === "running"
      ? "running"
      : result?.status === "done"
        ? "done"
        : result?.status === "error"
          ? "error"
          : undefined;
  return (
    <div className="studio-node" data-run={runState}>
      {schema.input !== "none" ? <Handle type="target" position={Position.Left} /> : null}
      <div className="studio-node-head">
        <span className="studio-node-title">{schema.label}</span>
        <span className="studio-card-actions">
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
      {schema.params.map((param) => (
        <ParamField
          key={param.name}
          node={wfNode}
          param={param}
          catalog={catalog}
          onChange={(name, value) => onParamsChange(wfNode.id, { ...wfNode.params, [name]: value })}
        />
      ))}
      {result ? <NodeOutputView result={result} /> : null}
      {schema.output !== "none" ? <Handle type="source" position={Position.Right} /> : null}
    </div>
  );
}

const NODE_TYPES = { studio: StudioNode };

/** Extensions for gallery saves, from an audio output's mime. */
function audioExtension(mimeType: string): string {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("flac")) return "flac";
  return "mp3";
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
        workflow ? toFlowNodes(workflow, catalog, new Map(), onParamsChange, onRemove) : [],
      );
      setFlowEdges(workflow ? toFlowEdges(workflow) : []);
    },
    [catalog, onParamsChange, onRemove],
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

  // Keep node data in sync with run results without disturbing positions.
  useEffect(() => {
    setFlowNodes((nodes) =>
      nodes.map((node) => ({
        ...node,
        data: { ...node.data, result: results.get(node.id), catalog },
      })),
    );
  }, [results, catalog]);

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
          data: { wfNode, catalog, onParamsChange, onRemove },
        },
      ]);
    },
    [flowNodes.length, catalog, onParamsChange, onRemove],
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

  const run = useCallback(async () => {
    if (!serialized || running || !validation?.ok) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setRunning(true);
    setRunError(undefined);
    setResults(new Map());
    const outputNodeIds = new Set(
      serialized.nodes.filter((node) => node.type === "output").map((node) => node.id),
    );
    try {
      const finished = await runWorkflow(serialized, {
        signal: controller.signal,
        onUpdate: (result) =>
          setResults((currentResults) => {
            const next = new Map(currentResults);
            next.set(result.nodeId, result);
            return next;
          }),
      });
      // Final deliverables (whatever reached an output node) join the gallery.
      for (const [nodeId, result] of finished) {
        if (!outputNodeIds.has(nodeId) || !result.output) continue;
        const output = result.output;
        const metadata = { model: "workflow", prompt: serialized.name };
        if (output.kind === "image") {
          await saveArtifactFromBase64(output.base64, "png", { ...metadata, kind: "image" });
        } else if (output.kind === "video") {
          await saveArtifactFromUrl(output.url, "mp4", { ...metadata, kind: "video" });
        } else if (output.kind === "audio" && output.url) {
          await saveArtifactFromUrl(output.url, "mp3", { ...metadata, kind: "music" });
        } else if (output.kind === "audio" && output.base64) {
          await saveArtifactFromBase64(output.base64, audioExtension(output.mimeType), {
            ...metadata,
            kind: "speech",
          });
        }
      }
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
  }, [serialized, running, validation]);

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
        <button type="button" className="studio-secondary-button" onClick={newWorkflow}>
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
          <button type="button" className="studio-secondary-button" onClick={removeCurrent}>
            Delete
          </button>
        ) : null}
        {running ? (
          <button type="button" className="studio-secondary-button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="studio-primary-button"
            disabled={!validation?.ok || !serialized || serialized.nodes.length === 0}
            title={validation?.errors.map((issue) => issue.message).join("\n") || undefined}
            onClick={() => void run()}
          >
            Run workflow
          </button>
        )}
      </div>
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
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
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
