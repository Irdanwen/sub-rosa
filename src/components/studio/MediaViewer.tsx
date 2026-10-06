// The one place a generated file is looked at properly: full window, on a
// screening-room ground, never cropped. The project's media, its bible
// references, a shot's takes and the image gallery all open here, so the
// keyboard, the zoom and the way out are the same wherever you start.

import { IconChevronLeft } from "central-icons/IconChevronLeft";
import { IconChevronRight } from "central-icons/IconChevronRight";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { type ReactNode, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { intlLocale, t } from "../../lib/i18n";
import { useModalFocus } from "../../lib/modal-focus";
import { artifactSrc } from "../../lib/studio/artifacts";
import type { StudioArtifact } from "../../lib/studio/types";
import "./media-viewer.css";
import { requestCompose } from "../../lib/studio/compose/jobs";
import { requestRetouch } from "../../lib/studio/retouch/jobs";

export interface MediaViewerItem {
  artifact: StudioArtifact;
  /** What the file is to the person, when the caller knows better than its name. */
  title?: string;
}

/** Arrow keys belong to a player or a field when one has focus. */
function ownsArrows(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.closest("video, audio, input, textarea, select") !== null || target.isContentEditable)
  );
}

export function MediaViewer({
  items,
  index,
  onIndex,
  onClose,
  actions,
}: {
  items: readonly MediaViewerItem[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** Buttons for the file on screen: export, remove, use as a reference. */
  actions?: (artifact: StudioArtifact) => ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Keyed by file, so every file opens fitted and a copy confirmation stays
  // with the prompt it copied.
  const [zoomed, setZoomed] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const current = items[Math.min(Math.max(index, 0), items.length - 1)];
  // Escape, the Tab trap and focus back where it was: spec/modal-focus.md.
  useModalFocus(surface, { onClose, lockScroll: true });
  if (!current) return null;
  const { artifact } = current;
  const actualSize = zoomed === artifact.id;
  const title = current.title || artifact.title || artifact.fileName;
  const step = (offset: number) => {
    if (items.length < 2) return;
    onIndex((index + offset + items.length) % items.length);
  };
  const created = new Date(artifact.createdAt).toLocaleString(intlLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return createPortal(
    <div
      ref={surface}
      className="media-viewer"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (ownsArrows(event.target)) return;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          step(-1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          step(1);
        }
      }}
    >
      <header className="media-viewer-bar">
        <div className="media-viewer-heading">
          <h2 id={titleId}>{title}</h2>
          {items.length > 1 ? (
            <span className="media-viewer-count">
              {t("{current} of {total}", { current: index + 1, total: items.length })}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className="media-viewer-icon"
          aria-label={t("Close")}
          title={t("Close")}
          onClick={onClose}
        >
          <IconCrossMedium size={16} />
        </button>
      </header>
      <div
        className="media-viewer-stage"
        data-actual-size={actualSize}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        {items.length > 1 ? (
          <button
            type="button"
            className="media-viewer-icon media-viewer-step"
            data-side="previous"
            aria-label={t("Previous")}
            title={t("Previous")}
            onClick={() => step(-1)}
          >
            <IconChevronLeft size={20} />
          </button>
        ) : null}
        {artifact.kind === "image" ? (
          <button
            type="button"
            className="media-viewer-zoom"
            aria-pressed={actualSize}
            aria-label={actualSize ? t("Fit to the window") : t("Show at actual size")}
            onClick={(event) => {
              // The button spans the stage so the image can be fitted to it; a
              // pointer click beside the image is a click on the backdrop.
              if (event.detail !== 0 && event.target === event.currentTarget && !actualSize)
                onClose();
              else setZoomed(actualSize ? undefined : artifact.id);
            }}
          >
            <img key={artifact.id} src={artifactSrc(artifact)} alt={artifact.prompt || title} />
          </button>
        ) : artifact.kind === "video" ? (
          // biome-ignore lint/a11y/useMediaCaption: generated video has no caption track
          <video key={artifact.id} controls autoPlay src={artifactSrc(artifact)} />
        ) : (
          // biome-ignore lint/a11y/useMediaCaption: generated audio has no caption track
          <audio
            key={artifact.id}
            controls
            autoPlay
            src={artifactSrc(artifact)}
            aria-label={t("Preview {name}", { name: title })}
          />
        )}
        {items.length > 1 ? (
          <button
            type="button"
            className="media-viewer-icon media-viewer-step"
            data-side="next"
            aria-label={t("Next")}
            title={t("Next")}
            onClick={() => step(1)}
          >
            <IconChevronRight size={20} />
          </button>
        ) : null}
      </div>
      <footer className="media-viewer-bar media-viewer-details">
        <p className="media-viewer-meta">
          <span>{artifact.model || t("Model unavailable")}</span>
          <span>{created}</span>
        </p>
        {artifact.prompt ? (
          <details className="media-viewer-prompt">
            <summary>{t("Prompt")}</summary>
            <p>{artifact.prompt}</p>
            <button
              type="button"
              className="media-viewer-text-button"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(artifact.prompt)
                  .then(() => setCopied(artifact.id))
                  .catch(() => undefined)
              }
            >
              {copied === artifact.id ? t("Copied") : t("Copy the prompt")}
            </button>
          </details>
        ) : null}
        {artifact.kind === "image" || actions ? (
          <div className="media-viewer-actions">
            {artifact.kind === "image" ? (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  requestRetouch(artifact.id);
                }}
              >
                {t("Retouch this image")}
              </button>
            ) : null}
            {artifact.kind === "image" ? (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  requestCompose(artifact.id);
                }}
              >
                {t("Compose from this image")}
              </button>
            ) : null}
            {actions?.(artifact)}
          </div>
        ) : null}
      </footer>
    </div>,
    document.body,
  );
}
