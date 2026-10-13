// The filmstrip: what was made on this desk, newest first, under the dock.
// Renders still in flight take their place at the front (from their durable
// rows, ADR-0018), so a wait is visible from whichever tab started it.
// Opening one shows it in the media viewer, with what can be done next:
// reuse its prompt, continue a shot, keep a still, save a copy, delete.
// Organising (collections, marks, search) belongs to the Gallery tab.

import { IconArrowRight } from "central-icons/IconArrowRight";
import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../../../lib/i18n";
import { messageFromError } from "../../../lib/errors";
import {
  artifactSrc,
  deleteArtifact,
  exportArtifact,
  listArtifacts,
} from "../../../lib/studio/artifacts";
import { STUDIO_IMAGE_RECOVERED_EVENT } from "../../../lib/studio/image-job-recovery";
import type { ArtifactKind, StudioArtifact } from "../../../lib/studio/types";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { FrameCaptureDialog } from "../FrameCaptureDialog";
import { MediaViewer } from "../MediaViewer";
import { SceneWave } from "../stage/Scene";

/** How many recent files the strip shows; the gallery holds the rest. */
const STRIP_LIMIT = 30;

export function Filmstrip({
  kinds,
  epoch,
  pending = 0,
  onArtifactsChanged,
  onReusePrompt,
  onContinue,
  onOpenGallery,
}: {
  kinds: readonly ArtifactKind[];
  /** Bump to reload after a save. */
  epoch: number;
  /** Renders in flight for these kinds. */
  pending?: number;
  onArtifactsChanged?: (artifacts: StudioArtifact[]) => void;
  /** Put a file's prompt back in the dock. */
  onReusePrompt?: (artifact: StudioArtifact) => void;
  /** Video: start the next shot from this clip's last frame. */
  onContinue?: (artifact: StudioArtifact) => void;
  onOpenGallery?: () => void;
}) {
  const [artifacts, setArtifacts] = useState<StudioArtifact[]>([]);
  const [open, setOpen] = useState<string>();
  const [capturing, setCapturing] = useState<StudioArtifact>();
  const [removing, setRemoving] = useState<StudioArtifact>();
  const [error, setError] = useState("");
  const kindKey = kinds.join(",");

  const reload = useCallback(async () => {
    const wanted = new Set(kindKey.split(","));
    const entries = (await listArtifacts()).filter((artifact) => wanted.has(artifact.kind));
    setArtifacts(entries);
    onArtifactsChanged?.(entries);
  }, [kindKey, onArtifactsChanged]);

  useEffect(() => {
    // A save elsewhere bumps the epoch; reading it is what reloads the strip.
    void epoch;
    void reload().catch(() => undefined);
  }, [reload, epoch]);
  useEffect(() => {
    const onRecovered = () => void reload().catch(() => undefined);
    window.addEventListener(STUDIO_IMAGE_RECOVERED_EVENT, onRecovered);
    return () => window.removeEventListener(STUDIO_IMAGE_RECOVERED_EVENT, onRecovered);
  }, [reload]);

  const recent = useMemo(() => artifacts.slice(0, STRIP_LIMIT), [artifacts]);
  const openIndex = recent.findIndex((artifact) => artifact.id === open);

  if (recent.length === 0 && pending === 0) return null;

  return (
    <section className="studio-filmstrip" aria-label={t("Recent")}>
      <div className="studio-filmstrip-head">
        <h2 className="studio-filmstrip-title">{t("Recent")}</h2>
        {onOpenGallery ? (
          <button type="button" className="studio-filmstrip-more" onClick={onOpenGallery}>
            {t("Open the gallery")}
            <IconArrowRight size={14} aria-hidden />
          </button>
        ) : null}
      </div>
      <ul className="studio-filmstrip-row">
        {Array.from({ length: pending }, (_, index) => (
          // Cells for renders in flight are positional and never reorder.
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
          <li key={`pending-${index}`} className="studio-filmstrip-cell">
            <span
              className="studio-filmstrip-tile stage-pending"
              role="img"
              aria-label={t("Rendering")}
            />
          </li>
        ))}
        {recent.map((artifact) => (
          <li key={artifact.id} className="studio-filmstrip-cell">
            <button
              type="button"
              className="studio-filmstrip-tile"
              aria-label={t("Open {name}", {
                name: artifact.title || artifact.prompt || artifact.fileName,
              })}
              title={artifact.title || artifact.prompt || undefined}
              onClick={() => setOpen(artifact.id)}
            >
              {artifact.kind === "image" ? (
                <img src={artifactSrc(artifact)} alt="" loading="lazy" draggable={false} />
              ) : artifact.kind === "video" ? (
                <video src={artifactSrc(artifact)} preload="metadata" muted playsInline />
              ) : (
                <span className="studio-filmstrip-track">
                  <SceneWave seed={artifact.id} />
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <p className="stage-notice" data-tone="error" role="alert">
          {error}
        </p>
      ) : null}
      {openIndex >= 0 ? (
        <MediaViewer
          items={recent.map((artifact) => ({
            artifact,
            title: artifact.title || artifact.prompt || undefined,
          }))}
          index={openIndex}
          onIndex={(index) => setOpen(recent[index]?.id)}
          onClose={() => setOpen(undefined)}
          actions={(artifact) => (
            <>
              {onReusePrompt && artifact.prompt ? (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(undefined);
                    onReusePrompt(artifact);
                  }}
                >
                  {t("Reuse the prompt")}
                </button>
              ) : null}
              {onContinue && artifact.kind === "video" ? (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(undefined);
                    onContinue(artifact);
                  }}
                >
                  {t("Continue this shot")}
                </button>
              ) : null}
              {artifact.kind === "video" ? (
                <button type="button" onClick={() => setCapturing(artifact)}>
                  {t("Capture a frame")}
                </button>
              ) : null}
              <button type="button" onClick={() => void exportArtifact(artifact)}>
                {t("Save a copy")}
              </button>
              <button type="button" onClick={() => setRemoving(artifact)}>
                {t("Delete")}
              </button>
            </>
          )}
        />
      ) : null}
      {capturing ? (
        <FrameCaptureDialog
          artifact={capturing}
          onClose={() => setCapturing(undefined)}
          onCaptured={() => setCapturing(undefined)}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(undefined)}
        title={t("Delete media file?")}
        description={t(
          "Projects that use this file will show a missing reference. Removing it from a project keeps the file available.",
        )}
        confirmLabel={t("Delete")}
        destructive
        onConfirm={async () => {
          if (!removing) return;
          try {
            await deleteArtifact(removing);
            setOpen((current) => (current === removing.id ? undefined : current));
            setRemoving(undefined);
            await reload();
          } catch (deleteError) {
            setError(messageFromError(deleteError));
          }
        }}
      />
    </section>
  );
}
