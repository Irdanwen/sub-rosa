import { t } from "../../../lib/i18n";
import { IconChevronRight } from "central-icons/IconChevronRight";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { useCallback, useEffect, useMemo, useState } from "react";
import { hapticNotify } from "../../../lib/haptics";
import type { MediaCatalog } from "../../../lib/studio/types";
import {
  estimateWorkflowCost,
  listWorkflows,
  needsRunConfirmation,
  type NodeRunResult,
  nodeCostMap,
  nodeSchema,
  saveWorkflow,
  templateWorkflows,
  type ValidationIssue,
  type Workflow,
  type WorkflowCostEstimate,
  WorkflowRunError,
  validateWorkflow,
} from "../../../lib/studio/workflow";
import {
  approveRunGates,
  dismissWorkflowRun,
  listResumableRuns,
  resumeWorkflowRun,
  runAndSaveWorkflow,
  type WorkflowRunSummary,
} from "../../../lib/studio/workflow-run";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Spinner } from "../../ui/Spinner";
import { runCostDescription, WorkflowEditor } from "./WorkflowEditor";

function stepCount(workflow: Workflow): number {
  return workflow.nodes.filter((node) => node.type !== "output").length;
}

/**
 * Mobile workflows hub: run a template, or build and run your own. The desktop's
 * free-form node canvas does not translate to a phone, so custom workflows are
 * edited as an ordered list of steps (see WorkflowEditor); the shared engine
 * runs them either way and results land in the gallery.
 */
export function FlowsPanel({
  catalog,
  onGenerated,
}: {
  catalog: MediaCatalog;
  onGenerated: () => void;
}) {
  const templates = useMemo(() => templateWorkflows(), []);
  const [saved, setSaved] = useState<Workflow[]>(() => listWorkflows());
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<Workflow | null>(null);
  /** Interrupted durable runs (ADR-0021), offered for resume. */
  const [resumable, setResumable] = useState<WorkflowRunSummary[]>([]);
  const [resuming, setResuming] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const refreshSaved = useCallback(() => setSaved(listWorkflows()), []);

  useEffect(() => {
    let cancelled = false;
    void listResumableRuns().then((runs) => {
      if (!cancelled) setResumable(runs);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const resume = useCallback(
    async (entry: WorkflowRunSummary) => {
      if (resuming) return;
      setResuming(entry.id);
      setResumeError(null);
      try {
        // A gate-held run continues through a one-tap approval (first
        // candidate per gate); an interrupted one just picks back up.
        if (entry.status === "awaitingGate") {
          await approveRunGates(entry.id);
        } else {
          await resumeWorkflowRun(entry.id);
        }
        hapticNotify("success");
        onGenerated();
        setResumable((entries) => entries.filter((candidate) => candidate.id !== entry.id));
      } catch (error) {
        hapticNotify("error");
        setResumeError(error instanceof Error ? error.message : "The resume failed.");
        setResumable((entries) => entries.filter((candidate) => candidate.id !== entry.id));
      } finally {
        setResuming(null);
      }
    },
    [resuming, onGenerated],
  );

  const dismissRun = useCallback(async (entry: WorkflowRunSummary) => {
    await dismissWorkflowRun(entry.id);
    setResumable((entries) => entries.filter((candidate) => candidate.id !== entry.id));
  }, []);

  const createNew = useCallback(() => {
    // Kept in memory only; the editor persists it on the first Save/Run so an
    // abandoned blank workflow does not clutter the list.
    const now = Date.now();
    setEditing({
      id: crypto.randomUUID(),
      name: "My workflow",
      nodes: [],
      edges: [],
      createdAt: now,
      updatedAt: now,
    });
  }, []);

  const duplicateTemplate = useCallback(
    (template: Workflow) => {
      const now = Date.now();
      const copy: Workflow = {
        ...template,
        id: crypto.randomUUID(),
        name: `${template.name} copy`,
        createdAt: now,
        updatedAt: now,
        nodes: template.nodes.map((node) => ({ ...node, params: { ...node.params } })),
        edges: template.edges.map((edge) => ({ ...edge })),
      };
      saveWorkflow(copy);
      refreshSaved();
      setEditing(copy);
    },
    [refreshSaved],
  );

  if (editing) {
    return (
      <WorkflowEditor
        workflow={editing}
        catalog={catalog}
        onBack={() => {
          setEditing(null);
          refreshSaved();
        }}
        onSaved={refreshSaved}
        onDeleted={() => {
          setEditing(null);
          refreshSaved();
        }}
        onGenerated={onGenerated}
      />
    );
  }

  if (selectedTemplate) {
    return (
      <TemplateRunner
        template={selectedTemplate}
        catalog={catalog}
        onBack={() => setSelectedTemplate(null)}
        onGenerated={onGenerated}
      />
    );
  }

  return (
    <div className="mobile-studio-form">
      <p className="mobile-flows-intro">
        {t(
          "Chained generations: one input, several models working in sequence. Results land in the gallery.",
        )}
      </p>

      {resumable.length > 0 ? (
        <ul className="mobile-flows-resume" aria-label={t("Interrupted productions")}>
          {resumable.map((entry) => (
            <li key={entry.id} className="mobile-flows-resume-row">
              <span className="mobile-flows-resume-name">{entry.name || "Untitled workflow"}</span>
              <span className="mobile-flows-resume-actions">
                <button
                  type="button"
                  className="mobile-chip-button"
                  disabled={resuming !== null}
                  onClick={() => void dismissRun(entry)}
                >
                  {t("Dismiss")}
                </button>
                <button
                  type="button"
                  className="mobile-chip-button"
                  disabled={resuming !== null}
                  onClick={() => void resume(entry)}
                >
                  {resuming === entry.id ? (
                    <Spinner />
                  ) : entry.status === "awaitingGate" ? (
                    "Approve and continue"
                  ) : (
                    "Resume"
                  )}
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {resumeError ? <p className="mobile-dictation-error">{resumeError}</p> : null}

      <button type="button" className="mobile-studio-generate" onClick={createNew}>
        <IconPlusMedium size={18} />
        {t("New workflow")}
      </button>

      {saved.length > 0 ? (
        <>
          <h3 className="mobile-flows-section">{t("Your workflows")}</h3>
          <ul className="mobile-sheet-list">
            {saved.map((workflow) => (
              <li key={workflow.id}>
                <button
                  type="button"
                  className="mobile-sheet-item"
                  onClick={() => setEditing(workflow)}
                >
                  <span>
                    <span className="mobile-sheet-item-title">{workflow.name}</span>
                    <span className="mobile-sheet-item-subtitle">
                      {t("{count} steps", { count: stepCount(workflow) })}
                    </span>
                  </span>
                  <IconChevronRight size={16} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h3 className="mobile-flows-section">{t("Templates")}</h3>
      <ul className="mobile-sheet-list">
        {templates.map((template) => (
          <li key={template.id} className="mobile-flows-template">
            <button
              type="button"
              className="mobile-sheet-item"
              onClick={() => setSelectedTemplate(template)}
            >
              <span>
                <span className="mobile-sheet-item-title">{template.name}</span>
                <span className="mobile-sheet-item-subtitle">
                  {t("{count} steps", { count: stepCount(template) })}
                </span>
              </span>
              <IconChevronRight size={16} aria-hidden />
            </button>
            <button
              type="button"
              className="mobile-flows-template-edit"
              onClick={() => duplicateTemplate(template)}
            >
              {t("Edit a copy")}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Runs a template through its text inputs: one field per `textInput` node, the
 * rest of the graph fixed. Deliverables save to the gallery. */
function TemplateRunner({
  template,
  catalog,
  onBack,
  onGenerated,
}: {
  template: Workflow;
  catalog: MediaCatalog;
  onBack: () => void;
  onGenerated: () => void;
}) {
  const [inputs, setInputs] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const node of template.nodes) {
      if (node.type === "textInput") {
        seed[node.id] = typeof node.params.text === "string" ? node.params.text : "";
      }
    }
    return seed;
  });
  const [results, setResults] = useState<Map<string, NodeRunResult> | null>(null);
  const [running, setRunning] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmRun, setConfirmRun] = useState<{
    workflow: Workflow;
    estimate: WorkflowCostEstimate;
  } | null>(null);

  const textInputs = useMemo(
    () => template.nodes.filter((node) => node.type === "textInput"),
    [template],
  );

  const launch = useCallback(
    async (workflow: Workflow, nodeCosts?: Record<string, number>) => {
      setRunning(true);
      const live = new Map<string, NodeRunResult>();
      setResults(new Map());
      try {
        const finished = await runAndSaveWorkflow(workflow, {
          nodeCosts,
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
    },
    [onGenerated],
  );

  const run = useCallback(() => {
    if (running) return;
    setError(null);
    setIssues([]);
    const workflow: Workflow = {
      ...template,
      nodes: template.nodes.map((node) =>
        node.type === "textInput"
          ? { ...node, params: { ...node.params, text: inputs[node.id] ?? "" } }
          : node,
      ),
    };
    const validation = validateWorkflow(workflow);
    if (!validation.ok) {
      setIssues([...validation.errors, ...validation.warnings]);
      return;
    }
    // Templates spend like any workflow: same pre-spend handshake.
    const estimate = estimateWorkflowCost(workflow, catalog);
    if (needsRunConfirmation(estimate)) {
      setConfirmRun({ workflow, estimate });
      return;
    }
    void launch(workflow, nodeCostMap(estimate));
  }, [template, running, inputs, catalog, launch]);

  return (
    <div className="mobile-studio-form">
      <button type="button" className="mobile-chip-button" onClick={onBack} disabled={running}>
        {t("All flows")}
      </button>
      <h3 className="mobile-flows-title">{template.name}</h3>
      {textInputs.map((node) => (
        <label key={node.id} className="mobile-flows-field">
          <span>{node.label}</span>
          <textarea
            className="mobile-studio-prompt"
            rows={2}
            value={inputs[node.id] ?? ""}
            onChange={(event) =>
              setInputs((current) => ({ ...current, [node.id]: event.target.value }))
            }
          />
        </label>
      ))}
      <button
        type="button"
        className="mobile-studio-generate"
        disabled={running || textInputs.some((node) => !(inputs[node.id] ?? "").trim())}
        onClick={run}
      >
        {running ? <Spinner /> : "Run flow"}
      </button>
      <ConfirmDialog
        open={confirmRun !== null}
        title={t("Run this flow?")}
        description={confirmRun ? runCostDescription(confirmRun.estimate) : ""}
        confirmLabel={t("Run")}
        onConfirm={() => {
          const pending = confirmRun;
          setConfirmRun(null);
          if (pending) void launch(pending.workflow, nodeCostMap(pending.estimate));
        }}
        onClose={() => setConfirmRun(null)}
      />
      {results ? (
        <ul className="mobile-flows-steps" aria-label={t("Flow progress")}>
          {template.nodes
            .filter((node) => node.type !== "textInput")
            .map((node) => {
              const state = results.get(node.id);
              const status = state?.status ?? "pending";
              return (
                <li key={node.id} className="mobile-flows-step" data-status={status}>
                  <span className="mobile-flows-step-label">
                    {node.label || nodeSchema(node.type).label}
                  </span>
                  <span className="mobile-flows-step-status">
                    {status === "running" ? (
                      <Spinner />
                    ) : status === "done" ? (
                      "Done"
                    ) : status === "error" ? (
                      "Failed"
                    ) : status === "awaiting" ? (
                      "Needs your approval"
                    ) : (
                      "Waiting"
                    )}
                  </span>
                  <FlowStepOutput state={state} />
                </li>
              );
            })}
        </ul>
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
    </div>
  );
}

/** Inline preview of a finished step: text snippet, image thumbnail, or a
 * pointer to the gallery for audio/video. Failures show their reason. */
export function FlowStepOutput({ state }: { state?: NodeRunResult }) {
  if (!state) return null;
  if (state.status === "error" && state.error) {
    return <p className="mobile-flows-output mobile-dictation-error">{state.error}</p>;
  }
  if (state.status === "awaiting") {
    return <p className="mobile-flows-output">{t("Paused here until you approve.")}</p>;
  }
  if (state.status !== "done" || !state.output) return null;
  const output = state.output;
  if (output.kind === "text" && output.text.trim()) {
    return <p className="mobile-flows-output">{output.text.slice(0, 220)}</p>;
  }
  if (output.kind === "image") {
    return (
      <img
        className="mobile-flows-output-image"
        src={`data:${output.mimeType};base64,${output.base64}`}
        alt={t("Step result")}
      />
    );
  }
  if (output.kind === "video" || output.kind === "audio") {
    return <p className="mobile-flows-output">{t("Saved to the gallery.")}</p>;
  }
  return null;
}
