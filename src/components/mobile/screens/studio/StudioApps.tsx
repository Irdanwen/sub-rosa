// The phone's apps (ADR-0119): the workflows a person made apps of, and the
// shipped ones they can start from, each opening as its form. A run the
// phone left unfinished (the app closed, the phone slept past its grace) is
// offered again here, and only here: resuming spends, so a person asks for it.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useArtifactThumbnail } from "../../../../lib/artifact-media";
import { t } from "../../../../lib/i18n";
import { listArtifacts } from "../../../../lib/studio/artifacts";
import type { MediaCatalog, StudioArtifact } from "../../../../lib/studio/types";
import {
  estimateWorkflowCost,
  templateWorkflows,
  type Workflow,
} from "../../../../lib/studio/workflow";
import { spendGuard } from "../../../../lib/studio/workflow/spend";
import { isApp } from "../../../../lib/studio/workflow/app";
import { nodeTypeLabel } from "../../../../lib/studio/workflow/labels";
import { sameTemplateCopy, workflowMakes } from "../../../../lib/studio/workflow/library";
import { templateCover } from "../../../../lib/studio/workflow/template-covers";
import {
  templateEstimate,
  templatePriceLabel,
} from "../../../../lib/studio/workflow/template-price";
import {
  blankWorkflow,
  listWorkflows,
  loadWorkflowLibrary,
  saveWorkflow,
} from "../../../../lib/studio/workflow/store";
import { resolveTemplateModels } from "../../../../lib/studio/workflow/template-models";
import {
  copyTemplate,
  TEMPLATE_CATEGORIES,
  templateCategory,
  templateCategoryLabel,
} from "../../../../lib/studio/workflow/templates";
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
import { AppRunScreen, phoneRunSessions } from "./AppRunScreen";

export function StudioApps({
  catalog,
  onGalleryChanged,
}: {
  catalog: MediaCatalog;
  /** A device file joined the gallery from an app's field. */
  onGalleryChanged?: () => void;
}) {
  const [apps, setApps] = useState<Workflow[] | null>(null);
  const [open, setOpen] = useState<Workflow>();
  const [unfinished, setUnfinished] = useState<WorkflowRunSummary[]>([]);
  const [resuming, setResuming] = useState<string>();
  /** The gallery, for the picture each of your apps last made. */
  const [artifacts, setArtifacts] = useState<ReadonlyMap<string, StudioArtifact>>(new Map());

  const refresh = useCallback(() => {
    void loadWorkflowLibrary()
      .then(() => setApps(listWorkflows().filter(isApp)))
      .catch(() => setApps([]));
    void listResumableRuns()
      .then(setUnfinished)
      .catch(() => setUnfinished([]));
    void listArtifacts()
      .then((list) => setArtifacts(new Map(list.map((artifact) => [artifact.id, artifact]))))
      .catch(() => undefined);
  }, []);
  useEffect(refresh, [refresh]);
  // Built once per mount, not on every render (a locale change reloads the app).
  const shipped = useMemo(() => templateWorkflows().filter(isApp), []);
  /** Each shipped app pinned to today's catalog: the models it would run on,
   * the steps no offered model can make, and its price. */
  const offers = useMemo(
    () =>
      new Map(
        shipped.map((template) => {
          const resolved = resolveTemplateModels(template, catalog);
          return [
            template.id,
            { ...resolved, estimate: templateEstimate(resolved.workflow, catalog) },
          ] as const;
        }),
      ),
    [shipped, catalog],
  );

  /** Open your copy of a shipped app, or make the first one. A tap used to
   * save a new copy every time; "Your apps" filled with the same app. */
  const startFrom = (template: Workflow) => {
    const offer = offers.get(template.id);
    if (!offer || offer.missing.length > 0) return;
    const existing = listWorkflows()
      .filter(
        (workflow) =>
          workflow.extra?.template === template.id && sameTemplateCopy(workflow, offer.workflow),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (existing) {
      setOpen(existing);
      return;
    }
    const made = saveWorkflow({
      ...copyTemplate(offer.workflow, {
        ...blankWorkflow(template.name),
        extra: { template: template.id },
      }),
    });
    setApps(listWorkflows().filter(isApp));
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
        <AppRunScreen workflow={open} catalog={catalog} onGalleryChanged={onGalleryChanged} />
      </div>
    );

  if (apps === null)
    return (
      <div className="mobile-studio-loading">
        <Spinner />
      </div>
    );

  // A run going on in this webview is not unfinished: its app shows it.
  const live = new Set(phoneRunSessions.live());
  return (
    <div className="mobile-apps">
      {unfinished
        .filter((entry) => !live.has(entry.workflowId))
        .map((entry) => {
          const name = runDefinition(entry)?.name || entry.name || t("A run");
          const held = entry.status === "awaitingGate";
          const ownApp = held ? apps.find((app) => app.id === entry.workflowId) : undefined;
          return (
            <div key={entry.id} className="stage-notice mobile-studio-notice" role="status">
              <span>
                {held
                  ? t("{name} waits for your approval.", { name })
                  : t("{name} stopped before it finished.", { name })}
              </span>
              {ownApp ? (
                <button
                  type="button"
                  className="mobile-chip-button"
                  onClick={() => setOpen(ownApp)}
                >
                  {t("Open")}
                </button>
              ) : (
                <button
                  type="button"
                  className="mobile-chip-button"
                  disabled={resuming !== undefined}
                  onClick={() => void resume(entry)}
                >
                  {resuming === entry.id ? t("Resuming...") : t("Resume")}
                </button>
              )}
              <button
                type="button"
                className="mobile-chip-button"
                disabled={resuming !== undefined}
                onClick={() => void dismissWorkflowRun(entry.id).then(refresh)}
              >
                {t("Let it go")}
              </button>
            </div>
          );
        })}
      <p className="mobile-apps-lead">
        {t("An app is a workflow reduced to its settings: choose one, fill it in, run it.")}
      </p>
      {apps.length > 0 ? (
        <section aria-label={t("Your apps")}>
          <h2 className="mobile-section-title">{t("Your apps")}</h2>
          <ul className="mobile-apps-grid">
            {apps.map((app) => {
              const from = typeof app.extra?.template === "string" ? app.extra.template : undefined;
              const estimate = templateEstimate(app, catalog);
              return (
                <li key={app.id}>
                  <AppCard
                    name={app.name || t("Untitled workflow")}
                    meta={
                      estimate
                        ? t("{makes}, {price}", {
                            makes: workflowMakes(app),
                            price: templatePriceLabel(estimate),
                          })
                        : workflowMakes(app)
                    }
                    workflow={app}
                    artifact={app.coverArtifactId ? artifacts.get(app.coverArtifactId) : undefined}
                    cover={templateCover(from)}
                    onOpen={() => setOpen(app)}
                  />
                </li>
              );
            })}
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
        {/* Grouped by kind of work: a long list reads by its headings. */}
        {TEMPLATE_CATEGORIES.map((kind) => {
          const inKind = shipped.filter((template) => templateCategory(template.id) === kind);
          if (inKind.length === 0) return null;
          const label = templateCategoryLabel(kind);
          return (
            <section key={kind} aria-label={label} className="mobile-apps-group">
              <h3 className="mobile-apps-group-title">{label}</h3>
              <ul className="mobile-apps-grid">
                {inKind.map((template) => {
                  const offer = offers.get(template.id);
                  const missing = offer?.missing ?? [];
                  const price = offer?.estimate ? templatePriceLabel(offer.estimate) : undefined;
                  return (
                    <li key={template.id}>
                      <AppCard
                        name={template.name}
                        meta={
                          missing.length > 0
                            ? t("Not offered today: no model for {steps}", {
                                steps: missing.join(", "),
                              })
                            : price
                              ? t("{makes}, {price}", { makes: workflowMakes(template), price })
                              : workflowMakes(template)
                        }
                        workflow={template}
                        cover={templateCover(template.id)}
                        disabled={missing.length > 0}
                        onOpen={() => startFrom(template)}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </section>
    </div>
  );
}

/** One app to open: its picture, its name, and what a run makes for what
 * price. The picture is what it last made, else the template's cover, else a
 * sketch of its steps. */
function AppCard({
  name,
  meta,
  workflow,
  artifact,
  cover,
  disabled,
  onOpen,
}: {
  name: string;
  meta: string;
  workflow: Pick<Workflow, "nodes">;
  artifact?: StudioArtifact;
  cover?: string;
  disabled?: boolean;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="mobile-apps-card" disabled={disabled} onClick={onOpen}>
      <span className="mobile-apps-cover" aria-hidden>
        <AppCover workflow={workflow} artifact={artifact} src={cover} />
      </span>
      <span className="mobile-apps-card-body">
        <span className="mobile-apps-name">{name}</span>
        <span className="mobile-apps-meta">{meta}</span>
      </span>
    </button>
  );
}

function AppCover({
  workflow,
  artifact,
  src,
}: {
  workflow: Pick<Workflow, "nodes">;
  artifact?: StudioArtifact;
  src?: string;
}) {
  // Through the thumbnail hook, not the asset protocol: the iOS webview does
  // not resolve the latter (see artifact-media.ts).
  const thumbnail = useArtifactThumbnail(artifact ?? null);
  if (thumbnail)
    return thumbnail.kind === "media" ? (
      <video src={`${thumbnail.src}#t=0.1`} muted playsInline preload="metadata" />
    ) : (
      <img src={thumbnail.src} alt="" />
    );
  if (src) return <img src={src} alt="" loading="lazy" decoding="async" />;
  return (
    <span className="mobile-apps-sketch">
      {workflow.nodes.slice(0, 6).map((node) => (
        <span key={node.id} data-type={node.type}>
          {nodeTypeLabel(node.type)}
        </span>
      ))}
    </span>
  );
}
