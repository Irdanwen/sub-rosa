// One app, on the phone (ADR-0119): its fields, what a run is expected to
// cost (asked before anything is spent), the run itself through the same
// durable engine as the desktop, its results, and a gate's candidates to
// choose from when the run holds for approval. The graph is never drawn.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlayableMediaUrl } from "../../../../lib/artifact-media";
import { t } from "../../../../lib/i18n";
import { listArtifacts } from "../../../../lib/studio/artifacts";
import type { MediaCatalog, StudioArtifact } from "../../../../lib/studio/types";
import {
  needsRunConfirmation,
  nodeCostMap,
  type NodeRunResult,
  type Workflow,
  WorkflowRunError,
} from "../../../../lib/studio/workflow";
import { shownFields } from "../../../../lib/studio/workflow/app";
import {
  appBlocker,
  appEstimate,
  appGraph,
  appResults,
  heldGate,
  needsWindowOpen,
} from "../../../../lib/studio/workflow/app-run";
import { nodeTypeLabel } from "../../../../lib/studio/workflow/labels";
import type { NodeOutput } from "../../../../lib/studio/workflow/run-types";
import { spendGuard } from "../../../../lib/studio/workflow/spend";
import { readSpendCeiling } from "../../../../lib/studio/workflow/spend-ceiling";
import { saveWorkflow } from "../../../../lib/studio/workflow/store";
import {
  resumeWorkflowRun,
  runAndSaveWorkflow,
  runResults,
  workflowRunHistory,
  workflowStepCache,
} from "../../../../lib/studio/workflow-run";
import { Spinner } from "../../../ui/Spinner";
import { ActionSheet } from "../../ActionSheet";
import { costSummary } from "../../../studio/workflow/RunCostDialog";
import { itemName } from "../../../studio/workflow/NodeOutputView";
import { keyed } from "../../../../lib/keyed";
import { AppField } from "./AppField";

export function AppRunScreen({
  workflow: opened,
  catalog,
}: {
  workflow: Workflow;
  catalog: MediaCatalog;
}) {
  const [workflow, setWorkflow] = useState(opened);
  const graph = useMemo(() => appGraph(workflow), [workflow]);
  const estimate = useMemo(() => appEstimate(graph, catalog), [graph, catalog]);
  const blocker = appBlocker(graph);
  const fields = shownFields(workflow.app, workflow, catalog);
  const [results, setResults] = useState<Map<string, NodeRunResult>>(new Map());
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const runIdRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);

  // What the last run made shows again when the app is opened.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const last = (await workflowRunHistory(opened.id)).find((entry) => entry.done > 0);
      if (!last || cancelled) return;
      runIdRef.current = last.id;
      const { results: past } = await runResults(last.id);
      if (!cancelled) setResults((live) => (live.size > 0 ? live : past));
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [opened.id]);

  // The app's fields are the workflow's own settings: kept as typed, saved
  // once typing pauses rather than at every keystroke.
  const workflowRef = useRef(workflow);
  workflowRef.current = workflow;
  const saveTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(saveTimer.current), []);
  const edit = useCallback((nodeId: string, partial: Record<string, unknown>) => {
    const current = workflowRef.current;
    const next = {
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId ? { ...node, params: { ...node.params, ...partial } } : node,
      ),
    };
    workflowRef.current = next;
    setWorkflow(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => saveWorkflow(workflowRef.current), 400);
  }, []);

  const update = useCallback(
    (result: NodeRunResult) => setResults((current) => new Map(current).set(result.nodeId, result)),
    [],
  );

  const run = useCallback(async () => {
    setConfirming(false);
    setError(undefined);
    setRunning(true);
    setResults(new Map());
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await runAndSaveWorkflow(graph.effective, {
        signal: controller.signal,
        scheduling: "ready",
        isolateFailures: true,
        nodeCosts: nodeCostMap(estimate),
        beforeNode: spendGuard(estimate, { unpriced: "allow", ceiling: readSpendCeiling() }),
        cache: workflowStepCache(workflow.id),
        onRunRecorded: (runId) => {
          runIdRef.current = runId;
        },
        onUpdate: update,
      });
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError"))
        setError(
          cause instanceof WorkflowRunError || cause instanceof Error
            ? cause.message
            : t("The run failed."),
        );
    } finally {
      setRunning(false);
    }
  }, [graph, estimate, workflow.id, update]);

  const approve = useCallback(
    async (gateId: string, choice: string) => {
      const runId = runIdRef.current;
      if (!runId) return;
      setRunning(true);
      setError(undefined);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await resumeWorkflowRun(runId, {
          signal: controller.signal,
          beforeNode: spendGuard(estimate, { unpriced: "allow" }),
          cache: workflowStepCache(workflow.id),
          scheduling: "ready",
          isolateFailures: true,
          approvedGates: new Map([[gateId, choice]]),
          onUpdate: update,
        });
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === "AbortError"))
          setError(cause instanceof Error ? cause.message : t("The approval failed."));
      } finally {
        setRunning(false);
      }
    },
    [estimate, workflow.id, update],
  );

  const shown = appResults(results, graph);
  const gate = running ? undefined : heldGate(results, graph);
  const outputs = (workflow.app?.outputs ?? []).flatMap((id) => {
    const node = workflow.nodes.find((entry) => entry.id === id);
    return node ? [node] : [];
  });
  const windowOpen = needsWindowOpen(graph);
  const start = () => {
    if (needsRunConfirmation(estimate) || windowOpen) setConfirming(true);
    else void run();
  };

  return (
    <div className="mobile-app">
      {workflow.app?.intro ? <p className="mobile-app-intro">{workflow.app.intro}</p> : null}
      <div className="mobile-app-fields">
        {fields.map((entry) => (
          <AppField
            key={`${entry.node.id}:${entry.param.name}`}
            shown={entry}
            catalog={catalog}
            onMerge={(partial) => edit(entry.node.id, partial)}
          />
        ))}
      </div>
      {blocker ? <p className="mobile-app-blocker">{blocker}</p> : null}
      {error ? (
        <p className="mobile-dictation-error" role="alert">
          {error}
        </p>
      ) : null}
      {running ? (
        <button
          type="button"
          className="mobile-studio-generate"
          onClick={() => abortRef.current?.abort()}
        >
          <Spinner /> {t("Stop")}
        </button>
      ) : (
        <button
          type="button"
          className="mobile-studio-generate"
          disabled={Boolean(blocker)}
          onClick={start}
        >
          {estimate.credits > 0 || estimate.metered > 0
            ? t("Run, {price}", { price: costSummary(estimate) })
            : t("Run")}
        </button>
      )}
      {gate ? (
        <section className="mobile-app-gate" aria-label={t("Waiting for your approval")}>
          <p>{gate.note || t("The production is waiting for your approval.")}</p>
          {gate.candidates.map((candidate) => (
            <div key={candidate.id} className="mobile-app-candidate">
              {candidate.result?.output ? <OutputView output={candidate.result.output} /> : null}
              <button
                type="button"
                className="mobile-chip-button"
                onClick={() => void approve(gate.gateId, candidate.id)}
              >
                {t("Continue with {name}", {
                  name: candidate.label || t("this one"),
                })}
              </button>
            </div>
          ))}
        </section>
      ) : null}
      {outputs.length > 0 ? (
        <section className="mobile-app-results" aria-label={t("Results")}>
          {outputs.map((node) => {
            const result = shown.get(node.id);
            return (
              <figure key={node.id} className="mobile-app-result">
                <figcaption>{node.label || nodeTypeLabel(node.type)}</figcaption>
                {result?.status === "running" ? (
                  <Spinner />
                ) : result?.status === "error" ? (
                  <p className="mobile-dictation-error">{result.error}</p>
                ) : result?.items?.length ? (
                  keyed(result.items, itemName).map(({ key, value }) => (
                    <OutputView key={key} output={value} />
                  ))
                ) : result?.output ? (
                  <OutputView output={result.output} />
                ) : (
                  <p className="mobile-app-waiting">{t("Shows here after a run.")}</p>
                )}
              </figure>
            );
          })}
        </section>
      ) : null}
      {confirming ? (
        <ActionSheet
          title={t("Run this app?")}
          subtitle={[
            estimate.credits > 0 || estimate.metered > 0 ? costSummary(estimate) : undefined,
            windowOpen
              ? t("It finishes the cut on this phone: keep Sub Rosa open until it is done.")
              : undefined,
          ]
            .filter(Boolean)
            .join(" · ")}
          actions={[{ label: t("Run"), onAction: () => void run() }]}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}

/** A result as the phone shows it: a picture from its bytes, a clip or a
 * track streamed from the gallery copy, words as words. */
function OutputView({ output }: { output: NodeOutput }) {
  if (output.kind === "text") return <p className="mobile-app-text">{output.text}</p>;
  if (output.kind === "image")
    return (
      <img
        className="mobile-app-image"
        src={`data:${output.mimeType};base64,${output.base64}`}
        alt=""
      />
    );
  return <GalleryMedia kind={output.kind} artifactId={output.artifactId} />;
}

function GalleryMedia({ kind, artifactId }: { kind: "video" | "audio"; artifactId?: string }) {
  const [artifact, setArtifact] = useState<StudioArtifact | null>(null);
  useEffect(() => {
    if (!artifactId) return;
    void listArtifacts()
      .then((items) => setArtifact(items.find((item) => item.id === artifactId) ?? null))
      .catch(() => setArtifact(null));
  }, [artifactId]);
  const { src, onError } = usePlayableMediaUrl(artifact);
  if (!src) return <p className="mobile-app-waiting">{t("Saved to the gallery.")}</p>;
  return kind === "video" ? (
    // biome-ignore lint/a11y/useMediaCaption: a generated clip has no captions to offer.
    <video className="mobile-app-image" src={src} controls playsInline onError={onError} />
  ) : (
    // biome-ignore lint/a11y/useMediaCaption: a generated track has no captions to offer.
    <audio src={src} controls onError={onError} />
  );
}
