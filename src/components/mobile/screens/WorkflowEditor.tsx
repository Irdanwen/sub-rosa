import { IconArrowDown } from "central-icons/IconArrowDown";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useArtifactThumbnail } from "../../../lib/artifact-media";
import { hapticImpact, hapticNotify } from "../../../lib/haptics";
import { formatCredits } from "../../../lib/studio/catalog";
import { listArtifacts } from "../../../lib/studio/artifacts";
import type { ArtifactKind, MediaCatalog, StudioArtifact } from "../../../lib/studio/types";
import { listNotes, type NoteListItemDto } from "../../../lib/tauri";
import {
  awaitingGateIds,
  defaultParams,
  deleteWorkflow,
  estimateWorkflowCost,
  maybeNodeSchema,
  modelsForParam,
  needsRunConfirmation,
  type NodeRunResult,
  nodeCostMap,
  nodeSchema,
  type ParamSchema,
  saveWorkflow,
  type ValidationIssue,
  type Workflow,
  type WorkflowCostEstimate,
  type WorkflowNode,
  type WorkflowNodeType,
  WorkflowRunError,
  validateWorkflow,
} from "../../../lib/studio/workflow";
import { runAndSaveWorkflow } from "../../../lib/studio/workflow-run";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Spinner } from "../../ui/Spinner";
import { ModelSheet } from "../ModelSheet";
import { FlowStepOutput } from "./FlowsPanel";

// The node types a user can add as a step. `output` is appended automatically
// (the final deliverable), so it is not offered here. A gate pauses the flow
// until it is approved from the flows list.
const STEP_TYPES: WorkflowNodeType[] = [
  "textInput",
  "asset",
  "document",
  "chat",
  "image",
  "imageEdit",
  "tts",
  "music",
  "video",
  "gate",
];

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
  const [confirmRun, setConfirmRun] = useState<WorkflowCostEstimate | null>(null);
  const [savedTick, setSavedTick] = useState(false);
  /** The run stopped at an approval gate rather than finishing. */
  const [paused, setPaused] = useState(false);

  const assembled = useMemo(() => assembleWorkflow(workflow, name, steps), [workflow, name, steps]);
  const estimate = useMemo(() => estimateWorkflowCost(assembled, catalog), [assembled, catalog]);

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

  const launch = useCallback(
    async (nodeCosts?: Record<string, number>) => {
      // Persist before running so the just-tuned flow is not lost if the run
      // is long or the app is backgrounded.
      saveWorkflow(assembled);
      onSaved();
      setRunning(true);
      setPaused(false);
      const live = new Map<string, NodeRunResult>();
      setResults(new Map());
      try {
        const finished = await runAndSaveWorkflow(assembled, {
          nodeCosts,
          onUpdate: (result) => {
            live.set(result.nodeId, result);
            setResults(new Map(live));
          },
        });
        setResults(new Map(finished));
        setPaused(awaitingGateIds(finished).length > 0);
        hapticNotify("success");
        onGenerated();
      } catch (err) {
        hapticNotify("error");
        if (err instanceof WorkflowRunError) setResults(new Map(err.results));
        setError(err instanceof Error ? err.message : "The workflow failed.");
      } finally {
        setRunning(false);
      }
    },
    [assembled, onGenerated, onSaved],
  );

  const run = useCallback(() => {
    if (running || steps.length === 0) return;
    setError(null);
    setIssues([]);
    const validation = validateWorkflow(assembled);
    if (!validation.ok) {
      setIssues([...validation.errors, ...validation.warnings]);
      return;
    }
    // The pre-spend handshake: show the bill before rolling cameras.
    if (needsRunConfirmation(estimate)) {
      setConfirmRun(estimate);
      return;
    }
    void launch(nodeCostMap(estimate));
  }, [assembled, estimate, launch, running, steps.length]);

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
                    nodeParams={node.params}
                    catalog={catalog}
                    onMerge={(partial) => updateParams(node.id, { ...node.params, ...partial })}
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

      {estimate.credits > 0 || estimate.metered > 0 ? (
        <p className="mobile-workflow-cost">
          {estimate.credits > 0
            ? `One run: about ${formatCredits(estimate.credits)}${
                estimate.metered > 0 ? " plus usage" : ""
              }`
            : "One run: usage priced"}
        </p>
      ) : null}

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
          onClick={run}
          disabled={running || steps.length === 0}
        >
          {running ? <Spinner /> : "Run flow"}
        </button>
      </div>

      {paused ? (
        <p className="mobile-workflow-cost">
          Paused at an approval gate. Approve it from the flows list to continue.
        </p>
      ) : null}
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
        destructive
        onConfirm={() => {
          deleteWorkflow(workflow.id);
          setConfirmDelete(false);
          onDeleted();
        }}
        onClose={() => setConfirmDelete(false)}
      />

      <ConfirmDialog
        open={confirmRun !== null}
        title="Run this flow?"
        description={confirmRun ? runCostDescription(confirmRun) : ""}
        confirmLabel="Run"
        onConfirm={() => {
          const costs = confirmRun ? nodeCostMap(confirmRun) : undefined;
          setConfirmRun(null);
          void launch(costs);
        }}
        onClose={() => setConfirmRun(null)}
      />
    </div>
  );
}

/** The bill, in one sentence: known figures plus how much stays open. Shared
 * with the template runner, whose runs spend just the same. */
export function runCostDescription(estimate: WorkflowCostEstimate): string {
  if (estimate.credits > 0 && estimate.metered > 0) {
    return `One run is expected to spend at least ${formatCredits(estimate.credits)}; ${
      estimate.metered
    } step${estimate.metered === 1 ? " is" : "s are"} usage priced on top.`;
  }
  if (estimate.credits > 0) {
    return `One run is expected to spend about ${formatCredits(estimate.credits)}.`;
  }
  return "This flow bills by usage; no flat figure is published for its steps.";
}

/**
 * Assembles the editor's ordered steps into a runnable workflow.
 *
 * Input-less steps (a text input, an asset, a document) cannot *receive* an
 * edge — chaining into them used to fail validation when they sat mid-list.
 * Instead they accumulate as pending sources, and the next step that accepts
 * inputs consumes them all: `[asset, scene, video]` wires the asset image
 * *and* the scene text into the video step, each landing on its own port by
 * kind affinity. A single output node collects the last step's result.
 *
 * Exported for its tests.
 */
export function assembleWorkflow(base: Workflow, name: string, steps: WorkflowNode[]): Workflow {
  const nodes: WorkflowNode[] = steps.map((node, index) => ({
    ...node,
    position: { x: index * 260, y: 0 },
  }));
  const edges: Workflow["edges"] = [];
  let pendingSources: string[] = [];
  for (const step of steps) {
    const accepts = (maybeNodeSchema(step.type)?.inputs.length ?? 0) > 0;
    if (accepts) {
      for (const source of pendingSources) {
        edges.push({ id: `${source}-${step.id}`, source, target: step.id });
      }
      pendingSources = [step.id];
    } else {
      pendingSources.push(step.id);
    }
  }
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

/** Gallery buckets an asset step's picker should offer for its chosen kind. */
function assetSheetKinds(nodeParams: Record<string, unknown>): ArtifactKind[] {
  const kind = nodeParams.assetKind;
  if (kind === "video") return ["video"];
  if (kind === "audio") return ["music", "speech", "sfx"];
  return ["image"];
}

function ParamField({
  param,
  value,
  nodeParams,
  catalog,
  onChange,
  onMerge,
}: {
  param: ParamSchema;
  value: unknown;
  /** The whole step's params, for picker labels and multi-key writes. */
  nodeParams: Record<string, unknown>;
  catalog: MediaCatalog;
  onChange: (value: unknown) => void;
  onMerge: (partial: Record<string, unknown>) => void;
}) {
  const models = useMemo(
    () => (param.type === "model" ? modelsForParam(catalog, param) : []),
    [param, catalog],
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  if (param.type === "artifact") {
    const label =
      typeof nodeParams.assetLabel === "string" && nodeParams.assetLabel
        ? nodeParams.assetLabel
        : "";
    return (
      <div className="mobile-workflow-param">
        <span>
          {param.label}
          {param.required ? " *" : ""}
        </span>
        <button
          type="button"
          className="mobile-workflow-select mobile-workflow-picker"
          onClick={() => setPickerOpen(true)}
        >
          {label || "Choose from the gallery"}
        </button>
        {pickerOpen ? (
          <ArtifactSheet
            kinds={assetSheetKinds(nodeParams)}
            onPick={(artifact) =>
              onMerge({
                [param.name]: artifact.id,
                assetLabel: artifact.prompt || artifact.fileName,
              })
            }
            onClose={() => setPickerOpen(false)}
          />
        ) : null}
      </div>
    );
  }

  if (param.type === "note") {
    const label =
      typeof nodeParams.noteTitle === "string" && nodeParams.noteTitle ? nodeParams.noteTitle : "";
    return (
      <div className="mobile-workflow-param">
        <span>
          {param.label}
          {param.required ? " *" : ""}
        </span>
        <button
          type="button"
          className="mobile-workflow-select mobile-workflow-picker"
          onClick={() => setPickerOpen(true)}
        >
          {label || "Choose a note"}
        </button>
        {pickerOpen ? (
          <NoteSheet
            onPick={(note) =>
              onMerge({ [param.name]: note.id, noteTitle: note.title || "Untitled note" })
            }
            onClose={() => setPickerOpen(false)}
          />
        ) : null}
      </div>
    );
  }

  if (param.type === "model") {
    const current = typeof value === "string" ? value : "";
    const currentName = models.find((model) => model.id === current)?.name;
    return (
      <div className="mobile-workflow-param">
        <span>
          {param.label}
          {param.required ? " *" : ""}
        </span>
        <button
          type="button"
          className="mobile-workflow-select mobile-workflow-picker"
          onClick={() => setPickerOpen(true)}
        >
          {currentName || current || "Choose a model"}
        </button>
        {pickerOpen ? (
          <ModelSheet
            title={param.label}
            entries={models.map((model) => ({ id: model.id, name: model.name }))}
            selectedId={current}
            onSelect={(id) => {
              onChange(id);
              setPickerOpen(false);
            }}
            onClose={() => setPickerOpen(false)}
          />
        ) : null}
      </div>
    );
  }

  if (param.type === "enum") {
    const current = typeof value === "string" ? value : ((param.default as string) ?? "");
    return (
      <div className="mobile-workflow-param">
        <span>{param.label}</span>
        <button
          type="button"
          className="mobile-workflow-select mobile-workflow-picker"
          onClick={() => setPickerOpen(true)}
        >
          {current || "Choose"}
        </button>
        {pickerOpen ? (
          <OptionSheet
            title={param.label}
            options={param.enumValues ?? []}
            selected={current}
            onSelect={(option) => {
              // Switching an asset's kind invalidates the picked item.
              if (param.name === "assetKind") {
                onMerge({ assetKind: option, artifactId: "", assetLabel: "" });
              } else {
                onChange(option);
              }
              setPickerOpen(false);
            }}
            onClose={() => setPickerOpen(false)}
          />
        ) : null}
      </div>
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

/** Bottom sheet picking one gallery item for an asset step — the mobile
 * sibling of the desktop GalleryPicker's pull model. */
function ArtifactSheet({
  kinds,
  onPick,
  onClose,
}: {
  kinds: ArtifactKind[];
  onPick: (artifact: StudioArtifact) => void;
  onClose: () => void;
}) {
  const [artifacts, setArtifacts] = useState<StudioArtifact[] | null>(null);
  // A value-stable key: callers pass fresh array literals on every render.
  const kindsKey = kinds.join(",");

  useEffect(() => {
    let cancelled = false;
    const wanted = new Set(kindsKey.split(","));
    listArtifacts()
      .then((entries) => {
        if (!cancelled) setArtifacts(entries.filter((entry) => wanted.has(entry.kind)));
      })
      .catch(() => {
        if (!cancelled) setArtifacts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [kindsKey]);

  return (
    <div className="mobile-sheet-backdrop" onClick={onClose}>
      <div
        className="mobile-sheet"
        role="dialog"
        aria-label="Pick a gallery item"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="mobile-sheet-grabber" aria-hidden />
        <h2 className="mobile-sheet-title">From your gallery</h2>
        {artifacts === null ? (
          <Spinner />
        ) : artifacts.length === 0 ? (
          <p className="mobile-workflow-param-hint">Nothing of this kind in the gallery yet.</p>
        ) : (
          <ul className="mobile-sheet-list">
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <button
                  type="button"
                  className="mobile-sheet-item"
                  onClick={() => {
                    onPick(artifact);
                    onClose();
                  }}
                >
                  <ArtifactRowThumb artifact={artifact} />
                  <span>
                    <span className="mobile-sheet-item-title">
                      {artifact.prompt || artifact.fileName}
                    </span>
                    <span className="mobile-sheet-item-subtitle">{artifact.kind}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Image rows get a thumbnail; clips and tracks stay text-only — decoding a
 * whole video for a list row is what the thumbnail cache is protecting the
 * webview from. */
function ArtifactRowThumb({ artifact }: { artifact: StudioArtifact }) {
  const src = useArtifactThumbnail(artifact.kind === "image" ? artifact : null);
  if (artifact.kind !== "image" || !src) return null;
  return <img className="mobile-workflow-thumb" src={src} alt="" />;
}

/** Bottom sheet picking the note a document step reads from. */
function NoteSheet({
  onPick,
  onClose,
}: {
  onPick: (note: NoteListItemDto) => void;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState<NoteListItemDto[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listNotes()
      .then((response) => {
        if (!cancelled) setNotes(response.items);
      })
      .catch(() => {
        if (!cancelled) setNotes([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mobile-sheet-backdrop" onClick={onClose}>
      <div
        className="mobile-sheet"
        role="dialog"
        aria-label="Pick a note"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="mobile-sheet-grabber" aria-hidden />
        <h2 className="mobile-sheet-title">From your notes</h2>
        {notes === null ? (
          <Spinner />
        ) : notes.length === 0 ? (
          <p className="mobile-workflow-param-hint">No notes yet.</p>
        ) : (
          <ul className="mobile-sheet-list">
            {notes.map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  className="mobile-sheet-item"
                  onClick={() => {
                    onPick(note);
                    onClose();
                  }}
                >
                  <span>
                    <span className="mobile-sheet-item-title">{note.title || "Untitled note"}</span>
                    {note.preview ? (
                      <span className="mobile-sheet-item-subtitle">{note.preview}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Minimal bottom sheet for short fixed option lists (aspect ratios, styles):
 * the ModelSheet chrome without search or favorites, which would be noise for
 * a handful of values. */
function OptionSheet({
  title,
  options,
  selected,
  onSelect,
  onClose,
}: {
  title: string;
  options: string[];
  selected: string;
  onSelect: (option: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="mobile-sheet-backdrop" onClick={onClose}>
      <div
        className="mobile-sheet"
        role="dialog"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="mobile-sheet-grabber" aria-hidden />
        <h2 className="mobile-sheet-title">{title}</h2>
        <ul className="mobile-sheet-list">
          {options.map((option) => (
            <li key={option}>
              <button type="button" className="mobile-sheet-item" onClick={() => onSelect(option)}>
                <span className="mobile-sheet-item-title">{option}</span>
                {selected === option ? <IconCheckmark1Small size={16} aria-hidden /> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
