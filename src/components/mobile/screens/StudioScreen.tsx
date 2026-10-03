import { t } from "../../../lib/i18n";
import { IconCameraSparkle } from "central-icons/IconCameraSparkle";
import { useCallback, useEffect, useMemo, useState } from "react";
import { artifactDataUrl, evictArtifactDataUrl } from "../../../lib/artifact-media";
import { useCarpeDiemCredits } from "../../../lib/carpe-diem-credits";
import { hapticNotify } from "../../../lib/haptics";
import { requestAddCredits } from "../../../lib/credits-events";
import { usePayPolicy } from "../../../lib/credits-purchase";
import { deleteArtifact, listArtifacts } from "../../../lib/studio/artifacts";
import {
  dismissStandaloneImageFailure,
  readStandaloneImageFailures,
  STUDIO_IMAGE_FAILED_EVENT,
  STUDIO_IMAGE_RECOVERED_EVENT,
} from "../../../lib/studio/image-job-recovery";
import {
  fetchMediaCatalog,
  formatCredits,
  supportsBackgroundRemoval,
} from "../../../lib/studio/catalog";
import { continuationPrompt, extractHandoffFrame } from "../../../lib/studio/frames";
import { isStudioOwned, useRunningMediaJobs } from "../../../lib/studio/media-jobs-live";
import type { ArtifactKind, MediaCatalog, StudioArtifact } from "../../../lib/studio/types";

import { type AudioMode, AudioPanel } from "./studio/StudioAudioPanels";
import { type ImageMode, ImagePanel } from "./studio/StudioImagePanel";
import { type VideoHandoff, VideoPanel } from "./studio/StudioVideoPanel";
import { StudioViewer } from "./studio/StudioViewer";
import { StudioGallery } from "./studio/StudioGallery";
import { RecentStrip } from "./studio/StudioLibrary";
import { handOffImagePrompt } from "../../../lib/studio/prompt-handoff";
import { EmptyState } from "../../ui/EmptyState";
import { Spinner } from "../../ui/Spinner";
import { StackHeader } from "../StackHeader";
import { ActionSheet } from "../ActionSheet";
import "../../studio/stage/stage.css";

// No "flows" here: the guided workflow editor was unusable at phone size and
// was removed from the phone. Productions stay a desktop surface.
type StudioMode = "image" | "video" | "audio" | "library";

// Carpe Diem streams the finished track as the retrieve body (one shot);
// Venice answers JSON with an `audio_url`. Both shapes must be accepted.
const _AUDIO_URL_FIELDS = ["audio_url", "url"];

/** Gallery buckets that hold something reference audio can come from. */
const AUDIO_ARTIFACT_KINDS: ArtifactKind[] = ["music", "speech", "sfx"];

/**
 * Mobile Studio: image, video and sound over the shared studio lib (catalog,
 * async job queue with resume, on-device gallery). The desktop keeps its
 * workflow canvas and productions.
 */
export function StudioScreen() {
  const [imageFailures, setImageFailures] = useState(readStandaloneImageFailures);
  useEffect(() => {
    const refresh = () => setImageFailures(readStandaloneImageFailures());
    window.addEventListener(STUDIO_IMAGE_FAILED_EVENT, refresh);
    return () => window.removeEventListener(STUDIO_IMAGE_FAILED_EVENT, refresh);
  }, []);
  const credits = useCarpeDiemCredits();
  const payLinkAllowed = usePayPolicy()?.linkAllowed === true;
  const [catalog, setCatalog] = useState<MediaCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [mode, setMode] = useState<StudioMode>("image");
  const [rateOpen, setRateOpen] = useState(false);
  const [artifacts, setArtifacts] = useState<StudioArtifact[]>([]);
  const [preview, setPreview] = useState<StudioArtifact | null>(null);
  /** The list the open item was picked from, for moving to its neighbours. */
  const [previewAmong, setPreviewAmong] = useState<StudioArtifact[]>([]);
  /** A synchronous render in flight (an image, a narration): those paths
   * write no job row, so the panel says so itself and Recent shows the cell. */
  const [localWorking, setLocalWorking] = useState<ArtifactKind | undefined>(undefined);
  const setImageWorking = useCallback(
    (working: boolean) => setLocalWorking(working ? "image" : undefined),
    [],
  );
  const setSpeechWorking = useCallback(
    (working: boolean) => setLocalWorking(working ? "speech" : undefined),
    [],
  );
  /** The durable renders in flight that the Studio queued by hand, for the
   * cells they will take in Recent and in the gallery. */
  const running = useRunningMediaJobs();
  const pendingOf = useCallback(
    (kind: ArtifactKind | undefined) => {
      const rows = running.filter((job) => isStudioOwned(job) && (!kind || job.kind === kind));
      // A heavy image goes through the queue and so has a row of its own while
      // the panel still holds its flag: one render, one cell.
      const rowOfSameKind = rows.some((job) => job.kind === localWorking);
      const local =
        localWorking && (!kind || localWorking === kind) && !rowOfSameKind
          ? [{ key: `local:${localWorking}` }]
          : [];
      return [...local, ...rows.map((job) => ({ key: job.id }))];
    },
    [localWorking, running],
  );
  // Lifted so the lightbox's "use as reference" can feed the image panel and
  // jump it straight into its Edit sub-mode.
  const [imageMode, setImageMode] = useState<ImageMode>("generate");
  // Lifted so the gallery under the audio tab follows the active sub-mode.
  const [audioMode, setAudioMode] = useState<AudioMode>("music");
  // A handoff frame waiting to be applied to the video panel's form.
  const [videoHandoff, setVideoHandoff] = useState<VideoHandoff | undefined>(undefined);

  useEffect(() => {
    fetchMediaCatalog()
      .then(setCatalog)
      .catch((err: unknown) =>
        setCatalogError(
          err instanceof Error ? t(err.message) : t("The model catalog is unavailable."),
        ),
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
  useEffect(() => {
    window.addEventListener(STUDIO_IMAGE_RECOVERED_EVENT, refreshGallery);
    return () => window.removeEventListener(STUDIO_IMAGE_RECOVERED_EVENT, refreshGallery);
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
    // The Studio is a stage: dark in either theme, the controls on glass, the
    // same room the retouch tab renders into (CONTEXT.md, "Stage").
    <div className="mobile-screen-root mobile-studio-stage stage">
      <StackHeader
        title={t("Studio")}
        large
        trailing={
          credits ? (
            // "x0.43" was the price multiplier as the API names it. Said as
            // a discount it reads without a manual, and the tap says the rest.
            <button
              type="button"
              className="mobile-credits-pill"
              aria-label={t("Available credits: {credits}", {
                credits: formatCredits(credits.availableCredits),
              })}
              aria-haspopup="dialog"
              onClick={() => setRateOpen(true)}
            >
              {formatCredits(credits.availableCredits)}
              {rateBadge(credits.priceMultiplier) ? ` · ${rateBadge(credits.priceMultiplier)}` : ""}
            </button>
          ) : undefined
        }
      />
      {imageFailures[0] ? (
        <div className="stage-notice mobile-studio-notice" data-tone="error" role="alert">
          <span>
            {t("An image could not be generated: {reason}", { reason: imageFailures[0].message })}
          </span>
          <button
            type="button"
            className="mobile-chip-button"
            onClick={() => dismissStandaloneImageFailure(imageFailures[0].id)}
          >
            {t("Dismiss")}
          </button>
        </div>
      ) : null}
      <div className="mobile-segmented" role="tablist" aria-label={t("Studio mode")}>
        {(["image", "video", "audio", "library"] as const).map((entry) => (
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
              ? t("Image")
              : entry === "video"
                ? t("Video")
                : entry === "audio"
                  ? t("Audio")
                  : t("Gallery")}
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
                galleryImages={galleryImages}
                onGenerated={refreshGallery}
                onWorking={setImageWorking}
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
                galleryTracks={galleryTracks}
                onWorking={setSpeechWorking}
              />
            ) : (
              <StudioGallery
                items={artifacts}
                onOpen={(artifact, among) => {
                  setPreview(artifact);
                  setPreviewAmong(among);
                }}
                onChanged={refreshGallery}
                onContinueShot={(artifact) => void handleContinueShot(artifact)}
                onReusePrompt={(artifact) => {
                  handOffImagePrompt(artifact.prompt);
                  setImageMode("generate");
                  setMode("image");
                }}
                pending={pendingOf(undefined)}
              />
            )}
            {galleryKind ? (
              <RecentStrip
                items={galleryItems}
                kind={galleryKind}
                onOpen={setPreview}
                onSeeAll={() => setMode("library")}
                pending={pendingOf(galleryKind)}
              />
            ) : null}
          </>
        )}
      </div>
      {rateOpen && credits ? (
        <ActionSheet
          title={formatCredits(credits.availableCredits)}
          subtitle={rateSentence(credits.priceMultiplier)}
          actions={payLinkAllowed ? [{ label: t("Top up"), onAction: requestAddCredits }] : []}
          closeLabel={t("OK")}
          onClose={() => setRateOpen(false)}
        />
      ) : null}
      {preview ? (
        <StudioViewer
          artifact={preview}
          among={previewAmong.length ? previewAmong : [preview]}
          onNavigate={setPreview}
          onClose={() => setPreview(null)}
          onDelete={() => {
            // Deleting moves on to the neighbour, as a photo viewer does.
            const list = previewAmong.length ? previewAmong : [preview];
            const at = list.findIndex((entry) => entry.path === preview.path);
            const neighbour = list[at + 1] ?? list[at - 1];
            const rest = list.filter((entry) => entry.path !== preview.path);
            void handleDeleteArtifact(preview).then(() => {
              setPreviewAmong(rest);
              if (neighbour) setPreview(neighbour);
            });
          }}
          onContinueShot={
            preview.kind === "video" ? () => void handleContinueShot(preview) : undefined
          }
          onReusePrompt={() => {
            handOffImagePrompt(preview.prompt);
            setPreview(null);
            setImageMode("generate");
            setMode("image");
          }}
          onUpscaled={refreshGallery}
          canRemoveBackground={Boolean(catalog && supportsBackgroundRemoval(catalog))}
        />
      ) : null}
    </div>
  );
}

/** Today's rate as a discount ("-57 %"), or nothing at the base price. */
function rateBadge(multiplier: number | undefined): string | undefined {
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier)) return undefined;
  const percent = Math.round((1 - multiplier) * 100);
  if (percent === 0) return undefined;
  return percent > 0
    ? t("-{percent} %", { percent })
    : t("+{percent} %", { percent: Math.abs(percent) });
}

/** What the rate means, for the sheet behind the credits pill. */
function rateSentence(multiplier: number | undefined): string {
  const base = t("Credits pay for renders at the provider's price.");
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier)) return base;
  const percent = Math.round((1 - multiplier) * 100);
  if (percent === 0) return `${base} ${t("Today's rate is the base price.")}`;
  return `${base} ${
    percent > 0
      ? t(
          "Today's rate is {percent}% below the base price. It changes every day at midnight UTC.",
          {
            percent,
          },
        )
      : t(
          "Today's rate is {percent}% above the base price. It changes every day at midnight UTC.",
          {
            percent: Math.abs(percent),
          },
        )
  }`;
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
