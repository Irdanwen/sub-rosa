import { IconChevronRight } from "central-icons/IconChevronRight";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { useCallback, useMemo, useState } from "react";
import { hapticNotify } from "../../../lib/haptics";
import type { MediaCatalog } from "../../../lib/studio/types";
import {
  listWorkflows,
  type NodeRunResult,
  nodeSchema,
  saveWorkflow,
  templateWorkflows,
  type ValidationIssue,
  type Workflow,
  WorkflowRunError,
  validateWorkflow,
} from "../../../lib/studio/workflow";
import { runAndSaveWorkflow } from "../../../lib/studio/workflow-run";
import { Spinner } from "../../ui/Spinner";
import { WorkflowEditor } from "./WorkflowEditor";

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

  const refreshSaved = useCallback(() => setSaved(listWorkflows()), []);

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
        onBack={() => setSelectedTemplate(null)}
        onGenerated={onGenerated}
      />
    );
  }

  return (
    <div className="mobile-studio-form">
      <p className="mobile-flows-intro">
        Chained generations: one input, several models working in sequence. Results land in the
        gallery.
      </p>
      <button type="button" className="mobile-studio-generate" onClick={createNew}>
        <IconPlusMedium size={18} />
        New workflow
      </button>

      {saved.length > 0 ? (
        <>
          <h3 className="mobile-flows-section">Your workflows</h3>
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
                    <span className="mobile-sheet-item-subtitle">{stepCount(workflow)} steps</span>
                  </span>
                  <IconChevronRight size={16} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h3 className="mobile-flows-section">Templates</h3>
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
                <span className="mobile-sheet-item-subtitle">{stepCount(template)} steps</span>
              </span>
              <IconChevronRight size={16} aria-hidden />
            </button>
            <button
              type="button"
              className="mobile-flows-template-edit"
              onClick={() => duplicateTemplate(template)}
            >
              Edit a copy
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
  onBack,
  onGenerated,
}: {
  template: Workflow;
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

  const textInputs = useMemo(
    () => template.nodes.filter((node) => node.type === "textInput"),
    [template],
  );

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
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
      setRunning(false);
      return;
    }
    const live = new Map<string, NodeRunResult>();
    setResults(new Map());
    try {
      const finished = await runAndSaveWorkflow(workflow, {
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
  }, [template, running, inputs, onGenerated]);

  return (
    <div className="mobile-studio-form">
      <button type="button" className="mobile-chip-button" onClick={onBack} disabled={running}>
        All flows
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
        onClick={() => void run()}
      >
        {running ? <Spinner /> : "Run flow"}
      </button>
      {results ? (
        <ul className="mobile-flows-steps" aria-label="Flow progress">
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
        alt="Step result"
      />
    );
  }
  if (output.kind === "video" || output.kind === "audio") {
    return <p className="mobile-flows-output">Saved to the gallery.</p>;
  }
  return null;
}
