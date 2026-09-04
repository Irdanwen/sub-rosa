import { t } from "../../../lib/i18n";
import { IconCameraSparkle } from "central-icons/IconCameraSparkle";
import { useCallback, useEffect, useMemo, useState } from "react";
import { artifactDataUrl, evictArtifactDataUrl } from "../../../lib/artifact-media";
import { useCarpeDiemCredits } from "../../../lib/carpe-diem-credits";
import { hapticNotify } from "../../../lib/haptics";
import { deleteArtifact, listArtifacts } from "../../../lib/studio/artifacts";
import {
  fetchMediaCatalog,
  formatCredits,
  supportsBackgroundRemoval,
} from "../../../lib/studio/catalog";
import { continuationPrompt, extractHandoffFrame } from "../../../lib/studio/frames";
import { MAX_COMPOSE_IMAGES } from "../../../lib/studio/edit-image";
import type { ArtifactKind, MediaCatalog, StudioArtifact } from "../../../lib/studio/types";

import { type AudioMode, AudioPanel } from "./studio/StudioAudioPanels";
import { type ImageMode, ImagePanel } from "./studio/StudioImagePanel";
import { type VideoHandoff, VideoPanel } from "./studio/StudioVideoPanel";
import { Lightbox } from "./studio/StudioLightbox";
import { Gallery, Library } from "./studio/StudioLibrary";
import { EmptyState } from "../../ui/EmptyState";
import { Spinner } from "../../ui/Spinner";
import { StackHeader } from "../StackHeader";
import { FlowsPanel } from "./FlowsPanel";

type StudioMode = "image" | "video" | "audio" | "flows" | "library";

// Carpe Diem streams the finished track as the retrieve body (one shot);
// Venice answers JSON with an `audio_url`. Both shapes must be accepted.
const _AUDIO_URL_FIELDS = ["audio_url", "url"];

/** Gallery buckets that hold something reference audio can come from. */
const AUDIO_ARTIFACT_KINDS: ArtifactKind[] = ["music", "speech", "sfx"];

/**
 * Mobile Studio: image, video, music, and guided flows over the shared studio
 * lib (catalog, async job queue with resume, on-device gallery). The desktop
 * keeps its workflow canvas; everything else is at parity.
 */
export function StudioScreen() {
  const credits = useCarpeDiemCredits();
  const [catalog, setCatalog] = useState<MediaCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [mode, setMode] = useState<StudioMode>("image");
  const [artifacts, setArtifacts] = useState<StudioArtifact[]>([]);
  const [preview, setPreview] = useState<StudioArtifact | null>(null);
  // Lifted so the lightbox's "use as reference" can feed the image panel and
  // jump it straight into its Edit sub-mode.
  const [imageRefs, setImageRefs] = useState<string[]>([]);
  const [imageMode, setImageMode] = useState<ImageMode>("generate");
  // Lifted so the gallery under the audio tab follows the active sub-mode.
  const [audioMode, setAudioMode] = useState<AudioMode>("music");
  // A handoff frame waiting to be applied to the video panel's form.
  const [videoHandoff, setVideoHandoff] = useState<VideoHandoff | undefined>(undefined);

  useEffect(() => {
    fetchMediaCatalog()
      .then(setCatalog)
      .catch((err: unknown) =>
        setCatalogError(err instanceof Error ? err.message : "The model catalog is unavailable."),
      );
  }, []);

  const refreshGallery = useCallback(() => {
    listArtifacts()
      .then(setArtifacts)
      .catch(() => undefined);
  }, []);
  const clearVideoHandoff = useCallback(() => setVideoHandoff(undefined), []);
  useEffect(() => {
    refreshGallery();
  }, [refreshGallery]);

  const galleryKind: ArtifactKind | undefined =
    mode === "image"
      ? "image"
      : mode === "video"
        ? "video"
        : mode === "audio"
          ? audioMode
          : undefined;
  const galleryItems = useMemo(
    () => (galleryKind ? artifacts.filter((artifact) => artifact.kind === galleryKind) : artifacts),
    [artifacts, galleryKind],
  );
  const galleryImages = useMemo(
    () => artifacts.filter((artifact) => artifact.kind === "image"),
    [artifacts],
  );
  /** Rendered clips, offered as reference clips to the video panel. */
  const galleryClips = useMemo(
    () => artifacts.filter((artifact) => artifact.kind === "video"),
    [artifacts],
  );
  /** Everything the studio renders as sound, whether it was written as a track,
   * spoken, or generated as an effect: all of it can be reference audio. */
  const galleryTracks = useMemo(
    () => artifacts.filter((artifact) => AUDIO_ARTIFACT_KINDS.includes(artifact.kind)),
    [artifacts],
  );

  const handleDeleteArtifact = useCallback(
    async (artifact: StudioArtifact) => {
      try {
        await deleteArtifact(artifact);
        evictArtifactDataUrl(artifact.path);
        setPreview(null);
        refreshGallery();
      } catch {
        // Removal failures leave the tile in place; the next refresh retries.
      }
    },
    [refreshGallery],
  );

  const handleUseAsReference = useCallback(async (artifact: StudioArtifact) => {
    try {
      const dataUrl = await artifactDataUrl(artifact);
      setImageRefs((current) => [...current, dataUrl].slice(-MAX_COMPOSE_IMAGES));
      setPreview(null);
      setMode("image");
      setImageMode("edit");
      hapticNotify("success");
    } catch {
      // The tile stays; the user can retry.
    }
  }, []);

  /** Read the clip's handoff frame and hand it to the video panel as a pending
   * command, rather than lifting that panel's whole form up here. */
  const handleContinueShot = useCallback(async (artifact: StudioArtifact) => {
    try {
      // Videos resolve to a blob: URL on mobile, which is what a <video> needs
      // to seek at all (a data: URL cannot answer a byte-range request).
      const frame = await extractHandoffFrame(await artifactDataUrl(artifact));
      setVideoHandoff({
        dataUrl: frame.dataUrl,
        prompt: continuationPrompt(artifact.prompt ?? ""),
        artifactId: artifact.id,
        model: artifact.model,
        fileName: artifact.fileName,
        timeSeconds: frame.timeSeconds,
        durationSeconds: frame.durationSeconds,
      });
      setPreview(null);
      setMode("video");
      hapticNotify("success");
    } catch {
      hapticNotify("error");
    }
  }, []);

  return (
    <div className="mobile-screen-root">
      <StackHeader
        title={t("Studio")}
        large
        trailing={
          credits ? (
            <span className="mobile-credits-pill" aria-label={t("Available credits")}>
              {formatCredits(credits.availableCredits)}
              {typeof credits.priceMultiplier === "number"
                ? ` · x${credits.priceMultiplier.toFixed(2)}`
                : ""}
            </span>
          ) : undefined
        }
      />
      <div className="mobile-segmented" role="tablist" aria-label={t("Studio mode")}>
        {(["image", "video", "audio", "flows", "library"] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={mode === entry}
            className="mobile-segmented-item"
            data-active={mode === entry ? "true" : undefined}
            onClick={() => setMode(entry)}
          >
            {entry === "image"
              ? "Image"
              : entry === "video"
                ? "Video"
                : entry === "audio"
                  ? "Audio"
                  : entry === "flows"
                    ? "Flows"
                    : "Library"}
          </button>
        ))}
      </div>
      <div className="mobile-settings-scroll">
        {catalogError ? (
          <EmptyState
            icon={<IconCameraSparkle size={28} />}
            title={t("Studio is unavailable")}
            description={catalogError}
          />
        ) : !catalog ? (
          <div className="mobile-studio-loading">
            <Spinner />
          </div>
        ) : (
          <>
            {mode === "image" ? (
              <ImagePanel
                catalog={catalog}
                mode={imageMode}
                onModeChange={setImageMode}
                references={imageRefs}
                onReferencesChange={setImageRefs}
                galleryImages={galleryImages}
                onGenerated={refreshGallery}
              />
            ) : mode === "video" ? (
              <VideoPanel
                catalog={catalog}
                galleryImages={galleryImages}
                galleryClips={galleryClips}
                galleryTracks={galleryTracks}
                onGenerated={refreshGallery}
                handoff={videoHandoff}
                onHandoffApplied={clearVideoHandoff}
              />
            ) : mode === "audio" ? (
              <AudioPanel
                catalog={catalog}
                mode={audioMode}
                onModeChange={setAudioMode}
                onGenerated={refreshGallery}
              />
            ) : mode === "flows" ? (
              <FlowsPanel catalog={catalog} onGenerated={refreshGallery} />
            ) : (
              <Library items={artifacts} onOpen={setPreview} onChanged={refreshGallery} />
            )}
            {galleryKind ? (
              <Gallery
                items={galleryItems}
                kind={galleryKind}
                onOpen={setPreview}
                onChanged={refreshGallery}
              />
            ) : null}
          </>
        )}
      </div>
      {preview ? (
        <Lightbox
          artifact={preview}
          onClose={() => setPreview(null)}
          onDelete={() => void handleDeleteArtifact(preview)}
          onUseAsReference={
            preview.kind === "image" ? () => void handleUseAsReference(preview) : undefined
          }
          onContinueShot={
            preview.kind === "video" ? () => void handleContinueShot(preview) : undefined
          }
          onUpscaled={refreshGallery}
          canRemoveBackground={Boolean(catalog && supportsBackgroundRemoval(catalog))}
        />
      ) : null}
    </div>
  );
}

// --- Video ------------------------------------------------------------------

// How many reference photos are allowed is per family (`maxVideoReferences`):
// seedance 2.0 documents 9 and 2.5 documents 30, everything else keeps a low
// default. Same rule as the desktop studio.

// --- Music ------------------------------------------------------------------

/** Effects are described in a line, not a paragraph. */

// --- Reference picker ---------------------------------------------------------

/** Multi-reference input: photos from the native picker (the hidden file
 * input opens Photos/camera/Files with no plugin) or images from the app's
 * own gallery. Thumbnails render as removable chips. */
