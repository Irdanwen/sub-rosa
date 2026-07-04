// Persistent gallery for one artifact kind. Images render as a grid with a
// fullscreen lightbox; video and audio render as inline players. Files live
// on disk (see lib/studio/artifacts.ts) so everything here survives restarts.

import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { IconArrowDownCircle } from "central-icons/IconArrowDownCircle";
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

export function GalleryStrip({
  kind,
  epoch,
  empty,
  onArtifactsChanged,
  onSendToEdit,
}: {
  kind: ArtifactKind;
  /** Bump to reload after a save. */
  epoch: number;
  empty?: ReactNode;
  onArtifactsChanged?: (artifacts: StudioArtifact[]) => void;
  /** Image-only affordance: feed this artifact into the edit tool. */
  onSendToEdit?: (artifact: StudioArtifact) => void;
}) {
  const [artifacts, setArtifacts] = useState<StudioArtifact[]>([]);
  const [lightbox, setLightbox] = useState<StudioArtifact | undefined>(undefined);

  const reload = useCallback(async () => {
    const entries = await listArtifacts(kind);
    setArtifacts(entries);
    onArtifactsChanged?.(entries);
  }, [kind, onArtifactsChanged]);

  useEffect(() => {
    void reload();
  }, [reload, epoch]);

  const onExport = useCallback(async (artifact: StudioArtifact) => {
    const destination = await saveDialog({ defaultPath: artifact.fileName });
    if (destination) await exportArtifact(artifact, destination);
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

  if (kind === "image") {
    return (
      <>
        <div className="studio-image-grid">
          {artifacts.map((artifact) => (
            <figure key={artifact.id} className="studio-image-card">
              <button
                type="button"
                className="studio-image-open"
                aria-label={`Open ${artifact.prompt || "image"}`}
                onClick={() => setLightbox(artifact)}
              >
                <img src={artifactSrc(artifact)} alt={artifact.prompt || "Generated image"} />
              </button>
              <figcaption className="studio-card-meta">
                <span className="studio-card-prompt" title={artifact.prompt}>
                  {artifact.prompt || artifact.model}
                </span>
                <span className="studio-card-actions">
                  {onSendToEdit ? (
                    <button
                      type="button"
                      className="studio-icon-button"
                      aria-label="Send to edit"
                      title="Send to edit"
                      onClick={() => onSendToEdit(artifact)}
                    >
                      <IconPencil size={14} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="studio-icon-button"
                    aria-label="Save a copy"
                    title="Save a copy"
                    onClick={() => void onExport(artifact)}
                  >
                    <IconArrowDownCircle size={14} />
                  </button>
                  <button
                    type="button"
                    className="studio-icon-button"
                    aria-label="Delete"
                    title="Delete"
                    onClick={() => void onDelete(artifact)}
                  >
                    <IconTrashCanSimple size={14} />
                  </button>
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
        {lightbox ? (
          <div
            className="studio-lightbox"
            role="dialog"
            aria-label="Image preview"
            onClick={() => setLightbox(undefined)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setLightbox(undefined);
            }}
          >
            <img src={artifactSrc(lightbox)} alt={lightbox.prompt || "Generated image"} />
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className="studio-media-list">
      {artifacts.map((artifact) => (
        <div key={artifact.id} className="studio-media-card">
          {kind === "video" ? (
            // biome-ignore lint/a11y/useMediaCaption: generated video has no track
            <video controls src={artifactSrc(artifact)} className="studio-video-player" />
          ) : (
            // biome-ignore lint/a11y/useMediaCaption: generated audio has no track
            <audio controls src={artifactSrc(artifact)} className="studio-audio-player" />
          )}
          <div className="studio-card-meta">
            <span className="studio-card-prompt" title={artifact.prompt}>
              {artifact.prompt || artifact.model}
            </span>
            <span className="studio-card-actions">
              <button
                type="button"
                className="studio-icon-button"
                aria-label="Save a copy"
                title="Save a copy"
                onClick={() => void onExport(artifact)}
              >
                <IconArrowDownCircle size={14} />
              </button>
              <button
                type="button"
                className="studio-icon-button"
                aria-label="Delete"
                title="Delete"
                onClick={() => void onDelete(artifact)}
              >
                <IconTrashCanSimple size={14} />
              </button>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
