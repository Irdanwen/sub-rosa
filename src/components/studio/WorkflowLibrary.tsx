// The workflow library: every workflow as a card with its picture, the
// built-in templates, and the way in for a file (Sub Rosa's own export or a
// ComfyUI workflow, translated with a report before anything is saved,
// ADR-0075).

import { IconArrowDownCircle } from "central-icons/IconArrowDownCircle";
import { IconImport } from "central-icons/IconImport";
import { IconImageSparkle } from "central-icons/IconImageSparkle";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconTrashCanSimple } from "central-icons/IconTrashCanSimple";
import { useMemo, useRef, useState, type DragEvent } from "react";
import { useArtifactIndex } from "../../lib/artifact-media";
import { friendlyErrorMessage } from "../../lib/errors";
import { formatCredits } from "../../lib/studio/catalog";
import { artifactSrc } from "../../lib/studio/artifacts";
import { intlLocale, t } from "../../lib/i18n";
import type { MediaCatalog, StudioArtifact } from "../../lib/studio/types";
import { MAX_WORKFLOW_FILE_BYTES, readWorkflowFile } from "../../lib/studio/workflow/comfy/file";
import type { ComfyImport } from "../../lib/studio/workflow/comfy/translate";
import { coverOffer, workflowMakes } from "../../lib/studio/workflow/library";
import { NODE_SCHEMAS, type Workflow } from "../../lib/studio/workflow/schema";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog } from "../ui/Dialog";
import { Spinner } from "../ui/Spinner";
import "./workflow-library.css";

/** Pictures made once for the built-in templates, shipped with the app. */
const TEMPLATE_COVERS = import.meta.glob("../../assets/workflow-covers/*.webp", {
  eager: true,
  import: "default",
  query: "?url",
}) as Record<string, string>;

function templateCover(id: string): string | undefined {
  return TEMPLATE_COVERS[`../../assets/workflow-covers/${id}.webp`];
}

/** A picked or dropped file's text. */
function fileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(t("The file could not be read.")));
    reader.readAsText(file);
  });
}

export type ImportedWorkflow = Pick<Workflow, "name" | "description" | "nodes" | "edges">;

export function WorkflowLibrary({
  catalog,
  workflows,
  templates,
  onOpen,
  onUseTemplate,
  onNew,
  onImported,
  onExport,
  onDelete,
  onMakeCover,
}: {
  catalog: MediaCatalog;
  workflows: Workflow[];
  templates: Workflow[];
  onOpen: (workflow: Workflow) => void;
  onUseTemplate: (templateId: string) => void;
  onNew: () => void;
  onImported: (workflow: ImportedWorkflow) => void;
  onExport: (workflow: Workflow) => Promise<void>;
  onDelete: (workflow: Workflow) => void;
  onMakeCover: (workflow: Workflow) => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [review, setReview] = useState<ComfyImport>();
  const [deleting, setDeleting] = useState<Workflow>();
  const [covering, setCovering] = useState<string>();
  const artifacts = useArtifactIndex();
  const offer = useMemo(() => coverOffer(catalog), [catalog]);

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setError(undefined);
    try {
      if (file.size > MAX_WORKFLOW_FILE_BYTES)
        throw new Error(t("This file is too large to be a workflow."));
      const read = readWorkflowFile(await fileText(file), catalog, file.name);
      if (read.kind === "subrosa") onImported(read.workflow);
      else setReview(read.result);
    } catch (cause) {
      setError(friendlyErrorMessage(cause, t("This file could not be imported.")));
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void importFile(
      [...event.dataTransfer.files].find((file) => file.name.toLowerCase().endsWith(".json")),
    );
  };

  return (
    <section
      className="workflow-library"
      aria-label={t("Workflow library")}
      data-dragging={dragging || undefined}
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="workflow-library-head">
        <div>
          <h2>{t("Workflow library")}</h2>
          <p>
            {t(
              "Open a workflow, start from a template, or import a file. ComfyUI files are translated.",
            )}
          </p>
        </div>
        <div className="workflow-library-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => fileRef.current?.click()}
          >
            <IconImport size={14} aria-hidden />
            {t("Import")}
          </button>
          <button type="button" className="studio-primary-button" onClick={onNew}>
            <IconPlusMedium size={14} aria-hidden />
            {t("New workflow")}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          aria-label={t("Workflow file")}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            void importFile(file);
          }}
        />
      </header>
      {error ? (
        <p className="studio-error" role="alert">
          {error}
        </p>
      ) : null}
      {dragging ? (
        <p className="workflow-library-drop">{t("Drop the workflow file to import it")}</p>
      ) : null}

      {workflows.length > 0 ? (
        <section aria-label={t("Your workflows")}>
          <h3>{t("Your workflows")}</h3>
          <div className="workflow-library-grid">
            {workflows.map((workflow) => {
              const cover = workflow.coverArtifactId
                ? artifacts.byId.get(workflow.coverArtifactId)
                : undefined;
              return (
                <article key={workflow.id} className="workflow-card">
                  <button
                    type="button"
                    className="workflow-card-open"
                    aria-label={t("Open {name}", { name: workflow.name })}
                    onClick={() => onOpen(workflow)}
                  >
                    <CardPicture workflow={workflow} artifact={cover} />
                  </button>
                  <div className="workflow-card-body">
                    <div className="workflow-card-title">
                      <span>{workflow.name || t("Untitled workflow")}</span>
                      {workflow.origin === "import" ? (
                        <span className="workflow-card-badge">{t("Imported")}</span>
                      ) : null}
                    </div>
                    <p className="workflow-card-meta">
                      {workflowMakes(workflow)} ·{" "}
                      {new Date(workflow.updatedAt).toLocaleDateString(intlLocale(), {
                        day: "numeric",
                        month: "short",
                      })}
                    </p>
                    <div className="workflow-card-actions">
                      {offer && !cover ? (
                        <button
                          type="button"
                          className="studio-icon-button"
                          disabled={covering === workflow.id}
                          aria-label={t("Make a cover picture")}
                          title={
                            offer.credits !== undefined
                              ? t("Make a cover picture ({credits} credits)", {
                                  credits: formatCredits(offer.credits),
                                })
                              : t("Make a cover picture")
                          }
                          onClick={() => {
                            setCovering(workflow.id);
                            void onMakeCover(workflow)
                              .catch((cause) =>
                                setError(
                                  friendlyErrorMessage(cause, t("The picture could not be made.")),
                                ),
                              )
                              .finally(() => setCovering(undefined));
                          }}
                        >
                          {covering === workflow.id ? (
                            <Spinner aria-hidden />
                          ) : (
                            <IconImageSparkle size={14} />
                          )}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="studio-icon-button"
                        aria-label={t("Export")}
                        title={t("Export")}
                        onClick={() =>
                          void onExport(workflow).catch((cause) =>
                            setError(
                              friendlyErrorMessage(cause, t("The workflow could not be exported.")),
                            ),
                          )
                        }
                      >
                        <IconArrowDownCircle size={14} />
                      </button>
                      <button
                        type="button"
                        className="studio-icon-button"
                        aria-label={t("Delete")}
                        title={t("Delete")}
                        onClick={() => setDeleting(workflow)}
                      >
                        <IconTrashCanSimple size={14} />
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      <section aria-label={t("Templates")}>
        <h3>{t("Templates")}</h3>
        <div className="workflow-library-grid">
          {templates.map((template) => (
            <article key={template.id} className="workflow-card">
              <button
                type="button"
                className="workflow-card-open"
                aria-label={t("Start from {name}", { name: template.name })}
                onClick={() => onUseTemplate(template.id)}
              >
                <CardPicture workflow={template} src={templateCover(template.id)} />
              </button>
              <div className="workflow-card-body">
                <div className="workflow-card-title">
                  <span>{template.name}</span>
                </div>
                <p className="workflow-card-meta">{workflowMakes(template)}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      {review ? (
        <ImportReview
          result={review}
          onClose={() => setReview(undefined)}
          onConfirm={() => {
            onImported(review.workflow);
            setReview(undefined);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(undefined)}
        title={t("Delete this workflow?")}
        description={t("Its results stay in the gallery.")}
        confirmLabel={t("Delete")}
        destructive
        onConfirm={() => {
          if (deleting) onDelete(deleting);
          setDeleting(undefined);
        }}
      />
    </section>
  );
}

/** A card's picture: the cover, else a sketch of the graph itself, never a
 * placeholder that pretends to be a result. */
function CardPicture({
  workflow,
  artifact,
  src,
}: {
  workflow: Pick<Workflow, "nodes">;
  artifact?: StudioArtifact;
  src?: string;
}) {
  if (artifact?.kind === "video") {
    return <video src={artifactSrc(artifact)} muted preload="metadata" />;
  }
  const picture = src ?? (artifact ? artifactSrc(artifact) : undefined);
  if (picture) return <img src={picture} alt="" loading="lazy" decoding="async" />;
  const kinds = workflow.nodes.slice(0, 8);
  return (
    <span className="workflow-card-sketch" aria-hidden>
      {kinds.map((node) => (
        <span key={node.id} className="workflow-card-step" data-type={node.type}>
          {NODE_SCHEMAS[node.type]?.label ?? node.type}
        </span>
      ))}
    </span>
  );
}

function ImportReview({
  result,
  onClose,
  onConfirm,
}: {
  result: ComfyImport;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { report, usable } = result;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("Import a ComfyUI workflow")}
      description={
        usable
          ? t(
              "Sub Rosa runs hosted models only, so the workflow was translated. Here is what changed.",
            )
          : t("Nothing in this workflow can run on a hosted model, so there is nothing to import.")
      }
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t("Cancel")}
          </button>
          {usable ? (
            <button type="button" className="studio-primary-button" onClick={onConfirm}>
              {t("Import")}
            </button>
          ) : null}
        </>
      }
    >
      <div className="dialog-body workflow-import-report">
        {report.translated.length > 0 ? (
          <ReportList
            title={t("Translated")}
            items={report.translated.map((entry) => `${entry.comfyType} → ${entry.as}`)}
          />
        ) : null}
        {report.missing.length > 0 ? (
          <ReportList
            title={t("To provide before running")}
            items={report.missing.map((name) =>
              t("{file}: pick it from the gallery", { file: name }),
            )}
          />
        ) : null}
        {report.adjusted.length > 0 ? (
          <ReportList title={t("Adjusted")} items={report.adjusted} />
        ) : null}
        {report.dropped.length > 0 ? (
          <ReportList
            title={t("Left out")}
            items={report.dropped.map((entry) => `${entry.comfyType}: ${entry.reason}`)}
          />
        ) : null}
        {result.workflow.description ? (
          <p className="workflow-import-note">
            {t("The file's notes become the workflow's description.")}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function ReportList({ title, items }: { title: string; items: string[] }) {
  return (
    <section>
      <h4>{title}</h4>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
