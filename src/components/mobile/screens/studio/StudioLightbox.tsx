import { t } from "../../../../lib/i18n";
import { useModalFocus } from "../../../../lib/modal-focus";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconClipboard } from "central-icons/IconClipboard";
import { useCallback, useRef, useState } from "react";
import {
  artifactDataUri,
  artifactDataUrl,
  useArtifactDataUrl,
} from "../../../../lib/artifact-media";
import { hapticNotify } from "../../../../lib/haptics";
import { readArtifactBase64, saveArtifactFromBase64 } from "../../../../lib/studio/artifacts";
import { isMobilePlatform } from "../../../../lib/mobile";
import { removeBackground, upscaleImage } from "../../../../lib/studio/edit-image";
import {
  mediaSeconds,
  type ReferenceMedia,
  referenceFileTooBig,
} from "../../../../lib/studio/reference-media";
import type { StudioArtifact } from "../../../../lib/studio/types";
import { saveToPhotos } from "../../../../lib/tauri";
import { Spinner } from "../../../ui/Spinner";
import { GalleryCell } from "./StudioLibrary";
import { markMediaPlayback } from "./StudioControls";

/**
 * Looking at one artifact, and choosing one.
 *
 * The lightbox is where a finished image, clip or track is opened full screen
 * and acted on -- saved, shared, sent back into a form as a reference. The two
 * pickers are the other direction: a sheet that hands a panel something the
 * gallery already holds.
 *
 * They belong together because they share the same idea, an artifact examined
 * outside the grid, and they are what the panels reach for rather than the
 * other way round.
 */
// --- Gallery + lightbox -------------------------------------------------------

export function Lightbox({
  artifact,
  onClose,
  onDelete,
  onUseAsReference,
  onContinueShot,
  onUpscaled,
  canRemoveBackground = false,
}: {
  artifact: StudioArtifact;
  onClose: () => void;
  onDelete: () => void;
  onUseAsReference?: () => void;
  /** Video-only: start the next shot from this clip's handoff frame. */
  onContinueShot?: () => void;
  onUpscaled: () => void;
  /** Backend-dependent: the cutout endpoint only exists on some backends. */
  canRemoveBackground?: boolean;
}) {
  const src = useArtifactDataUrl(artifact);
  const [saved, setSaved] = useState(false);
  const [upscaling, setUpscaling] = useState<2 | 4 | null>(null);
  const [cuttingOut, setCuttingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const canSaveToPhotos =
    isMobilePlatform() && (artifact.kind === "image" || artifact.kind === "video");

  const copyPrompt = useCallback(async () => {
    if (!artifact.prompt) return;
    try {
      await writeText(artifact.prompt);
      hapticNotify("success");
      setPromptCopied(true);
      window.setTimeout(() => setPromptCopied(false), 1600);
    } catch {
      // Copy is a convenience; ignore transient clipboard failures.
    }
  }, [artifact.prompt]);

  const save = useCallback(async () => {
    try {
      await saveToPhotos(artifact.path, artifact.kind === "video" ? "video" : "image");
      setSaved(true);
      hapticNotify("success");
      window.setTimeout(() => setSaved(false), 1600);
    } catch {
      // iOS shows its own permission UI; a failed save stays silent here.
    }
  }, [artifact]);

  const upscale = useCallback(
    async (scale: 2 | 4) => {
      if (upscaling) return;
      setUpscaling(scale);
      setError(null);
      try {
        const base64 = await readArtifactBase64(artifact);
        const result = await upscaleImage(base64, scale);
        await saveArtifactFromBase64(result, "png", {
          kind: "image",
          model: "upscale",
          prompt: `${artifact.prompt ?? "Image"} (x${scale})`,
        });
        hapticNotify("success");
        onUpscaled();
        onClose();
      } catch (err) {
        hapticNotify("error");
        setError(err instanceof Error ? err.message : "The upscale failed.");
      } finally {
        setUpscaling(null);
      }
    },
    [artifact, upscaling, onUpscaled, onClose],
  );

  const removeBg = useCallback(async () => {
    if (cuttingOut) return;
    setCuttingOut(true);
    setError(null);
    try {
      const base64 = await readArtifactBase64(artifact);
      const result = await removeBackground(base64);
      await saveArtifactFromBase64(result, "png", {
        kind: "image",
        model: "background-remover",
        prompt: `${artifact.prompt ?? "Image"} (cutout)`,
      });
      hapticNotify("success");
      onUpscaled();
      onClose();
    } catch (err) {
      hapticNotify("error");
      setError(err instanceof Error ? err.message : "The cutout failed.");
    } finally {
      setCuttingOut(false);
    }
  }, [artifact, cuttingOut, onUpscaled, onClose]);

  // Focus in, Tab kept inside, Escape closes, focus back (spec/modal-focus.md).
  const previewRef = useRef<HTMLDivElement>(null);
  useModalFocus(previewRef, { onClose });

  return (
    <div
      className="mobile-studio-preview"
      role="dialog"
      aria-modal="true"
      aria-label={t("Media preview")}
      ref={previewRef}
      tabIndex={-1}
    >
      <button
        type="button"
        className="mobile-studio-preview-scrim"
        aria-label={t("Close")}
        onClick={onClose}
      />
      <div className="mobile-studio-preview-body">
        {src ? (
          artifact.kind === "video" ? (
            <video
              src={src}
              controls
              autoPlay
              playsInline
              onPlay={() => markMediaPlayback(true)}
              onPause={() => markMediaPlayback(false)}
              onEnded={() => markMediaPlayback(false)}
            />
          ) : (
            <img src={src} alt={artifact.prompt ?? "Generated image"} />
          )
        ) : (
          <Spinner />
        )}
        {artifact.prompt ? (
          <div className="mobile-studio-preview-prompt">
            <p className="mobile-studio-preview-prompt-text">{artifact.prompt}</p>
            <button
              type="button"
              className="mobile-studio-preview-copy"
              onClick={() => void copyPrompt()}
              aria-label={t("Copy prompt")}
            >
              {promptCopied ? <IconCheckmark1Small size={14} /> : <IconClipboard size={14} />}
              {promptCopied ? "Copied" : "Copy prompt"}
            </button>
          </div>
        ) : null}
        {error ? <p className="mobile-dictation-error">{error}</p> : null}
        <div className="mobile-studio-preview-actions">
          {canSaveToPhotos ? (
            <button type="button" className="mobile-chip-button" onClick={() => void save()}>
              {saved ? "Saved" : "Save to Photos"}
            </button>
          ) : null}
          {artifact.kind === "image" ? (
            <>
              <button
                type="button"
                className="mobile-chip-button"
                disabled={upscaling !== null}
                onClick={() => void upscale(2)}
              >
                {upscaling === 2 ? <Spinner /> : "Upscale x2"}
              </button>
              <button
                type="button"
                className="mobile-chip-button"
                disabled={upscaling !== null}
                onClick={() => void upscale(4)}
              >
                {upscaling === 4 ? <Spinner /> : "Upscale x4"}
              </button>
              {canRemoveBackground ? (
                <button
                  type="button"
                  className="mobile-chip-button"
                  disabled={cuttingOut}
                  onClick={() => void removeBg()}
                >
                  {cuttingOut ? <Spinner /> : "Remove background"}
                </button>
              ) : null}
            </>
          ) : null}
          {onUseAsReference ? (
            <button type="button" className="mobile-chip-button" onClick={onUseAsReference}>
              {t("Use as reference")}
            </button>
          ) : null}
          {onContinueShot ? (
            <button type="button" className="mobile-chip-button" onClick={onContinueShot}>
              {t("Continue this shot")}
            </button>
          ) : null}
          <button
            type="button"
            className="mobile-chip-button"
            data-tone="destructive"
            onClick={onDelete}
          >
            {t("Delete")}
          </button>
          <button type="button" className="mobile-chip-button" onClick={onClose}>
            {t("Close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Picks reference *clips* or reference *audio*: media the render follows rather
 * than starts from.
 *
 * Separate from `ReferencePicker` (photos) because none of that component's
 * shape survives the change of medium: there is no thumbnail worth rendering,
 * no camera to offer, and the iOS webview will not load a `data:` URI into a
 * media element at all. So this one shows a numbered list of names, and the two
 * URLs it needs are kept apart on purpose - an object URL to measure the length
 * with, and the data URI that actually travels in the request.
 */
export function MediaReferencePicker({
  kind,
  items,
  cap,
  gallery,
  hint,
  error,
  onAdd,
  onReject,
  onRemove,
  mentionOf,
}: {
  kind: "video" | "audio";
  items: ReferenceMedia[];
  /** How many this model takes; the add actions go away at the ceiling. */
  cap: number;
  /** Gallery artifacts of the matching kinds, newest first. */
  gallery: StudioArtifact[];
  hint?: string;
  error?: string;
  /** Hands over a measured candidate; the caller decides whether it fits. */
  onAdd: (candidate: ReferenceMedia) => void;
  /** Refused before it was ever read, on byte count alone. */
  onReject: (message: string) => void;
  onRemove: (id: string) => void;
  /** What to call the entry at this position in the prompt. */
  mentionOf: (index: number) => string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const noun = kind === "video" ? "clip" : "track";

  const addFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      // Byte count first: a file past the request ceiling is refused before a
      // phone spends time and memory encoding it into a string.
      const tooBig = referenceFileTooBig(file.size, noun);
      if (tooBig) {
        onReject(tooBig);
        return;
      }
      setReading(true);
      // Measured off an object URL, which is the only source an iOS media
      // element will load, and revoked as soon as the length is known. Created
      // inside the try: a webview under memory pressure can refuse, and a throw
      // outside it would leave the button spinning with nothing coming.
      let objectUrl: string | undefined;
      try {
        objectUrl = URL.createObjectURL(file);
        const seconds = await mediaSeconds(objectUrl, kind);
        const dataUri = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("read"));
          reader.onerror = () => reject(reader.error ?? new Error("read"));
          reader.readAsDataURL(file);
        });
        // A device file has no gallery id; its name and size stand in, so the
        // same file picked twice is still caught as a duplicate.
        onAdd({ id: `file:${file.name}:${file.size}`, label: file.name, dataUri, seconds });
      } catch {
        // A file the webview cannot read adds nothing; the picker stays open.
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        setReading(false);
      }
    },
    [kind, noun, onAdd, onReject],
  );

  const addFromGallery = useCallback(
    async (artifact: StudioArtifact) => {
      setGalleryOpen(false);
      const tooBig = referenceFileTooBig(artifact.bytes, noun);
      if (tooBig) {
        onReject(tooBig);
        return;
      }
      setReading(true);
      try {
        const [dataUri, playable] = await Promise.all([
          artifactDataUri(artifact),
          artifactDataUrl(artifact),
        ]);
        onAdd({
          id: artifact.id,
          label: artifact.prompt || artifact.fileName,
          dataUri,
          seconds: await mediaSeconds(playable, kind),
        });
      } catch {
        // Same as above: nothing is added, nothing is lost.
      } finally {
        setReading(false);
      }
    },
    [kind, noun, onAdd, onReject],
  );

  return (
    <div className="mobile-reference">
      <input
        ref={inputRef}
        type="file"
        accept={kind === "video" ? "video/*" : "audio/*"}
        hidden
        onChange={(event) => {
          void addFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      {items.length > 0 ? (
        <ul className="mobile-media-ref-list">
          {items.map((item, index) => (
            <li key={item.id}>
              <span className="mobile-media-ref-index" aria-hidden>
                {mentionOf(index + 1)}
              </span>
              <span className="mobile-media-ref-label">{item.label}</span>
              {item.seconds > 0 ? (
                <span className="mobile-media-ref-seconds">{Math.round(item.seconds)}s</span>
              ) : null}
              <button
                type="button"
                className="mobile-icon-button"
                aria-label={`Remove ${noun} ${index + 1}`}
                onClick={() => onRemove(item.id)}
              >
                <span aria-hidden>x</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="mobile-dictation-error">{error}</p> : null}
      {items.length < cap ? (
        <div className="mobile-reference-actions">
          <button
            type="button"
            className="mobile-chip-button"
            disabled={reading}
            onClick={() => inputRef.current?.click()}
          >
            {reading ? <Spinner /> : items.length > 0 ? `Add another ${noun}` : `Add a ${noun}`}
          </button>
          {gallery.length > 0 ? (
            <button
              type="button"
              className="mobile-chip-button"
              disabled={reading}
              onClick={() => setGalleryOpen(true)}
            >
              {t("From gallery")}
            </button>
          ) : null}
        </div>
      ) : null}
      {hint ? <p className="mobile-reference-hint">{hint}</p> : null}
      {galleryOpen ? (
        <div className="mobile-sheet-backdrop" onClick={() => setGalleryOpen(false)}>
          <div
            className="mobile-sheet"
            role="dialog"
            aria-label={`Pick a ${noun}`}
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="mobile-sheet-title">{t("From your gallery")}</h2>
            <ul className="mobile-sheet-list">
              {gallery.map((artifact) => (
                <li key={artifact.path}>
                  <button
                    type="button"
                    className="mobile-sheet-item"
                    onClick={() => void addFromGallery(artifact)}
                  >
                    <span>
                      <span className="mobile-sheet-item-title">
                        {artifact.prompt || artifact.fileName}
                      </span>
                      <span className="mobile-sheet-item-subtitle">{artifact.fileName}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ReferencePicker({
  references,
  onChange,
  galleryImages,
  hint,
  error,
  prepare,
}: {
  references: string[];
  onChange: (refs: string[]) => void;
  galleryImages: StudioArtifact[];
  hint?: string;
  /** Why the last photo was refused. Sits with the input rather than in a
   * failure message after the render was billed. */
  error?: string;
  /** Transform a picked photo before it enters the reference list (e.g.
   * downscale below the backend's size cap). Defaults to identity. */
  prepare?: (dataUrl: string) => Promise<string>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);

  const readPicked = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        if (typeof reader.result !== "string") return;
        const dataUrl = prepare ? await prepare(reader.result) : reader.result;
        onChange([...references, dataUrl]);
      };
      reader.readAsDataURL(file);
    },
    [references, onChange, prepare],
  );

  const addFromGallery = useCallback(
    async (artifact: StudioArtifact) => {
      try {
        const dataUrl = await artifactDataUrl(artifact);
        onChange([...references, prepare ? await prepare(dataUrl) : dataUrl]);
      } finally {
        setGalleryOpen(false);
      }
    },
    [references, onChange, prepare],
  );

  return (
    <div className="mobile-reference">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          readPicked(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(event) => {
          readPicked(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      {references.length > 0 ? (
        <div className="mobile-reference-strip">
          {references.map((reference, index) => (
            <button
              key={`${index}-${reference.slice(-24)}`}
              type="button"
              className="mobile-reference-chip"
              aria-label={`Remove reference ${index + 1}`}
              onClick={() => onChange(references.filter((_, i) => i !== index))}
            >
              <img src={reference} alt={`Reference ${index + 1}`} />
              {references.length > 1 ? (
                <span className="mobile-reference-index" aria-hidden>
                  {index + 1}
                </span>
              ) : null}
              <span className="mobile-reference-remove" aria-hidden>
                x
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="mobile-reference-actions">
        <button
          type="button"
          className="mobile-chip-button"
          onClick={() => inputRef.current?.click()}
        >
          {t("Add a photo")}
        </button>
        {isMobilePlatform() ? (
          <button
            type="button"
            className="mobile-chip-button"
            onClick={() => cameraRef.current?.click()}
          >
            {t("Take a photo")}
          </button>
        ) : null}
        {galleryImages.length > 0 ? (
          <button type="button" className="mobile-chip-button" onClick={() => setGalleryOpen(true)}>
            {t("From gallery")}
          </button>
        ) : null}
      </div>
      {error ? <p className="mobile-dictation-error">{error}</p> : null}
      {hint ? <p className="mobile-reference-hint">{hint}</p> : null}
      {galleryOpen ? (
        <div className="mobile-sheet-backdrop" onClick={() => setGalleryOpen(false)}>
          <div
            className="mobile-sheet"
            role="dialog"
            aria-label={t("Pick a gallery image")}
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="mobile-sheet-title">{t("From your gallery")}</h2>
            <div className="mobile-studio-grid mobile-sheet-grid">
              {galleryImages.map((artifact) => (
                <GalleryCell
                  key={artifact.path}
                  artifact={artifact}
                  onOpen={() => void addFromGallery(artifact)}
                />
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
