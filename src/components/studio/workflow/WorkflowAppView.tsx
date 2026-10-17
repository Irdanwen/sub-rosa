// A workflow shown as an app (ADR-0119): its few fields, a run button and
// the results it gives, over the same graph the canvas draws. Filling a
// field in edits the step it belongs to; running is running the workflow.

import type { ArtifactIndex } from "./flow";
import { t } from "../../../lib/i18n";
import type { MediaCatalog } from "../../../lib/studio/types";
import type { WorkflowCostEstimate } from "../../../lib/studio/workflow";
import { shownFields } from "../../../lib/studio/workflow/app";
import { nodeTypeLabel } from "../../../lib/studio/workflow/labels";
import type { NodeRunResult } from "../../../lib/studio/workflow/run-types";
import type { Workflow } from "../../../lib/studio/workflow/schema";
import { EmptyState } from "../../ui/EmptyState";
import { NodeOutputView } from "./NodeOutputView";
import { ParamControl } from "./ParamField";
import { costSummary } from "./RunCostDialog";
import { RunButton } from "./WorkflowToolbar";

export function WorkflowAppView({
  workflow,
  catalog,
  artifacts,
  results,
  constraintEpoch,
  onParamsChange,
  estimate,
  run,
  onBuild,
}: {
  workflow: Workflow;
  catalog: MediaCatalog;
  artifacts: ArtifactIndex;
  results: ReadonlyMap<string, NodeRunResult>;
  constraintEpoch: number;
  onParamsChange: (nodeId: string, params: Record<string, unknown>) => void;
  estimate: WorkflowCostEstimate | undefined;
  run: Parameters<typeof RunButton>[0];
  onBuild: () => void;
}) {
  const fields = shownFields(workflow.app, workflow, catalog);
  const outputs = (workflow.app?.outputs ?? []).flatMap((id) => {
    const node = workflow.nodes.find((entry) => entry.id === id);
    return node ? [node] : [];
  });
  if (fields.length === 0 && outputs.length === 0)
    return (
      <EmptyState
        title={t("This workflow is not an app yet")}
        description={t(
          "Choose the few settings a person fills in and the results they get. The graph stays as it is.",
        )}
        action={
          <button type="button" className="studio-primary-button" onClick={onBuild}>
            {t("Make it an app")}
          </button>
        }
      />
    );
  return (
    <section className="workflow-app" aria-label={t("App")}>
      <header className="workflow-app-head">
        <div>
          <h2>{workflow.name || t("Untitled workflow")}</h2>
          {workflow.app?.intro ? <p>{workflow.app.intro}</p> : null}
        </div>
        <button type="button" className="btn btn-secondary" onClick={onBuild}>
          {t("Edit the app")}
        </button>
      </header>
      <form
        className="workflow-app-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!run.running && run.canRun && !run.quoting) run.onRun();
        }}
      >
        {fields.map(({ field, node, param }) => (
          <div key={`${node.id}:${param.name}`} className="workflow-app-field">
            <span className="workflow-app-step">
              {field.label || node.label || nodeTypeLabel(node.type)}
            </span>
            <ParamControl
              node={node}
              param={param}
              catalog={catalog}
              artifacts={artifacts}
              textSources={[]}
              constraintEpoch={constraintEpoch}
              onMerge={(partial) => onParamsChange(node.id, { ...node.params, ...partial })}
            />
          </div>
        ))}
        <div className="workflow-app-run">
          {estimate && (estimate.credits > 0 || estimate.metered > 0) ? (
            <span className="studio-workflow-cost">{costSummary(estimate)}</span>
          ) : null}
          <RunButton {...run} />
        </div>
      </form>
      {outputs.length > 0 ? (
        <section className="workflow-app-results" aria-label={t("Results")}>
          {outputs.map((node) => {
            const result = results.get(node.id);
            return (
              <figure key={node.id} className="workflow-app-result">
                <figcaption>{node.label || nodeTypeLabel(node.type)}</figcaption>
                {result ? (
                  <NodeOutputView result={result} node={node} />
                ) : (
                  <p className="workflow-app-waiting">{t("Shows here after a run.")}</p>
                )}
              </figure>
            );
          })}
        </section>
      ) : null}
    </section>
  );
}
