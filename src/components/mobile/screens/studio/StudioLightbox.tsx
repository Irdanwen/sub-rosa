import { t } from "../../../../lib/i18n";
import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";
import { artifactDataUri, artifactDataUrl } from "../../../../lib/artifact-media";
import { isMobilePlatform } from "../../../../lib/mobile";
import {
  mediaSeconds,
  type ReferenceMedia,
  referenceFileTooBig,
} from "../../../../lib/studio/reference-media";
import type { StudioArtifact } from "../../../../lib/studio/types";
import { Spinner } from "../../../ui/Spinner";
import { ActionSheet } from "../../ActionSheet";
import { GalleryCell } from "./StudioLibrary";

/**
 * Choosing an artifact for a panel: a sheet that hands a form something the
 * gallery already holds (photos, clips, tracks). Looking at one full screen is
 * `StudioViewer`.
 */

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
                aria-label={
                  kind === "video"
                    ? t("Remove clip {number}", { number: index + 1 })
                    : t("Remove track {number}", { number: index + 1 })
                }
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
            {reading ? (
              <Spinner />
            ) : items.length > 0 ? (
              kind === "video" ? (
                t("Add another clip")
              ) : (
                t("Add another track")
              )
            ) : kind === "video" ? (
              t("Add a clip")
            ) : (
              t("Add a track")
            )}
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
            aria-label={kind === "video" ? t("Pick a clip") : t("Pick a track")}
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

/** What a surface can ask of a picker it holds a ref to. */
export interface ReferencePickerHandle {
  /** Bring the picker into view and offer its sources, as a tap on its
   * button would: the one thing a form's hint can do about an empty slot. */
  open(): void;
}

export const ReferencePicker = forwardRef<
  ReferencePickerHandle,
  {
    references: string[];
    onChange: (refs: string[]) => void;
    galleryImages: StudioArtifact[];
    hint?: string;
    /** What the add button says ("Opening frame", "Reference photos"...). */
    label?: string;
    /** How many photos the slot takes; the add button goes once it is full. */
    cap?: number;
    /** Why the last photo was refused. Sits with the input rather than in a
     * failure message after the render was billed. */
    error?: string;
    /** Transform a picked photo before it enters the reference list (e.g.
     * downscale below the backend's size cap). Defaults to identity. */
    prepare?: (dataUrl: string) => Promise<string>;
  }
>(function ReferencePicker(
  { references, onChange, galleryImages, hint, error, prepare, label, cap },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const full = cap !== undefined && references.length >= cap;
  // Three buttons side by side ("Add a photo", "Take a photo", "From gallery")
  // for every photo slot made a video form a wall of chips. One button per
  // slot, and the sources come up when it is tapped.
  const sources = [
    { label: t("Choose a photo"), onAction: () => inputRef.current?.click() },
    ...(isMobilePlatform()
      ? [{ label: t("Take a photo"), onAction: () => cameraRef.current?.click() }]
      : []),
    ...(galleryImages.length > 0
      ? [{ label: t("From the Studio gallery"), onAction: () => setGalleryOpen(true) }]
      : []),
  ];

  const offerSources = () => {
    if (sources.length === 1) sources[0].onAction();
    else setSourcesOpen(true);
  };
  // Rebuilt every render on purpose: the sources list is, too.
  useImperativeHandle(ref, () => ({
    open() {
      rootRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      if (!full) offerSources();
    },
  }));

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
    <div className="mobile-reference" ref={rootRef}>
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
              aria-label={t("Remove reference {number}", { number: index + 1 })}
              onClick={() => onChange(references.filter((_, i) => i !== index))}
            >
              <img src={reference} alt={t("Reference {number}", { number: index + 1 })} />
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
      {full ? null : (
        <div className="mobile-reference-actions">
          <button
            type="button"
            className="mobile-chip-button"
            aria-haspopup={sources.length > 1 ? "dialog" : undefined}
            onClick={offerSources}
          >
            {label ?? t("Add a photo")}
          </button>
        </div>
      )}
      {sourcesOpen ? (
        <ActionSheet
          title={label ?? t("Add a photo")}
          actions={sources}
          onClose={() => setSourcesOpen(false)}
        />
      ) : null}
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
});
