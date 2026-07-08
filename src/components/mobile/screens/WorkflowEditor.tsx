import { IconArrowDown } from "central-icons/IconArrowDown";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useCallback, useMemo, useState } from "react";
import { hapticImpact, hapticNotify } from "../../../lib/haptics";
import { modelsOfType } from "../../../lib/studio/catalog";
import type { MediaCatalog, MediaType } from "../../../lib/studio/types";
import {
  defaultParams,
  deleteWorkflow,
  type NodeRunResult,
  nodeSchema,
  type ParamSchema,
  saveWorkflow,
  type ValidationIssue,
  type Workflow,
  type WorkflowNode,
  type WorkflowNodeType,
  WorkflowRunError,
  validateWorkflow,
} from "../../../lib/studio/workflow";
import { runAndSaveWorkflow } from "../../../lib/studio/workflow-run";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Spinner } from "../../ui/Spinner";
import { FlowStepOutput } from "./FlowsPanel";

// The node types a user can add as a step. `output` is appended automatically
// (the final deliverable), so it is not offered here.
const STEP_TYPES: WorkflowNodeType[] = ["textInput", "chat", "image", "tts", "music", "video"];

/** A mobile-native, linear workflow editor: an ordered list of steps the user
 * adds, reorders, and configures through schema-driven forms. The desktop's
 * free-form node canvas does not translate to a phone, so steps chain
 * sequentially (each feeds the next) and a hidden output node collects the
 * final result. Runs on the shared engine and saves to the gallery. */
export function WorkflowEditor({
  workflow,
  catalog,
  onBack,
  onSaved,
  onDeleted,
  onGenerated,
}: {
  workflow: Workflow;
  catalog: MediaCatalog;
  onBack: () => void;
  onSaved: () => void;
  onDeleted: () => void;
  onGenerated: () => void;
}) {
  const [name, setName] = useState(workflow.name);
  // The editable steps, in order. The trailing output node (if any) is dropped
  // here and re-appended when the workflow is assembled.
  const [steps, setSteps] = useState<WorkflowNode[]>(() =>
    workflow.nodes.filter((node) => node.type !== "output"),
  );
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Map<string, NodeRunResult> | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [savedTick, setSavedTick] = useState(false);

  const assembled = useMemo(() => assembleWorkflow(workflow, name, steps), [workflow, name, steps]);

  const updateParams = useCallback((id: string, params: Record<string, unknown>) => {
    setSteps((current) => current.map((node) => (node.id === id ? { ...node, params } : node)));
  }, []);

  const move = useCallback((index: number, delta: number) => {
    setSteps((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
    hapticImpact("light");
  }, []);

  const remove = useCallback((id: string) => {
    setSteps((current) => current.filter((node) => node.id !== id));
  }, []);

  const addStep = useCallback((type: WorkflowNodeType) => {
    const schema = nodeSchema(type);
    setSteps((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        type,
        label: schema.label,
        position: { x: 0, y: 0 },
        params: defaultParams(type),
      },
    ]);
    setAdding(false);
  }, []);

  const persist = useCallback(() => {
    saveWorkflow(assembled);
    setSavedTick(true);
    hapticNotify("success");
    window.setTimeout(() => setSavedTick(false), 1400);
    onSaved();
  }, [assembled, onSaved]);

  const run = useCallback(async () => {
    if (running || steps.length === 0) return;
    setError(null);
    setIssues([]);
    const validation = validateWorkflow(assembled);
    if (!validation.ok) {
      setIssues([...validation.errors, ...validation.warnings]);
      return;
    }
    // Persist before running so the just-tuned flow is not lost if the run is
    // long or the app is backgrounded.
    saveWorkflow(assembled);
    onSaved();
    setRunning(true);
    const live = new Map<string, NodeRunResult>();
    setResults(new Map());
    try {
      const finished = await runAndSaveWorkflow(assembled, {
        onUpdate: (result) => {
          live.set(result.nodeId, result);
          setResults(new Map(live));
        },
      });
      setResults(new Map(finished));
      hapticNotify("success");
      onGenerated();
    } catch (err) {
      hapticNotify("error");
      if (err instanceof WorkflowRunError) setResults(new Map(err.results));
      setError(err instanceof Error ? err.message : "The workflow failed.");
    } finally {
      setRunning(false);
    }
  }, [assembled, running, steps.length, onGenerated, onSaved]);

  return (
    <div className="mobile-studio-form">
      <button type="button" className="mobile-chip-button" onClick={onBack} disabled={running}>
        All flows
      </button>

      <label className="mobile-flows-field">
        <span>Name</span>
        <input
          className="mobile-studio-search"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="My workflow"
        />
      </label>

      <ol className="mobile-workflow-steps">
        {steps.map((node, index) => {
          const schema = nodeSchema(node.type);
          const state = results?.get(node.id);
          return (
            <li key={node.id} className="mobile-workflow-step" data-status={state?.status}>
              <div className="mobile-workflow-step-head">
                <span className="mobile-workflow-step-index">{index + 1}</span>
                <span className="mobile-workflow-step-title">{schema.label}</span>
                <span className="mobile-workflow-step-actions">
                  <button
                    type="button"
                    aria-label="Move up"
                    disabled={index === 0 || running}
                    onClick={() => move(index, -1)}
                  >
                    <IconArrowUp size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    disabled={index === steps.length - 1 || running}
                    onClick={() => move(index, 1)}
                  >
                    <IconArrowDown size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label="Remove step"
                    disabled={running}
                    onClick={() => remove(node.id)}
                  >
                    <IconTrashCan size={16} />
                  </button>
                </span>
              </div>
              <p className="mobile-workflow-step-desc">{schema.description}</p>
              <div className="mobile-workflow-step-params">
                {schema.params.map((param) => (
                  <ParamField
                    key={param.name}
                    param={param}
                    value={node.params[param.name]}
                    catalog={catalog}
                    onChange={(value) =>
                      updateParams(node.id, { ...node.params, [param.name]: value })
                    }
                  />
                ))}
              </div>
              {state ? <FlowStepOutput state={state} /> : null}
            </li>
          );
        })}
      </ol>

      {adding ? (
        <div className="mobile-workflow-add-list">
          {STEP_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className="mobile-sheet-item"
              onClick={() => addStep(type)}
            >
              <span>
                <span className="mobile-sheet-item-title">{nodeSchema(type).label}</span>
                <span className="mobile-sheet-item-subtitle">{nodeSchema(type).description}</span>
              </span>
            </button>
          ))}
          <button type="button" className="mobile-chip-button" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="mobile-chip-button" onClick={() => setAdding(true)}>
          Add step
        </button>
      )}

      <div className="mobile-workflow-editor-actions">
        <button
          type="button"
          className="mobile-chip-button"
          onClick={persist}
          disabled={running || steps.length === 0}
        >
          {savedTick ? "Saved" : "Save"}
        </button>
        <button
          type="button"
          className="mobile-studio-generate"
          onClick={() => void run()}
          disabled={running || steps.length === 0}
        >
          {running ? <Spinner /> : "Run flow"}
        </button>
      </div>

      {issues.length > 0 ? (
        <ul className="mobile-flows-issues" aria-label="Flow problems">
          {issues.map((issue) => (
            <li
              key={`${issue.nodeId ?? "flow"}-${issue.message}`}
              className="mobile-dictation-error"
            >
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="mobile-dictation-error">{error}</p> : null}

      <button
        type="button"
        className="mobile-workflow-delete"
        onClick={() => setConfirmDelete(true)}
        disabled={running}
      >
        Delete workflow
      </button>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this workflow?"
        description="This removes the workflow. Generated media in your gallery is kept."
        confirmLabel="Delete"
        onConfirm={() => {
          deleteWorkflow(workflow.id);
          setConfirmDelete(false);
          onDeleted();
        }}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}

/** Assembles the editor's ordered steps into a runnable workflow: steps chain
 * sequentially and a single output node collects the last step's result. */
function assembleWorkflow(base: Workflow, name: string, steps: WorkflowNode[]): Workflow {
  const nodes: WorkflowNode[] = steps.map((node, index) => ({
    ...node,
    position: { x: index * 260, y: 0 },
  }));
  const edges = steps.slice(1).map((node, index) => ({
    id: `${steps[index].id}-${node.id}`,
    source: steps[index].id,
    target: node.id,
  }));
  if (steps.length > 0) {
    const last = steps[steps.length - 1];
    const outputId = `${base.id}-output`;
    nodes.push({
      id: outputId,
      type: "output",
      label: "Result",
      position: { x: steps.length * 260, y: 0 },
      params: {},
    });
    edges.push({ id: `${last.id}-${outputId}`, source: last.id, target: outputId });
  }
  return { ...base, name: name.trim() || "Untitled workflow", nodes, edges };
}

// --- schema-driven param field ----------------------------------------------

function ParamField({
  param,
  value,
  catalog,
  onChange,
}: {
  param: ParamSchema;
  value: unknown;
  catalog: MediaCatalog;
  onChange: (value: unknown) => void;
}) {
  const models = useMemo(
    () =>
      param.type === "model" ? modelsOfType(catalog, (param.mediaType ?? "text") as MediaType) : [],
    [param.type, param.mediaType, catalog],
  );

  if (param.type === "model") {
    const current = typeof value === "string" ? value : "";
    return (
      <label className="mobile-workflow-param">
        <span>
          {param.label}
          {param.required ? " *" : ""}
        </span>
        <select
          className="mobile-workflow-select"
          value={current}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Choose a model</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (param.type === "enum") {
    const current = typeof value === "string" ? value : ((param.default as string) ?? "");
    return (
      <label className="mobile-workflow-param">
        <span>{param.label}</span>
        <select
          className="mobile-workflow-select"
          value={current}
          onChange={(event) => onChange(event.target.value)}
        >
          {(param.enumValues ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (param.type === "boolean") {
    return (
      <label className="mobile-toggle-row">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{param.label}</span>
      </label>
    );
  }

  if (param.type === "number") {
    const current = typeof value === "number" ? value : "";
    return (
      <label className="mobile-workflow-param">
        <span>{param.label}</span>
        <input
          className="mobile-workflow-select"
          type="number"
          value={current}
          min={param.min}
          max={param.max}
          step={param.step}
          onChange={(event) =>
            onChange(event.target.value === "" ? undefined : Number(event.target.value))
          }
        />
      </label>
    );
  }

  if (param.type === "text") {
    return (
      <label className="mobile-workflow-param">
        <span>
          {param.label}
          {param.required ? " *" : ""}
        </span>
        <textarea
          className="mobile-studio-prompt"
          rows={2}
          value={typeof value === "string" ? value : ""}
          placeholder={param.description}
          onChange={(event) => onChange(event.target.value)}
        />
        {param.description ? (
          <span className="mobile-workflow-param-hint">{param.description}</span>
        ) : null}
      </label>
    );
  }

  // string
  return (
    <label className="mobile-workflow-param">
      <span>{param.label}</span>
      <input
        className="mobile-workflow-select"
        value={typeof value === "string" ? value : ""}
        placeholder={param.description}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
