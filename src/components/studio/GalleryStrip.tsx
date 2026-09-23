// Persistent gallery for one artifact kind. Images render as a grid with a
// fullscreen lightbox; video and audio render as inline players. Files live
// on disk (see lib/studio/artifacts.ts) so everything here survives restarts.

import { t } from "../../lib/i18n";
import { messageFromError } from "../../lib/errors";
import { IconArrowDownCircle } from "central-icons/IconArrowDownCircle";
import { IconArrowRightCircle } from "central-icons/IconArrowRightCircle";
import { IconCapture } from "central-icons/IconCapture";
import { IconPencil } from "central-icons/IconPencil";
import { IconTrashCanSimple } from "central-icons/IconTrashCanSimple";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  artifactSrc,
  deleteArtifact,
  exportArtifact,
  listArtifacts,
} from "../../lib/studio/artifacts";
import type { ArtifactKind, StudioArtifact } from "../../lib/studio/types";
import { Spinner } from "../ui/Spinner";
import { FrameCaptureDialog } from "./FrameCaptureDialog";
import { listProjects, organizeArtifact, type ProjectSummary } from "../../lib/studio/projects";
import { STUDIO_IMAGE_RECOVERED_EVENT } from "../../lib/studio/image-job-recovery";
import { Dialog } from "../ui/Dialog";

/** How long the "saved to the gallery" line stays up. Long enough to read
 * without hunting for it, short enough not to become furniture. */
const CAPTURE_NOTICE_MS = 6_000;

export function GalleryStrip({
  kind,
  epoch,
  empty,
  onArtifactsChanged,
  onSendToEdit,
  onContinue,
  continuingId,
}: {
  kind: ArtifactKind;
  /** Bump to reload after a save. */
  epoch: number;
  empty?: ReactNode;
  onArtifactsChanged?: (artifacts: StudioArtifact[]) => void;
  /** Image-only affordance: feed this artifact into the edit tool. */
  onSendToEdit?: (artifact: StudioArtifact) => void;
  /** Video-only affordance: start the next shot from this clip's last frame. */
  onContinue?: (artifact: StudioArtifact) => void;
  /** Artifact whose handoff frame is being extracted right now. */
  continuingId?: string;
}) {
  const [artifacts, setArtifacts] = useState<StudioArtifact[]>([]);
  const [lightbox, setLightbox] = useState<StudioArtifact | undefined>(undefined);
  // The clip a still is being captured from. Owned here rather than by each
  // studio: a capture reads a video artifact and writes an image artifact, and
  // needs nothing from the form it was opened next to.
  const [capturing, setCapturing] = useState<StudioArtifact | undefined>(undefined);
  // A still written to the image gallery from a strip showing videos lands
  // somewhere the user cannot see from here. Without a word, the capture reads
  // as having done nothing at all.
  const [captured, setCaptured] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectFilter, setProjectFilter] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<StudioArtifact>();
  const [title, setTitle] = useState("");
  const [memberships, setMemberships] = useState<string[]>([]);
  const [metadataError, setMetadataError] = useState("");
  const [removing, setRemoving] = useState<StudioArtifact>();
  useEffect(() => {
    void listProjects()
      .then(setProjects)
      .catch(() => undefined);
  }, []);

  const reload = useCallback(async () => {
    const entries = await listArtifacts(kind);
    setArtifacts(entries);
    onArtifactsChanged?.(entries);
  }, [kind, onArtifactsChanged]);

  useEffect(() => {
    void reload();
  }, [reload, epoch]);
  useEffect(() => {
    const onRecovered = () => void reload();
    window.addEventListener(STUDIO_IMAGE_RECOVERED_EVENT, onRecovered);
    return () => window.removeEventListener(STUDIO_IMAGE_RECOVERED_EVENT, onRecovered);
  }, [reload]);

  useEffect(() => {
    if (!captured) return;
    const timer = window.setTimeout(() => setCaptured(false), CAPTURE_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [captured]);

  // Rust opens the save dialog: a destination chosen here would make the export
  // command an arbitrary file write.
  const onExport = useCallback(async (artifact: StudioArtifact) => {
    await exportArtifact(artifact);
  }, []);

  const onDelete = useCallback(
    async (artifact: StudioArtifact) => {
      await deleteArtifact(artifact);
      setLightbox((current) => (current?.id === artifact.id ? undefined : current));
      await reload();
    },
    [reload],
  );

  if (artifacts.length === 0) return <>{empty ?? null}</>;
  const visible = artifacts.filter(
    (artifact) =>
      (!projectFilter || artifact.projectIds?.includes(projectFilter)) &&
      `${artifact.title ?? ""} ${artifact.prompt} ${artifact.model}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const editMetadata = (artifact: StudioArtifact) => {
    setEditing(artifact);
    setTitle(artifact.title || artifact.fileName);
    setMemberships(artifact.projectIds ?? []);
    setMetadataError("");
  };
  const metadata = (
    <>
      <div className="studio-gallery-filter">
        <input
          className="studio-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t("Search media")}
          placeholder={t("Search media")}
        />
        <select
          className="studio-input"
          aria-label={t("Filter by project")}
          value={projectFilter}
          onChange={(event) => setProjectFilter(event.target.value)}
        >
          <option value="">{t("All projects")}</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>
      {editing ? (
        <Dialog
          open
          onClose={() => setEditing(undefined)}
          title={t("Organize media")}
          footer={
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setEditing(undefined)}
              >
                {t("Cancel")}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  void organizeArtifact({ id: editing.id, title, projectIds: memberships })
                    .then(async () => {
                      await reload();
                      setEditing(undefined);
                    })
                    .catch((error) => setMetadataError(messageFromError(error)))
                }
              >
                {t("Save")}
              </button>
            </>
          }
        >
          <div className="dialog-body">
            <label className="studio-field">
              {t("Media name")}
              <input
                className="studio-input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <p>{t("Projects")}</p>
            {projects.map((project) => (
              <label className="studio-field" key={project.id}>
                <input
                  type="checkbox"
                  checked={memberships.includes(project.id)}
                  onChange={(event) =>
                    setMemberships(
                      event.target.checked
                        ? [...memberships, project.id]
                        : memberships.filter((id) => id !== project.id),
                    )
                  }
                />
                {project.name}
              </label>
            ))}
            {metadataError ? <p role="alert">{metadataError}</p> : null}
          </div>
        </Dialog>
      ) : null}
      {removing ? (
        <Dialog
          open
          onClose={() => setRemoving(undefined)}
          title={t("Delete media file?")}
          description={t(
            "Projects that use this file will show a missing reference. Removing it from a project keeps the file available.",
          )}
          footer={
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setRemoving(undefined)}
              >
                {t("Cancel")}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  void onDelete(removing)
                    .then(() => setRemoving(undefined))
                    .catch((error) => setMetadataError(messageFromError(error)))
                }
              >
                {t("Delete")}
              </button>
            </>
          }
        >
          <div className="dialog-body">
            <p>{removing.title || removing.fileName}</p>
            {metadataError ? <p role="alert">{metadataError}</p> : null}
          </div>
        </Dialog>
      ) : null}
    </>
  );

  if (kind === "image") {
    return (
      <>
        {metadata}
        <div className="studio-image-grid">
          {visible.map((artifact) => (
            <figure key={artifact.id} className="studio-image-card">
              <button
                type="button"
                className="studio-image-open"
                aria-label={t("Open {name}", { name: artifact.prompt || t("image") })}
                onClick={() => setLightbox(artifact)}
              >
                <img src={artifactSrc(artifact)} alt={artifact.prompt || t("Generated image")} />
              </button>
              <figcaption className="studio-card-meta">
                <span className="studio-card-prompt" title={artifact.prompt}>
                  {artifact.title || artifact.prompt || artifact.model}
                </span>
                <span className="studio-card-actions">
                  <button
                    type="button"
                    className="studio-icon-button"
                    aria-label={t("Organize media")}
                    title={t("Organize media")}
                    onClick={() => editMetadata(artifact)}
                  >
                    <IconPencil size={14} />
                  </button>
                  {onSendToEdit ? (
                    <button
                      type="button"
                      className="studio-icon-button"
                      aria-label={t("Send to edit")}
                      title={t("Send to edit")}
                      onClick={() => onSendToEdit(artifact)}
                    >
                      <IconPencil size={14} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="studio-icon-button"
                    aria-label={t("Save a copy")}
                    title={t("Save a copy")}
                    onClick={() => void onExport(artifact)}
                  >
                    <IconArrowDownCircle size={14} />
                  </button>
                  <button
                    type="button"
                    className="studio-icon-button"
                    aria-label={t("Delete")}
                    title={t("Delete")}
                    onClick={() => setRemoving(artifact)}
                  >
                    <IconTrashCanSimple size={14} />
                  </button>
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
        {lightbox ? (
          <Dialog
            open
            onClose={() => setLightbox(undefined)}
            title={lightbox.title || t("Image preview")}
            width="min(90vw, 1200px)"
          >
            <div className="studio-lightbox-image">
              <img src={artifactSrc(lightbox)} alt={lightbox.prompt || t("Generated image")} />
            </div>
          </Dialog>
        ) : null}
      </>
    );
  }

  return (
    <>
      {metadata}
      {capturing ? (
        <FrameCaptureDialog
          artifact={capturing}
          onClose={() => setCapturing(undefined)}
          onCaptured={() => setCaptured(true)}
        />
      ) : null}
      {captured ? (
        <p className="studio-field-note" role="status">
          {t("Saved to the image gallery.")}
        </p>
      ) : null}
      <div
        className={
          kind === "video" ? "studio-media-list studio-media-compact" : "studio-media-list"
        }
      >
        {visible.map((artifact) => (
          <div key={artifact.id} className="studio-media-card">
            {kind === "video" ? (
              // biome-ignore lint/a11y/useMediaCaption: generated video has no track
              <video
                controls
                preload="metadata"
                src={artifactSrc(artifact)}
                className="studio-video-player"
              />
            ) : (
              // biome-ignore lint/a11y/useMediaCaption: generated audio has no track
              <audio controls src={artifactSrc(artifact)} className="studio-audio-player" />
            )}
            <div className="studio-card-meta">
              <span className="studio-card-prompt" title={artifact.prompt}>
                {artifact.title || artifact.prompt || artifact.model}
              </span>
              <span className="studio-card-actions">
                <button
                  type="button"
                  className="studio-icon-button"
                  aria-label={t("Organize media")}
                  title={t("Organize media")}
                  onClick={() => editMetadata(artifact)}
                >
                  <IconPencil size={14} />
                </button>
                {kind === "video" ? (
                  <button
                    type="button"
                    className="studio-icon-button"
                    aria-label={t("Capture a frame")}
                    title={t("Capture a frame: keep a still from this clip in the image gallery")}
                    onClick={() => setCapturing(artifact)}
                  >
                    <IconCapture size={14} />
                  </button>
                ) : null}
                {onContinue ? (
                  <button
                    type="button"
                    className="studio-icon-button"
                    aria-label={t("Continue this shot")}
                    title={t("Continue this shot: start the next one from its last frame")}
                    disabled={continuingId === artifact.id}
                    onClick={() => onContinue(artifact)}
                  >
                    {continuingId === artifact.id ? (
                      <Spinner aria-hidden />
                    ) : (
                      <IconArrowRightCircle size={14} />
                    )}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="studio-icon-button"
                  aria-label={t("Save a copy")}
                  title={t("Save a copy")}
                  onClick={() => void onExport(artifact)}
                >
                  <IconArrowDownCircle size={14} />
                </button>
                <button
                  type="button"
                  className="studio-icon-button"
                  aria-label={t("Delete")}
                  title={t("Delete")}
                  onClick={() => setRemoving(artifact)}
                >
                  <IconTrashCanSimple size={14} />
                </button>
              </span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
