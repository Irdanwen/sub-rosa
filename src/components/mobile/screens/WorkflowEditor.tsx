import { t } from "../../../lib/i18n";
import { IconArrowDown } from "central-icons/IconArrowDown";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useArtifactIndex, useArtifactThumbnail } from "../../../lib/artifact-media";
import { hapticImpact, hapticNotify } from "../../../lib/haptics";
import { formatCredits } from "../../../lib/studio/catalog";
import { listArtifacts } from "../../../lib/studio/artifacts";
import type { ArtifactKind, MediaCatalog, StudioArtifact } from "../../../lib/studio/types";
import { listNotes, type NoteListItemDto } from "../../../lib/tauri";
import {
  awaitingGateIds,
  defaultParams,
  deleteWorkflow,
  effectiveParamValue,
  estimateWorkflowCost,
  INPUT_MARKER,
  maybeNodeSchema,
  modelParamPatch,
  modelsForParam,
  needsRunConfirmation,
  type NodeRunResult,
  nodeCostMap,
  nodeSchema,
  openInputPorts,
  type ParamSchema,
  paramApplies,
  paramOptions,
  saveWorkflow,
  textSourceLabels,
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
import { AssetPreview } from "../../studio/AssetPreview";
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
  /** One gallery listing for the whole editor, so a step can show the asset
   * it points at without a listing per step. */
  const artifacts = useArtifactIndex();

  const assembled = useMemo(() => assembleWorkflow(workflow, name, steps), [workflow, name, steps]);
  /** Which steps feed each step's text input, named. Read off the assembled
   * chain rather than guessed from the list order: a step that takes no text
   * is not in anyone's way, and the marker must only be offered where it
   * would do something. */
  const textFeeds = useMemo(
    () => new Map(steps.map((node) => [node.id, textSourceLabels(assembled, node.id)])),
    [assembled, steps],
  );
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

  /** Naming a step names it everywhere the flow reports on itself. */
  const rename = useCallback((id: string, label: string) => {
    setSteps((current) => current.map((node) => (node.id === id ? { ...node, label } : node)));
  }, []);

  const addStep = useCallback((type: WorkflowNodeType) => {
    const schema = nodeSchema(type);
    setSteps((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        type,
        // Unnamed: the type stands in as the placeholder until the user gives
        // the step a name of its own.
        label: "",
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
        setError(err instanceof Error ? t(err.message) : t("The workflow failed."));
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
        {t("All flows")}
      </button>

      <label className="mobile-flows-field">
        <span>{t("Name")}</span>
        <input
          className="mobile-studio-search"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("My workflow")}
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
                {/* The step's own name, its type standing in until it has one
                    (the same field as the desktop's node title). */}
                <input
                  className="mobile-workflow-step-title"
                  value={node.label}
                  placeholder={schema.label}
                  aria-label={t("{step} name", { step: schema.label })}
                  disabled={running}
                  onChange={(event) => rename(node.id, event.target.value)}
                />
                {node.label.trim() ? (
                  <span className="mobile-workflow-step-type">{schema.label}</span>
                ) : null}
                <span className="mobile-workflow-step-actions">
                  <button
                    type="button"
                    aria-label={t("Move up")}
                    disabled={index === 0 || running}
                    onClick={() => move(index, -1)}
                  >
                    <IconArrowUp size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label={t("Move down")}
                    disabled={index === steps.length - 1 || running}
                    onClick={() => move(index, 1)}
                  >
                    <IconArrowDown size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label={t("Remove step")}
                    disabled={running}
                    onClick={() => remove(node.id)}
                  >
                    <IconTrashCan size={16} />
                  </button>
                </span>
              </div>
              <p className="mobile-workflow-step-desc">{schema.description}</p>
              <div className="mobile-workflow-step-params">
                {schema.params
                  // Settings the chosen model does not have are not shown (an
                  // image-to-video model has no aspect ratio).
                  .filter((param) => paramApplies(param, node.params, catalog))
                  .map((param) => (
                    <ParamField
                      key={param.name}
                      param={param}
                      value={node.params[param.name]}
                      nodeType={node.type}
                      nodeParams={node.params}
                      catalog={catalog}
                      artifacts={artifacts}
                      textSources={textFeeds.get(node.id) ?? []}
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
            {t("Cancel")}
          </button>
        </div>
      ) : (
        <button type="button" className="mobile-chip-button" onClick={() => setAdding(true)}>
          {t("Add step")}
        </button>
      )}

      {estimate.credits > 0 || estimate.metered > 0 ? (
        <p className="mobile-workflow-cost">
          {estimate.credits > 0
            ? estimate.metered > 0
              ? t("One run: about {credits} plus usage", {
                  credits: formatCredits(estimate.credits),
                })
              : t("One run: about {credits}", { credits: formatCredits(estimate.credits) })
            : t("One run: usage priced")}
        </p>
      ) : null}

      <div className="mobile-workflow-editor-actions">
        <button
          type="button"
          className="mobile-chip-button"
          onClick={persist}
          disabled={running || steps.length === 0}
        >
          {savedTick ? t("Saved") : t("Save")}
        </button>
        <button
          type="button"
          className="mobile-studio-generate"
          onClick={run}
          disabled={running || steps.length === 0}
        >
          {running ? <Spinner /> : t("Run flow")}
        </button>
      </div>

      {paused ? (
        <p className="mobile-workflow-cost">
          {t("Paused at an approval gate. Approve it from the flows list to continue.")}
        </p>
      ) : null}
      {issues.length > 0 ? (
        <ul className="mobile-flows-issues" aria-label={t("Flow problems")}>
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
        {t("Delete workflow")}
      </button>

      <ConfirmDialog
        open={confirmDelete}
        title={t("Delete this workflow?")}
        description={t("This removes the workflow. Generated media in your gallery is kept.")}
        confirmLabel={t("Delete")}
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
        title={t("Run this flow?")}
        description={confirmRun ? runCostDescription(confirmRun) : ""}
        confirmLabel={t("Run")}
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
    return estimate.metered === 1
      ? t("One run is expected to spend at least {credits}; 1 step is usage priced on top.", {
          credits: formatCredits(estimate.credits),
        })
      : t(
          "One run is expected to spend at least {credits}; {count} steps are usage priced on top.",
          { credits: formatCredits(estimate.credits), count: estimate.metered },
        );
  }
  if (estimate.credits > 0) {
    return t("One run is expected to spend about {credits}.", {
      credits: formatCredits(estimate.credits),
    });
  }
  return t("This flow bills by usage; no flat figure is published for its steps.");
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
    // What the step carries with the model it is set to: a port its model
    // closed is not one an upstream step can be chained onto.
    const stepSchema = maybeNodeSchema(step.type);
    const accepts = stepSchema ? openInputPorts(stepSchema, step.params).length > 0 : false;
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
      label: t("Result"),
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
  nodeType,
  nodeParams,
  catalog,
  artifacts,
  textSources,
  onChange,
  onMerge,
}: {
  param: ParamSchema;
  value: unknown;
  /** The step's type, for the sibling params a model pick has to re-settle. */
  nodeType: WorkflowNodeType;
  /** The whole step's params, for picker labels and multi-key writes. */
  nodeParams: Record<string, unknown>;
  catalog: MediaCatalog;
  /** The editor's one gallery listing, so a picked asset can be shown. */
  artifacts: ReturnType<typeof useArtifactIndex>;
  /** The steps feeding this one's text input, named. Empty when there is no
   * upstream text, which is when `{{input}}` means nothing. */
  textSources: string[];
  onChange: (value: unknown) => void;
  onMerge: (partial: Record<string, unknown>) => void;
}) {
  const models = useMemo(
    () => (param.type === "model" ? modelsForParam(catalog, param) : []),
    [param, catalog],
  );
  const stepSchema = nodeSchema(nodeType);
  const modelId = typeof nodeParams.model === "string" ? nodeParams.model : "";
  /** Values this param's model publishes, empty when it is free text. */
  const options = useMemo(
    () => paramOptions(param, nodeParams, catalog),
    // biome-ignore lint/correctness/useExhaustiveDependencies: the options
    // follow the model, not every keystroke in the params next to it.
    [param, modelId, catalog],
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  /** The prompt field, so the marker lands at the caret, not at the end. */
  const promptRef = useRef<HTMLTextAreaElement>(null);

  if (param.modelOptions && options.length > 0) {
    // The value shown is the one that will be sent: the request builder picks
    // the first option when the stored one is not on offer.
    const current = effectiveParamValue(options, value);
    return (
      <div className="mobile-workflow-param">
        <span>{param.label}</span>
        <button
          type="button"
          className="mobile-workflow-select mobile-workflow-picker"
          onClick={() => setPickerOpen(true)}
        >
          {current}
        </button>
        {pickerOpen ? (
          <OptionSheet
            title={param.label}
            options={options}
            selected={current}
            onSelect={(option) => {
              onChange(option);
              setPickerOpen(false);
            }}
            onClose={() => setPickerOpen(false)}
          />
        ) : null}
      </div>
    );
  }

  if (param.type === "artifact") {
    const label =
      typeof nodeParams.assetLabel === "string" && nodeParams.assetLabel
        ? nodeParams.assetLabel
        : "";
    const artifactId = typeof value === "string" ? value : "";
    return (
      <div className="mobile-workflow-param">
        <span>
          {param.label}
          {param.required ? " *" : ""}
        </span>
        {artifactId ? (
          <AssetPreview
            artifact={artifacts.byId.get(artifactId)}
            loaded={artifacts.loaded}
            className="mobile-workflow-asset"
          />
        ) : null}
        <button
          type="button"
          className="mobile-workflow-select mobile-workflow-picker"
          onClick={() => setPickerOpen(true)}
        >
          {label || t("Choose from the gallery")}
        </button>
        {pickerOpen ? (
          <ArtifactSheet
            kinds={assetSheetKinds(nodeParams)}
            onPick={(artifact) => {
              // Filed straight into the index so the preview appears with the
              // pick rather than after the next gallery listing.
              artifacts.remember(artifact);
              onMerge({
                [param.name]: artifact.id,
                assetLabel: artifact.prompt || artifact.fileName,
              });
            }}
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
          {label || t("Choose a note")}
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
          {currentName || current || t("Choose a model")}
        </button>
        {pickerOpen ? (
          <ModelSheet
            title={param.label}
            entries={models.map((model) => ({ id: model.id, name: model.name }))}
            selectedId={current}
            onSelect={(id) => {
              // Through the shared patch, so the step records the model's
              // direction and re-settles its option-driven params exactly as
              // the desktop does.
              onMerge(
                modelParamPatch(
                  stepSchema,
                  nodeParams,
                  param,
                  models.find((model) => model.id === id),
                ),
              );
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
          {current || t("Choose")}
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
    const text = typeof value === "string" ? value : "";
    // Offered only where the marker means something: the step above has to be
    // feeding this one text for there to be an input to place.
    const offerMarker = param.acceptsInputMarker === true && textSources.length > 0;
    const placed = text.includes(INPUT_MARKER);
    return (
      <label className="mobile-workflow-param">
        <span>
          {param.label}
          {param.required ? " *" : ""}
        </span>
        <textarea
          ref={promptRef}
          className="mobile-studio-prompt"
          rows={2}
          value={text}
          placeholder={param.description}
          onChange={(event) => onChange(event.target.value)}
        />
        {offerMarker ? (
          <button
            type="button"
            className="mobile-chip-button mobile-workflow-marker"
            disabled={placed}
            // Keeps the caret where the user last was in the prompt.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const field = promptRef.current;
              const from = field?.selectionStart ?? text.length;
              const to = field?.selectionEnd ?? from;
              onChange(`${text.slice(0, from)}${INPUT_MARKER}${text.slice(to)}`);
              const caret = from + INPUT_MARKER.length;
              requestAnimationFrame(() => {
                field?.focus();
                field?.setSelectionRange(caret, caret);
              });
            }}
          >
            {placed
              ? t("{marker} is placed", { marker: INPUT_MARKER })
              : textSources.length === 1
                ? t("Insert {marker} ({name})", { marker: INPUT_MARKER, name: textSources[0] })
                : t("Insert {marker}", { marker: INPUT_MARKER })}
          </button>
        ) : null}
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
        aria-label={t("Pick a gallery item")}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="mobile-sheet-grabber" aria-hidden />
        <h2 className="mobile-sheet-title">{t("From your gallery")}</h2>
        {artifacts === null ? (
          <Spinner />
        ) : artifacts.length === 0 ? (
          <p className="mobile-workflow-param-hint">
            {t("Nothing of this kind in the gallery yet.")}
          </p>
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
  const thumbnail = useArtifactThumbnail(artifact.kind === "image" ? artifact : null);
  if (artifact.kind !== "image" || !thumbnail) return null;
  return <img className="mobile-workflow-thumb" src={thumbnail.src} alt="" />;
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
        aria-label={t("Pick a note")}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="mobile-sheet-grabber" aria-hidden />
        <h2 className="mobile-sheet-title">{t("From your notes")}</h2>
        {notes === null ? (
          <Spinner />
        ) : notes.length === 0 ? (
          <p className="mobile-workflow-param-hint">{t("No notes yet.")}</p>
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
                    <span className="mobile-sheet-item-title">
                      {note.title || t("Untitled note")}
                    </span>
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
