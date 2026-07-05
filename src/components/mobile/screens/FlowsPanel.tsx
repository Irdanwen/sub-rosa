import { IconChevronRight } from "central-icons/IconChevronRight";
import { useCallback, useMemo, useState } from "react";
import { hapticNotify } from "../../../lib/haptics";
import {
  type NodeRunResult,
  type ValidationIssue,
  type Workflow,
  WorkflowRunError,
  nodeSchema,
  runWorkflow,
  templateWorkflows,
  validateWorkflow,
} from "../../../lib/studio/workflow";
import { Spinner } from "../../ui/Spinner";

/**
 * Mobile workflows: the desktop's node canvas does not translate to a phone,
 * but the underlying engine does. Templates render as a guided form (one
 * field per text input), then run level by level with a live per-step
 * checklist. Generated media lands in the shared gallery.
 */
export function FlowsPanel({ onGenerated }: { onGenerated: () => void }) {
  const templates = useMemo(() => templateWorkflows(), []);
  const [selected, setSelected] = useState<Workflow | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Map<string, NodeRunResult> | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const textInputs = useMemo(
    () => (selected ? selected.nodes.filter((node) => node.type === "textInput") : []),
    [selected],
  );

  const openTemplate = useCallback((template: Workflow) => {
    setSelected(template);
    setResults(null);
    setError(null);
    const seed: Record<string, string> = {};
    for (const node of template.nodes) {
      if (node.type === "textInput") {
        seed[node.id] = typeof node.params.text === "string" ? node.params.text : "";
      }
    }
    setInputs(seed);
  }, []);

  const [issues, setIssues] = useState<ValidationIssue[]>([]);

  const run = useCallback(async () => {
    if (!selected || running) return;
    setRunning(true);
    setError(null);
    setIssues([]);
    const workflow: Workflow = {
      ...selected,
      nodes: selected.nodes.map((node) =>
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
      const finished = await runWorkflow(workflow, {
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
      if (err instanceof WorkflowRunError) {
        setResults(new Map(err.results));
      }
      setError(err instanceof Error ? err.message : "The workflow failed.");
    } finally {
      setRunning(false);
    }
  }, [selected, running, inputs, onGenerated]);

  if (!selected) {
    return (
      <div className="mobile-studio-form">
        <p className="mobile-flows-intro">
          Chained generations: one input, several models working in sequence. Results land in the
          gallery.
        </p>
        <ul className="mobile-sheet-list">
          {templates.map((template) => (
            <li key={template.id}>
              <button
                type="button"
                className="mobile-sheet-item"
                onClick={() => openTemplate(template)}
              >
                <span>
                  <span className="mobile-sheet-item-title">{template.name}</span>
                  <span className="mobile-sheet-item-subtitle">{template.nodes.length} steps</span>
                </span>
                <IconChevronRight size={16} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="mobile-studio-form">
      <button
        type="button"
        className="mobile-chip-button"
        onClick={() => setSelected(null)}
        disabled={running}
      >
        All flows
      </button>
      <h3 className="mobile-flows-title">{selected.name}</h3>
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
          {selected.nodes
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
          {issues.map((issue, index) => (
            <li key={index} className="mobile-dictation-error">
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
function FlowStepOutput({ state }: { state?: NodeRunResult }) {
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
