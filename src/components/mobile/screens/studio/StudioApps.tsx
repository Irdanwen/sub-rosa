// The phone's apps (ADR-0119): the workflows a person made apps of, and the
// shipped ones they can start from, each opening as its form. A run the
// phone left unfinished (the app closed, the phone slept past its grace) is
// offered again here, and only here: resuming spends, so a person asks for it.

import { useCallback, useEffect, useState } from "react";
import { t } from "../../../../lib/i18n";
import type { MediaCatalog } from "../../../../lib/studio/types";
import {
  estimateWorkflowCost,
  templateWorkflows,
  type Workflow,
} from "../../../../lib/studio/workflow";
import { spendGuard } from "../../../../lib/studio/workflow/spend";
import { isApp } from "../../../../lib/studio/workflow/app";
import {
  blankWorkflow,
  listWorkflows,
  loadWorkflowLibrary,
  saveWorkflow,
} from "../../../../lib/studio/workflow/store";
import { resolveTemplateModels } from "../../../../lib/studio/workflow/template-models";
import { copyTemplate } from "../../../../lib/studio/workflow/templates";
import {
  dismissWorkflowRun,
  listResumableRuns,
  resumeWorkflowRun,
  runDefinition,
  workflowStepCache,
  type WorkflowRunSummary,
} from "../../../../lib/studio/workflow-run";
import { EmptyState } from "../../../ui/EmptyState";
import { Spinner } from "../../../ui/Spinner";
import { AppRunScreen } from "./AppRunScreen";

export function StudioApps({ catalog }: { catalog: MediaCatalog }) {
  const [apps, setApps] = useState<Workflow[] | null>(null);
  const [open, setOpen] = useState<Workflow>();
  const [unfinished, setUnfinished] = useState<WorkflowRunSummary[]>([]);
  const [resuming, setResuming] = useState<string>();

  const refresh = useCallback(() => {
    void loadWorkflowLibrary()
      .then(() => setApps(listWorkflows().filter(isApp)))
      .catch(() => setApps([]));
    void listResumableRuns()
      .then(setUnfinished)
      .catch(() => setUnfinished([]));
  }, []);
  useEffect(refresh, [refresh]);

  const startFrom = (template: Workflow) => {
    const resolved = resolveTemplateModels(template, catalog).workflow;
    const made = saveWorkflow({
      ...copyTemplate(resolved, {
        ...blankWorkflow(template.name),
        extra: { template: template.id },
      }),
    });
    setOpen(made);
  };

  const resume = async (entry: WorkflowRunSummary) => {
    setResuming(entry.id);
    try {
      // Held to the same check as a run started here.
      const definition = runDefinition(entry);
      const priced = definition ? estimateWorkflowCost(definition, catalog) : undefined;
      await resumeWorkflowRun(entry.id, {
        beforeNode: priced ? spendGuard(priced, { unpriced: "allow" }) : undefined,
        cache: workflowStepCache(entry.workflowId),
        scheduling: "ready",
        isolateFailures: true,
      });
    } catch {
      // Still listed: the person can try again or let it go.
    } finally {
      setResuming(undefined);
      refresh();
    }
  };

  if (open)
    return (
      <div className="mobile-apps">
        <button
          type="button"
          className="mobile-chip-button"
          onClick={() => {
            setOpen(undefined);
            refresh();
          }}
        >
          {t("All apps")}
        </button>
        <h2 className="mobile-app-title">{open.name}</h2>
        <AppRunScreen workflow={open} catalog={catalog} />
      </div>
    );

  if (apps === null)
    return (
      <div className="mobile-studio-loading">
        <Spinner />
      </div>
    );

  const shipped = templateWorkflows().filter(isApp);
  return (
    <div className="mobile-apps">
      {unfinished.map((entry) => (
        <div key={entry.id} className="stage-notice mobile-studio-notice" role="status">
          <span>
            {t("{name} stopped before it finished.", {
              name: runDefinition(entry)?.name || entry.name || t("A run"),
            })}
          </span>
          <button
            type="button"
            className="mobile-chip-button"
            disabled={resuming !== undefined}
            onClick={() => void resume(entry)}
          >
            {resuming === entry.id ? t("Resuming...") : t("Resume")}
          </button>
          <button
            type="button"
            className="mobile-chip-button"
            disabled={resuming !== undefined}
            onClick={() => void dismissWorkflowRun(entry.id).then(refresh)}
          >
            {t("Let it go")}
          </button>
        </div>
      ))}
      {apps.length > 0 ? (
        <section aria-label={t("Your apps")}>
          <h2 className="mobile-section-title">{t("Your apps")}</h2>
          <ul className="mobile-apps-list">
            {apps.map((app) => (
              <li key={app.id}>
                <button type="button" className="mobile-apps-row" onClick={() => setOpen(app)}>
                  <span className="mobile-apps-name">{app.name || t("Untitled workflow")}</span>
                  {app.app?.intro ? (
                    <span className="mobile-apps-intro">{app.app.intro}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <EmptyState
          title={t("No apps yet")}
          description={t(
            "Start from one below, or make a workflow an app on the desktop: it appears here once it syncs.",
          )}
        />
      )}
      <section aria-label={t("Start from an app")}>
        <h2 className="mobile-section-title">{t("Start from an app")}</h2>
        <ul className="mobile-apps-list">
          {shipped.map((template) => (
            <li key={template.id}>
              <button type="button" className="mobile-apps-row" onClick={() => startFrom(template)}>
                <span className="mobile-apps-name">{template.name}</span>
                {template.app?.intro ? (
                  <span className="mobile-apps-intro">{template.app.intro}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
