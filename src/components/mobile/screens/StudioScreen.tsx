import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IconAudio } from "central-icons/IconAudio";
import { IconPlay } from "central-icons-filled/IconPlay";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconClipboard } from "central-icons/IconClipboard";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  artifactDataUri,
  artifactDataUrl,
  evictArtifactDataUrl,
  useArtifactDataUrl,
  useArtifactThumbnail,
} from "../../../lib/artifact-media";
import { useCarpeDiemCredits } from "../../../lib/carpe-diem-credits";
import { hapticNotify, hapticSelection } from "../../../lib/haptics";
import { isMobilePlatform } from "../../../lib/mobile";
import { Switch } from "../../ui/Switch";
import {
  deleteArtifact,
  listArtifacts,
  readArtifactBase64,
  saveArtifactFromBase64,
  registerDownloadedArtifact,
} from "../../../lib/studio/artifacts";
import {
  defaultEditModel,
  estimateCostCredits,
  fetchMediaCatalog,
  formatCredits,
  imageEditModels,
  modelsOfType,
  musicCapabilities,
  isReferenceToVideoModel,
  isSeedanceModel,
  musicModels,
  soundEffectsModels,
  supportsBackgroundRemoval,
  variantFor,
  variantHint,
  videoFamilies,
  videoFamilySearchTerms,
} from "../../../lib/studio/catalog";
import {
  hasSeedanceConsent,
  needsSeedanceConsent,
  rememberSeedanceConsent,
} from "../../../lib/studio/consent";
import {
  maxReferenceAudio,
  maxReferenceVideos,
  maxVideoReferences,
  referenceMention,
  seedancePersonMediaCaveat,
  seedancePromptAdvice,
  seedanceImageProblem,
  seedanceWorkflowsFor,
  requestSizeProblem,
  takesReferenceAudio,
  takesReferenceClips,
} from "../../../lib/studio/seedance";
import {
  mediaSeconds,
  type ReferenceMedia,
  referenceAudioProblem,
  referenceClipProblem,
  referenceFileTooBig,
} from "../../../lib/studio/reference-media";
import { JobFailureNotice } from "../../studio/JobFailureNotice";
import { continuationPrompt, extractHandoffFrame } from "../../../lib/studio/frames";
import { inlineMediaInputs, videoRequestBody } from "../../../lib/studio/video-request";
import {
  effectiveVideoConstraints,
  rememberConstraintError,
} from "../../../lib/studio/model-constraints";
import {
  generateSpeech,
  SPEECH_FORMATS,
  SPEECH_INPUT_LIMIT,
  SPEECH_SPEED,
  type SpeechFormat,
} from "../../../lib/studio/speech";
import { mediaGet, mediaJson } from "../../../lib/studio/client";
import { enhanceImagePrompt } from "../../../lib/studio/enhance-prompt";
import {
  composeImages,
  MAX_COMPOSE_IMAGES,
  removeBackground,
  upscaleImage,
} from "../../../lib/studio/edit-image";
import { imageSize, prepareEditReference } from "../../../lib/studio/downscale";
import { compareBodies, generateImages } from "../../../lib/studio/generate-image";
import { useMediaJob } from "../../../lib/studio/async-job";
import {
  VIDEO_QUEUE_PATH,
  VIDEO_QUOTE_PATH,
  VIDEO_RETRIEVE_PATH,
  musicPaths,
  retrieveBody,
  supportsVideoQuote,
} from "../../../lib/studio/paths";
import type { ArtifactKind, MediaCatalog, StudioArtifact } from "../../../lib/studio/types";
import { saveToPhotos, setPlaybackAudioSession } from "../../../lib/tauri";

/** Best-effort iOS audio-session flip around media playback: `.playback`
 * keeps generated music/video audible past the lock screen and the silent
 * switch. No-op off iOS (the command only exists there). */
function markMediaPlayback(active: boolean) {
  if (!isMobilePlatform()) return;
  void setPlaybackAudioSession(active).catch(() => undefined);
}
import { EmptyState } from "../../ui/EmptyState";
import { Spinner } from "../../ui/Spinner";
import { ModelSheet } from "../ModelSheet";
import { StackHeader } from "../StackHeader";
import { formatNoteTime } from "./NoteRow";
import { FlowsPanel } from "./FlowsPanel";

type StudioMode = "image" | "video" | "audio" | "flows" | "library";
type ImageMode = "generate" | "edit" | "upscale" | "cutout";
type AudioMode = "music" | "speech" | "sfx";

const VIDEO_URL_FIELDS = ["video_url", "url"];
// Carpe Diem streams the finished track as the retrieve body (one shot);
// Venice answers JSON with an `audio_url`. Both shapes must be accepted.
const AUDIO_URL_FIELDS = ["audio_url", "url"];

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
        title="Studio"
        large
        trailing={
          credits ? (
            <span className="mobile-credits-pill" aria-label="Available credits">
              {formatCredits(credits.availableCredits)}
              {typeof credits.priceMultiplier === "number"
                ? ` · x${credits.priceMultiplier.toFixed(2)}`
                : ""}
            </span>
          ) : undefined
        }
      />
      <div className="mobile-segmented" role="tablist" aria-label="Studio mode">
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
          <EmptyState title="Studio is unavailable" description={catalogError} />
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

// --- Model picker button --------------------------------------------------------

function ModelPickerButton({
  label,
  value,
  hint,
  onOpen,
}: {
  label: string;
  value: string;
  /** What the choice resolved to, when the row's value does not say it all
   * (a video family is one row for up to four backend models). */
  hint?: string;
  onOpen: () => void;
}) {
  const chosen = value || "Choose";
  return (
    <button
      type="button"
      className="mobile-model-select"
      onClick={onOpen}
      // The hint is the part that changes under the user without a tap, so it
      // has to reach a screen reader too.
      aria-label={hint ? `${label}, ${chosen}, ${hint}` : label}
    >
      <span className="mobile-model-select-label">{label}</span>
      <span className="mobile-model-select-choice">
        <span className="mobile-model-select-value">{chosen}</span>
        {hint ? <span className="mobile-model-select-hint">{hint}</span> : null}
      </span>
    </button>
  );
}

// --- Image ------------------------------------------------------------------

/** Strip a `data:...;base64,` prefix so the raw bytes can go to /image/upscale,
 * which (unlike /image/edit) rejects a data URI. */
function rawBase64(dataUri: string): string {
  return dataUri.replace(/^data:[^,]+,/, "");
}

/** The current value when the model still offers it, else its first option. A
 * stored choice can go stale when the model changes and drops that option. */
function pickEffective(options: string[], value: string): string {
  return value && options.includes(value) ? value : (options[0] ?? "");
}

/** A labelled settings row: a caption above its control (pills, an input...). */
function StudioSetting({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="mobile-studio-field">
      <div className="mobile-studio-field-head">
        <span className="mobile-studio-field-label">{label}</span>
        {hint ? <span className="mobile-studio-field-value">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** A labelled integer slider with a live value readout (Steps, Variants). */
function SliderSetting({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="mobile-studio-field">
      <div className="mobile-studio-field-head">
        <span className="mobile-studio-field-label">{label}</span>
        <span className="mobile-studio-field-value">{value}</span>
      </div>
      <input
        type="range"
        className="mobile-studio-slider"
        min={min}
        max={max}
        step={1}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function ImagePanel({
  catalog,
  mode,
  onModeChange,
  references,
  onReferencesChange,
  galleryImages,
  onGenerated,
}: {
  catalog: MediaCatalog;
  mode: ImageMode;
  onModeChange: (mode: ImageMode) => void;
  references: string[];
  onReferencesChange: (refs: string[]) => void;
  galleryImages: StudioArtifact[];
  onGenerated: () => void;
}) {
  const generateModels = useMemo(() => modelsOfType(catalog, "image"), [catalog]);
  const editModels = useMemo(() => imageEditModels(catalog), [catalog]);
  const cutoutAvailable = supportsBackgroundRemoval(catalog);
  const models = mode === "edit" ? editModels : generateModels;
  const [generateModelId, setGenerateModelId] = useState(generateModels[0]?.id ?? "");
  // Empty = "Automatic": a sensible default edit model is resolved on use.
  const [editModelId, setEditModelId] = useState("");
  const modelId = mode === "edit" ? editModelId : generateModelId;
  const model =
    mode === "edit"
      ? (models.find((entry) => entry.id === modelId) ?? defaultEditModel(catalog) ?? models[0])
      : (models.find((entry) => entry.id === modelId) ?? models[0]);
  const [prompt, setPrompt] = useState("");
  // Generate-only settings, at parity with the desktop image studio. They are
  // constraint-driven: aspect/resolution/steps only show when the model exposes
  // them, and `variants` fans out into that many images (heavy models render
  // one queue job per variant — see generate-image.ts).
  const [negativePrompt, setNegativePrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState("");
  const [resolution, setResolution] = useState("");
  const [steps, setSteps] = useState(0);
  const [variants, setVariants] = useState(1);
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Side-by-side comparison: extra models that render the same prompt, one
  // image each, next to the main model's output.
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [comparePickerOpen, setComparePickerOpen] = useState(false);
  // Output and prompt niceties, at parity with the desktop image studio.
  const [stylePreset, setStylePreset] = useState("");
  const [styles, setStyles] = useState<string[]>([]);
  const [stylePickerOpen, setStylePickerOpen] = useState(false);
  const [format, setFormat] = useState<"png" | "webp" | "jpeg">("png");
  const [hideWatermark, setHideWatermark] = useState(true);
  const [embedExif, setEmbedExif] = useState(false);
  const [improvePrompt, setImprovePrompt] = useState(false);
  // Upscale and cutout share one single-image source, separate from the
  // shared edit references.
  const [upscaleRefs, setUpscaleRefs] = useState<string[]>([]);
  const [scale, setScale] = useState<2 | 3 | 4>(2);

  // Style presets are a Venice nicety the backend may not expose: hide the
  // picker when the request fails rather than surfacing an error.
  useEffect(() => {
    let cancelled = false;
    mediaGet<{ data?: string[] }>("/image/styles")
      .then((response) => {
        if (!cancelled && Array.isArray(response?.data)) setStyles(response.data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // The cutout mode disappears when the backend loses the endpoint; leave no
  // orphaned selection.
  useEffect(() => {
    if (!cutoutAvailable && mode === "cutout") onModeChange("generate");
  }, [cutoutAvailable, mode, onModeChange]);

  const constraints = mode === "generate" ? model?.constraints : undefined;
  const aspectOptions = constraints?.aspectRatios ?? [];
  const resolutionOptions = constraints?.resolutions ?? [];
  const maxSteps = constraints?.steps?.max ?? 0;
  const defaultSteps = constraints?.steps?.default ?? 1;
  const effectiveAspect = pickEffective(aspectOptions, aspectRatio);
  const effectiveResolution = pickEffective(resolutionOptions, resolution);
  const compareModels = useMemo(
    () =>
      compareIds
        .filter((id) => id !== model?.id)
        .map((id) => generateModels.find((entry) => entry.id === id))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    [compareIds, model, generateModels],
  );
  const comparing = mode === "generate" && compareModels.length > 0;
  const baseCost = model
    ? estimateCostCredits(model, { multiplier: catalog.priceMultiplier })
    : undefined;
  // Generate is billed per variant (or per compared model); edit/upscale are
  // single-shot.
  const cost = comparing
    ? [model, ...compareModels].reduce<number | undefined>((sum, entry) => {
        if (!entry) return sum;
        const each = estimateCostCredits(entry, { multiplier: catalog.priceMultiplier });
        if (each === undefined) return sum;
        return (sum ?? 0) + each;
      }, undefined)
    : baseCost !== undefined && mode === "generate"
      ? baseCost * variants
      : baseCost;

  const generate = useCallback(async () => {
    if (!model || !prompt.trim() || busy) return;
    if (mode === "edit" && references.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // Optional AI pass that expands the prompt before generation. Best
      // effort: a failure falls back to the prompt as typed.
      const usedPrompt =
        mode === "generate" && improvePrompt
          ? await enhanceImagePrompt(prompt.trim(), catalog)
          : prompt.trim();
      if (comparing) {
        // Comparison run: the same prompt across every selected model, one
        // image each; per-model settings limited to what each supports.
        const runs = compareBodies([model, ...compareModels], usedPrompt, {
          negativePrompt,
          seed: seed.trim() && Number.isFinite(Number(seed)) ? Number(seed) : undefined,
          aspectRatio: effectiveAspect || undefined,
        });
        const settled = await Promise.allSettled(
          runs.map(async ({ model: target, body }) => {
            const images = await generateImages(target.id, body);
            if (images.length === 0) throw new Error("The backend returned no image.");
            for (const base64 of images) {
              await saveArtifactFromBase64(base64, "png", {
                kind: "image",
                model: target.id,
                prompt: usedPrompt,
              });
            }
          }),
        );
        const failures = settled.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failures.length === settled.length) throw failures[0].reason;
        if (failures.length > 0) {
          setError("Some models failed; the rest landed in the gallery.");
        }
        hapticNotify("success");
        onGenerated();
        return;
      }
      let images: string[];
      let extension = "png";
      if (mode === "edit") {
        // One reference edits that photo; two or three compose them into a
        // single image (Carpe Diem's multi-edit). The picker is capped to
        // MAX_COMPOSE_IMAGES, so every reference here is sent.
        images = [await composeImages(model.id, prompt.trim(), references)];
      } else {
        const body: Record<string, unknown> = {
          model: model.id,
          prompt: usedPrompt,
          variants,
          format,
          hide_watermark: hideWatermark,
          safe_mode: false,
        };
        if (embedExif) body.embed_exif_metadata = true;
        if (stylePreset) body.style_preset = stylePreset;
        if (negativePrompt.trim()) body.negative_prompt = negativePrompt.trim();
        if (effectiveAspect) body.aspect_ratio = effectiveAspect;
        if (effectiveResolution) body.resolution = effectiveResolution;
        if (maxSteps > 0 && steps > 0) body.steps = steps;
        if (seed.trim() && Number.isFinite(Number(seed))) body.seed = Number(seed);
        images = await generateImages(model.id, body);
        extension = format;
      }
      if (images.length === 0) throw new Error("The backend returned no image.");
      for (const base64 of images) {
        await saveArtifactFromBase64(base64, extension, {
          kind: "image",
          model: model.id,
          prompt: usedPrompt,
        });
      }
      if (mode === "edit") {
        // Chain: the result becomes the next source, so successive edits
        // build on each other while every step stays in the gallery.
        const chained = await prepareEditReference(`data:image/png;base64,${images[0]}`);
        onReferencesChange([chained]);
        setPrompt("");
      }
      hapticNotify("success");
      onGenerated();
    } catch (err) {
      hapticNotify("error");
      setError(err instanceof Error ? err.message : "The generation failed.");
    } finally {
      setBusy(false);
    }
  }, [
    model,
    prompt,
    busy,
    mode,
    comparing,
    compareModels,
    catalog,
    improvePrompt,
    format,
    hideWatermark,
    embedExif,
    stylePreset,
    references,
    onReferencesChange,
    onGenerated,
    variants,
    negativePrompt,
    effectiveAspect,
    effectiveResolution,
    maxSteps,
    steps,
    seed,
  ]);

  const upscale = useCallback(async () => {
    if (upscaleRefs.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await upscaleImage(rawBase64(upscaleRefs[0]), scale);
      await saveArtifactFromBase64(result, "png", {
        kind: "image",
        model: "upscale",
        prompt: `Upscaled image (x${scale})`,
      });
      hapticNotify("success");
      setUpscaleRefs([]);
      onGenerated();
    } catch (err) {
      hapticNotify("error");
      setError(err instanceof Error ? err.message : "The upscale failed.");
    } finally {
      setBusy(false);
    }
  }, [upscaleRefs, scale, busy, onGenerated]);

  const cutout = useCallback(async () => {
    if (upscaleRefs.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await removeBackground(upscaleRefs[0]);
      await saveArtifactFromBase64(result, "png", {
        kind: "image",
        model: "background-remover",
        prompt: "Background removed",
      });
      hapticNotify("success");
      setUpscaleRefs([]);
      onGenerated();
    } catch (err) {
      hapticNotify("error");
      setError(err instanceof Error ? err.message : "The cutout failed.");
    } finally {
      setBusy(false);
    }
  }, [upscaleRefs, busy, onGenerated]);

  const modes: ImageMode[] = cutoutAvailable
    ? ["generate", "edit", "upscale", "cutout"]
    : ["generate", "edit", "upscale"];

  return (
    <div className="mobile-studio-form">
      <div className="mobile-segmented" role="tablist" aria-label="Image mode">
        {modes.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={mode === entry}
            className="mobile-segmented-item"
            data-active={mode === entry ? "true" : undefined}
            onClick={() => onModeChange(entry)}
          >
            {entry === "generate"
              ? "Generate"
              : entry === "edit"
                ? "Edit"
                : entry === "upscale"
                  ? "Upscale"
                  : "Cutout"}
          </button>
        ))}
      </div>

      {mode === "cutout" ? (
        <>
          <ReferencePicker
            references={upscaleRefs}
            onChange={(refs) => setUpscaleRefs(refs.slice(-1))}
            galleryImages={galleryImages}
            hint={
              upscaleRefs.length === 0
                ? "Pick an image; the background lifts out into a transparent PNG."
                : undefined
            }
          />
          <button
            type="button"
            className="mobile-studio-generate"
            disabled={upscaleRefs.length === 0 || busy}
            onClick={() => void cutout()}
          >
            {busy ? <Spinner /> : "Remove background"}
          </button>
        </>
      ) : mode === "upscale" ? (
        <>
          <ReferencePicker
            references={upscaleRefs}
            onChange={(refs) => setUpscaleRefs(refs.slice(-1))}
            galleryImages={galleryImages}
            hint={
              upscaleRefs.length === 0
                ? "Pick an image to enlarge (at least 256 by 256 pixels)."
                : undefined
            }
          />
          <div className="mobile-pill-row" role="radiogroup" aria-label="Upscale factor">
            {([2, 3, 4] as const).map((factor) => (
              <button
                key={factor}
                type="button"
                className="mobile-pill"
                data-active={scale === factor ? "true" : undefined}
                onClick={() => setScale(factor)}
              >
                {`x${factor}`}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="mobile-studio-generate"
            disabled={upscaleRefs.length === 0 || busy}
            onClick={() => void upscale()}
          >
            {busy ? <Spinner /> : `Upscale x${scale}`}
          </button>
        </>
      ) : (
        <>
          <ModelPickerButton
            label={mode === "edit" ? "Edit model" : "Image model"}
            value={mode === "edit" && !editModelId ? "Automatic" : (model?.name ?? "")}
            onOpen={() => setPickerOpen(true)}
          />
          {mode === "edit" ? (
            <ReferencePicker
              references={references}
              onChange={(refs) => onReferencesChange(refs.slice(0, MAX_COMPOSE_IMAGES))}
              galleryImages={galleryImages}
              prepare={prepareEditReference}
              hint={
                references.length > 1
                  ? `Combining ${references.length} photos into one (up to ${MAX_COMPOSE_IMAGES}). The prompt can call them image 1, image 2, in the order shown.`
                  : references.length === 1
                    ? "The prompt describes the edit. Add another photo to combine them."
                    : "Add a photo to edit, or two to three to combine."
              }
            />
          ) : null}
          <textarea
            className="mobile-studio-prompt"
            value={prompt}
            rows={3}
            placeholder={
              mode === "edit"
                ? references.length > 1
                  ? "Describe how to combine the photos"
                  : "Describe how to transform the photo"
                : "Describe the image to generate"
            }
            onChange={(event) => setPrompt(event.target.value)}
          />
          {mode === "generate" ? (
            <>
              {aspectOptions.length > 0 ? (
                <StudioSetting label="Aspect ratio">
                  <div className="mobile-pill-row" role="radiogroup" aria-label="Aspect ratio">
                    {aspectOptions.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className="mobile-pill"
                        data-active={effectiveAspect === option ? "true" : undefined}
                        onClick={() => setAspectRatio(option)}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </StudioSetting>
              ) : null}
              <MoreOptions>
                <textarea
                  className="mobile-studio-prompt"
                  value={negativePrompt}
                  rows={2}
                  placeholder="Negative prompt (optional)"
                  aria-label="Negative prompt"
                  onChange={(event) => setNegativePrompt(event.target.value)}
                />
                {resolutionOptions.length > 0 ? (
                  <StudioSetting label="Resolution">
                    <div className="mobile-pill-row" role="radiogroup" aria-label="Resolution">
                      {resolutionOptions.map((option) => (
                        <button
                          key={option}
                          type="button"
                          className="mobile-pill"
                          data-active={effectiveResolution === option ? "true" : undefined}
                          onClick={() => setResolution(option)}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  </StudioSetting>
                ) : null}
                {maxSteps > 1 ? (
                  <SliderSetting
                    label="Steps"
                    min={1}
                    max={maxSteps}
                    value={steps > 0 ? Math.min(steps, maxSteps) : defaultSteps}
                    onChange={setSteps}
                  />
                ) : null}
                {!comparing ? (
                  <SliderSetting
                    label="Variants"
                    min={1}
                    max={4}
                    value={variants}
                    onChange={setVariants}
                  />
                ) : null}
                <StudioSetting
                  label="Compare models"
                  hint={comparing ? `${compareModels.length + 1} side by side` : "Optional"}
                >
                  <div className="mobile-reference-actions">
                    {compareModels.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        className="mobile-chip-button"
                        aria-label={`Stop comparing with ${entry.name}`}
                        onClick={() =>
                          setCompareIds((current) => current.filter((id) => id !== entry.id))
                        }
                      >
                        {entry.name} x
                      </button>
                    ))}
                    <button
                      type="button"
                      className="mobile-chip-button"
                      onClick={() => setComparePickerOpen(true)}
                    >
                      Add a model
                    </button>
                  </div>
                </StudioSetting>
                <StudioSetting label="Seed" hint="Blank for random">
                  <input
                    className="mobile-studio-input"
                    inputMode="numeric"
                    value={seed}
                    placeholder="Random"
                    aria-label="Seed"
                    onChange={(event) => setSeed(event.target.value.replace(/[^0-9]/g, ""))}
                  />
                </StudioSetting>
                {styles.length > 0 ? (
                  <ModelPickerButton
                    label="Style"
                    value={stylePreset || "None"}
                    onOpen={() => setStylePickerOpen(true)}
                  />
                ) : null}
                <StudioToggle
                  label="Improve prompt with AI"
                  checked={improvePrompt}
                  onChange={setImprovePrompt}
                />
                <StudioSetting label="Format">
                  <div className="mobile-pill-row" role="radiogroup" aria-label="Image format">
                    {(["png", "webp", "jpeg"] as const).map((entry) => (
                      <button
                        key={entry}
                        type="button"
                        className="mobile-pill"
                        data-active={format === entry ? "true" : undefined}
                        onClick={() => setFormat(entry)}
                      >
                        {entry}
                      </button>
                    ))}
                  </div>
                </StudioSetting>
                <StudioToggle
                  label="Hide watermark"
                  checked={hideWatermark}
                  onChange={setHideWatermark}
                />
                <StudioToggle
                  label="Embed prompt in metadata"
                  checked={embedExif}
                  onChange={setEmbedExif}
                />
              </MoreOptions>
            </>
          ) : null}
          <button
            type="button"
            className="mobile-studio-generate"
            disabled={
              !model || !prompt.trim() || busy || (mode === "edit" && references.length === 0)
            }
            onClick={() => void generate()}
          >
            {busy ? <Spinner /> : "Generate"}
            {!busy && cost !== undefined ? (
              <span className="mobile-studio-cost">{formatCredits(cost)}</span>
            ) : null}
          </button>
          {busy && mode === "edit" ? (
            <p className="mobile-studio-progress" data-shimmer="true">
              {references.length > 1 ? "Combining photos" : "Editing"}. Heavy models can take a
              minute or two.
            </p>
          ) : null}
        </>
      )}
      {error ? <p className="mobile-dictation-error">{error}</p> : null}
      {pickerOpen ? (
        <ModelSheet
          title={mode === "edit" ? "Edit model" : "Image model"}
          entries={models.map((entry) => ({
            id: entry.id,
            name: entry.name,
            subtitle: [entry.tier, entry.privacy].filter(Boolean).join(" · "),
          }))}
          selectedId={mode === "edit" ? editModelId : (model?.id ?? "")}
          defaultOption={
            mode === "edit"
              ? { label: "Automatic", subtitle: "Picks a capable edit model" }
              : undefined
          }
          onSelect={(id) => {
            if (mode === "edit") setEditModelId(id);
            else if (id) setGenerateModelId(id);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
      {comparePickerOpen ? (
        <ModelSheet
          title="Compare with"
          entries={generateModels
            .filter((entry) => entry.id !== model?.id && !compareIds.includes(entry.id))
            .map((entry) => ({
              id: entry.id,
              name: entry.name,
              subtitle: [entry.tier, entry.privacy].filter(Boolean).join(" · "),
            }))}
          selectedId=""
          onSelect={(id) => {
            if (id) setCompareIds((current) => [...current, id]);
            setComparePickerOpen(false);
          }}
          onClose={() => setComparePickerOpen(false)}
        />
      ) : null}
      {stylePickerOpen ? (
        <ModelSheet
          title="Style"
          entries={styles.map((entry) => ({ id: entry, name: entry, subtitle: "" }))}
          selectedId={stylePreset}
          defaultOption={{ label: "None", subtitle: "No style preset" }}
          onSelect={(id) => {
            setStylePreset(id);
            setStylePickerOpen(false);
          }}
          onClose={() => setStylePickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

// --- Video ------------------------------------------------------------------

// How many reference photos are allowed is per family (`maxVideoReferences`):
// seedance 2.0 documents 9 and 2.5 documents 30, everything else keeps a low
// default. Same rule as the desktop studio.

/** A frame handed off from a finished clip, waiting to open the next shot. */
interface VideoHandoff {
  dataUrl: string;
  prompt: string;
  /** Gallery id of the clip being continued, recorded on the durable row. */
  artifactId: string;
  /** Model the source clip was rendered with, reselected when it does i2v. */
  model: string;
  fileName: string;
  timeSeconds: number;
  durationSeconds: number;
}

function VideoPanel({
  catalog,
  galleryImages,
  galleryClips,
  galleryTracks,
  onGenerated,
  handoff,
  onHandoffApplied,
}: {
  catalog: MediaCatalog;
  galleryImages: StudioArtifact[];
  /** Rendered clips, for the reference-clip slot. */
  galleryClips: StudioArtifact[];
  /** Rendered music, speech and sound effects, for the reference-audio slot. */
  galleryTracks: StudioArtifact[];
  onGenerated: () => void;
  /** Pending handoff to load into the form; cleared once applied. */
  handoff?: VideoHandoff;
  onHandoffApplied: () => void;
}) {
  const families = useMemo(() => videoFamilies(catalog), [catalog]);
  const familiesForMode = useMemo(
    () =>
      families.filter((family) => family.textModel || family.imageModel || family.referenceModel),
    [families],
  );
  const [familyKey, setFamilyKey] = useState("");
  const family = familiesForMode.find((entry) => entry.key === familyKey) ?? familiesForMode[0];
  // Inputs, not modes: an opening frame and reference photos are independent
  // and combinable, and the variant follows from what is filled in (same rule
  // as the desktop studio).
  const [openingFrame, setOpeningFrame] = useState<string[]>([]);
  const [references, setReferences] = useState<string[]>([]);
  /** Why the last reference photo was refused, if it was. */
  const [referenceError, setReferenceError] = useState<string | undefined>(undefined);
  /** Reference clips: what the seedance edit, extend and stitch workflows work
   * from. Only the variants that declare a video input take them. */
  const [referenceClips, setReferenceClips] = useState<ReferenceMedia[]>([]);
  const [clipError, setClipError] = useState<string | undefined>(undefined);
  /** Reference audio: a timbre or a voice for the render to follow. Never sent
   * alone - the contract forbids it - so it rides with a photo or a clip. */
  const [referenceAudio, setReferenceAudio] = useState<ReferenceMedia[]>([]);
  const [audioError, setAudioError] = useState<string | undefined>(undefined);
  const model = variantFor(family, {
    hasFrame: openingFrame.length > 0,
    // A clip resolves the variant exactly like a photo does: edit, extend and
    // stitch all live on reference-to-video.
    hasReferences: references.length > 0 || referenceClips.length > 0,
  });
  /** Any media showing a person can drive the render: an opening frame, a
   * reference photo, or the clip being edited or extended. */
  const buildsFromFaceMedia =
    openingFrame.length > 0 || references.length > 0 || referenceClips.length > 0;
  /** How many reference photos this family takes. Read off the reference
   * variant, which holds while the first photo is still being added. */
  const referenceCap = maxVideoReferences(family?.referenceModel ?? model);
  /** Whether this family's reference variant takes clips and audio at all. The
   * public `-basic` variants publish no video input and do publish audio. */
  const clipsAllowed = takesReferenceClips(family?.referenceModel);
  const audioAllowed = takesReferenceAudio(family?.referenceModel);
  /** The prompt openings this model can actually be routed with. */
  const workflows = seedanceWorkflowsFor(family?.referenceModel);
  // Seedance needs a face-media attestation for any clip built from a photo;
  // remembered so the box stays ticked across sessions.
  const [consent, setConsent] = useState(hasSeedanceConsent);
  const needsConsent = needsSeedanceConsent(model, buildsFromFaceMedia);
  const [constraintEpoch, setConstraintEpoch] = useState(0);
  const constraints = useMemo(
    () => effectiveVideoConstraints(model),
    // biome-ignore lint/correctness/useExhaustiveDependencies: the epoch is the
    // signal that a rejection taught us new options.
    [model, constraintEpoch],
  );
  const [prompt, setPrompt] = useState("");
  /** Seedance reference renders route from the prompt: a wrong opening or a
   * loose mention silently runs the wrong workflow, and bills for it. */
  const promptAdvice = seedancePromptAdvice(model, prompt);
  /** The public seedance variants refuse person-bearing media whatever is
   * attested, so the toggle says what it actually buys. */
  const personMediaCaveat = seedancePersonMediaCaveat(model);
  const [negativePrompt, setNegativePrompt] = useState("");
  const [duration, setDuration] = useState("");
  const [aspectRatio, setAspectRatio] = useState("");
  const [resolution, setResolution] = useState("");
  const [quote, setQuote] = useState<number | undefined>(undefined);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Rust polled the render and wrote the file into the gallery directory, so
  // this runs even for a job that finished while the app was closed: the hook
  // hydrates from the durable rows on mount.
  const job = useMediaJob("video", (artifact, finished) => {
    registerDownloadedArtifact(artifact, {
      kind: "video",
      model: finished.model,
      prompt: finished.prompt,
      // Read back off the durable row, so a render that landed while the app
      // was suspended still joins its chain.
      parentId: finished.parentArtifactId,
      parentHandoffSeconds: finished.parentHandoffSeconds,
    });
    hapticNotify("success");
    onGenerated();
  });

  // A rejection names what the model wanted; remember it so the pickers offer
  // the right values next time.
  useEffect(() => {
    if (job.state.phase !== "failed" || !job.state.message) return;
    if (!model) return;
    if (Object.keys(rememberConstraintError(model.id, job.state.message)).length > 0) {
      setConstraintEpoch((epoch) => epoch + 1);
    }
  }, [job.state, model]);

  // Switching family can land on a variant that takes no clips (or no audio).
  // What is already picked would then be dropped by `videoRequestBody` at
  // submit, after the prompt had been written around it, so it is let go here
  // while the slot it was in is still on screen.
  useEffect(() => {
    if (clipsAllowed) return;
    setReferenceClips((current) => (current.length > 0 ? [] : current));
    setClipError(undefined);
  }, [clipsAllowed]);
  useEffect(() => {
    if (audioAllowed) return;
    setReferenceAudio((current) => (current.length > 0 ? [] : current));
    setAudioError(undefined);
  }, [audioAllowed]);

  // Both checks live in `reference-media`, so the phone refuses exactly what
  // the desktop refuses - and refuses it before the render is queued and billed.
  const addClip = useCallback(
    (candidate: ReferenceMedia) => {
      const problem = referenceClipProblem(family?.referenceModel, referenceClips, candidate);
      setClipError(problem);
      if (!problem) setReferenceClips((current) => [...current, candidate]);
    },
    [family?.referenceModel, referenceClips],
  );
  const addTrack = useCallback(
    (candidate: ReferenceMedia) => {
      const problem = referenceAudioProblem(referenceAudio, candidate);
      setAudioError(problem);
      if (!problem) setReferenceAudio((current) => [...current, candidate]);
    },
    [referenceAudio],
  );
  const removeClip = useCallback(
    (id: string) => setReferenceClips((current) => current.filter((entry) => entry.id !== id)),
    [],
  );
  const removeTrack = useCallback(
    (id: string) => setReferenceAudio((current) => current.filter((entry) => entry.id !== id)),
    [],
  );

  /** Take reference photos, refusing the shapes this model is known to reject
   * before the render is queued rather than after it has been billed. The
   * provider reports them only once the job is running, which on the durable
   * path is a failure read minutes later. */
  const applyReferences = useCallback(
    async (next: string[]) => {
      const added = next.filter((entry) => !references.includes(entry));
      for (const dataUri of added) {
        const problem = seedanceImageProblem(family?.referenceModel, await imageSize(dataUri));
        if (problem) {
          setReferenceError(problem);
          return;
        }
      }
      setReferenceError(undefined);
      setReferences(next.slice(0, referenceCap));
    },
    [references, referenceCap, family?.referenceModel],
  );

  const durationOptions = constraints?.durations ?? [];
  const effectiveDuration = duration || durationOptions[0] || "";
  const videoAspectOptions = constraints?.aspect_ratios ?? [];
  const effectiveVideoAspect = aspectRatio || videoAspectOptions[0] || "";
  const videoResolutionOptions = constraints?.resolutions ?? [];
  const effectiveVideoResolution = resolution || videoResolutionOptions[0] || "";

  // Where the opening frame came from, so the form says what it is continuing.
  const [handoffFrom, setHandoffFrom] = useState<
    | { artifactId: string; fileName: string; timeSeconds: number; durationSeconds: number }
    | undefined
  >(undefined);

  // A pending handoff loads the form: opening frame, continuity prompt, and
  // the family the source clip was rendered with when it can animate a frame.
  useEffect(() => {
    if (!handoff) return;
    setOpeningFrame([handoff.dataUrl]);
    setPrompt(handoff.prompt);
    const source = families.find((entry) =>
      [entry.textModel, entry.imageModel, entry.referenceModel].some(
        (candidate) => candidate?.id === handoff.model,
      ),
    );
    // Reselect the source family whenever it can start from a frame at all.
    // Requiring an image-to-video slot dropped the reference-only families,
    // which take an opening frame too - continuing one of their shots silently
    // fell back to whichever family happened to be first.
    if (source?.imageModel || source?.referenceModel) setFamilyKey(source.key);
    setHandoffFrom({
      artifactId: handoff.artifactId,
      fileName: handoff.fileName,
      timeSeconds: handoff.timeSeconds,
      durationSeconds: handoff.durationSeconds,
    });
    onHandoffApplied();
  }, [handoff, families, onHandoffApplied]);

  // Same body builder as the desktop studio, so the two shells cannot drift.
  const queueBody = useCallback((): Record<string, unknown> | undefined => {
    if (!model) return undefined;
    return videoRequestBody({
      target: model,
      prompt,
      negativePrompt,
      openingFrame: openingFrame[0],
      references,
      referenceVideos: referenceClips.map((clip) => clip.dataUri),
      // The quote only matches what the queue bills when it is told the
      // combined length, so the two go out together.
      referenceVideoSeconds: referenceClips.map((clip) => clip.seconds),
      referenceAudio: referenceAudio.map((track) => track.dataUri),
      duration: effectiveDuration,
      aspectRatio: effectiveVideoAspect,
      resolution: effectiveVideoResolution,
      consent,
    });
  }, [
    model,
    prompt,
    negativePrompt,
    effectiveDuration,
    effectiveVideoAspect,
    effectiveVideoResolution,
    openingFrame,
    references,
    referenceClips,
    referenceAudio,
    consent,
  ]);

  useEffect(() => {
    setQuote(undefined);
    const body = queueBody();
    if (!body || !model || !supportsVideoQuote(model.id)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      mediaJson<{ quote?: number }>(VIDEO_QUOTE_PATH, body)
        .then((response) => {
          if (!cancelled && typeof response?.quote === "number") setQuote(response.quote);
        })
        .catch(() => undefined);
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [queueBody, model]);

  const busy =
    job.state.phase === "queueing" ||
    job.state.phase === "queued" ||
    job.state.phase === "processing";

  /** Whether everything together still fits in one request. Each input can be
   * fine on its own and the body still be over the cap, and the backend only
   * says so with a 413 once the render has been queued - so it is measured on
   * the finished body, before the button is offered. */
  const oversize = useMemo(() => {
    const body = queueBody();
    return body ? requestSizeProblem(inlineMediaInputs(body)) : undefined;
  }, [queueBody]);

  const start = useCallback(() => {
    const body = queueBody();
    if (!body || !model) return;
    void job.start({
      kind: "video",
      model: model.id,
      prompt: prompt.trim(),
      extension: "mp4",
      queuePath: VIDEO_QUEUE_PATH,
      queueBody: body,
      retrieve: (queueId) => ({
        path: VIDEO_RETRIEVE_PATH,
        body: retrieveBody(queueId, model.id),
      }),
      urlFields: VIDEO_URL_FIELDS,
      parentArtifactId: handoffFrom?.artifactId,
      parentHandoffSeconds: handoffFrom?.timeSeconds,
    });
  }, [queueBody, model, prompt, job, handoffFrom]);

  return (
    <div className="mobile-studio-form">
      <ModelPickerButton
        label="Video model"
        value={family?.name ?? ""}
        hint={variantHint(family, model)}
        onOpen={() => setPickerOpen(true)}
      />
      {durationOptions.length > 0 ? (
        <div className="mobile-pill-row" role="radiogroup" aria-label="Duration">
          {durationOptions.map((option) => (
            <button
              key={option}
              type="button"
              className="mobile-pill"
              data-active={effectiveDuration === option ? "true" : undefined}
              onClick={() => setDuration(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {videoAspectOptions.length > 0 ? (
        <div className="mobile-pill-row" role="radiogroup" aria-label="Aspect ratio">
          {videoAspectOptions.map((option) => (
            <button
              key={option}
              type="button"
              className="mobile-pill"
              data-active={effectiveVideoAspect === option ? "true" : undefined}
              onClick={() => setAspectRatio(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {videoResolutionOptions.length > 0 ? (
        <div className="mobile-pill-row" role="radiogroup" aria-label="Resolution">
          {videoResolutionOptions.map((option) => (
            <button
              key={option}
              type="button"
              className="mobile-pill"
              data-active={effectiveVideoResolution === option ? "true" : undefined}
              onClick={() => setResolution(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {family?.imageModel || family?.referenceModel ? (
        <ReferencePicker
          references={openingFrame}
          onChange={(refs) => {
            setHandoffFrom(undefined);
            setOpeningFrame(refs.slice(0, 1));
          }}
          galleryImages={galleryImages}
          hint={
            handoffFrom
              ? `Continuing ${handoffFrom.fileName} at ${Math.round(handoffFrom.timeSeconds * 10) / 10}s of ${Math.round(handoffFrom.durationSeconds * 10) / 10}s.`
              : "Optional opening frame: the clip starts from this photo."
          }
        />
      ) : null}
      {family?.referenceModel ? (
        <ReferencePicker
          references={references}
          onChange={(refs) => void applyReferences(refs)}
          galleryImages={galleryImages}
          error={referenceError}
          hint={
            references.length > 0
              ? // Seedance routes its workflow from the prompt and only reads
                // its own mention syntax, so naming them is part of the input.
                isSeedanceModel(family.referenceModel.id)
                ? `These photos steer style and subject. Name them in the prompt as ${references
                    .map((_, index) => referenceMention(family.referenceModel, "image", index + 1))
                    .join(", ")}.`
                : "These photos steer the style and subject, alongside the opening frame."
              : "Optional reference photos: they steer style and subject while the prompt drives the action."
          }
        />
      ) : null}
      {clipsAllowed ? (
        <MediaReferencePicker
          kind="video"
          items={referenceClips}
          cap={maxReferenceVideos(family?.referenceModel)}
          gallery={galleryClips}
          error={clipError}
          onAdd={addClip}
          onReject={setClipError}
          onRemove={removeClip}
          mentionOf={(index) => referenceMention(family?.referenceModel, "video", index)}
          hint={
            referenceClips.length > 0
              ? "Name them in the prompt in this order, and start it with what you want done."
              : "Optional clips to edit, extend or stitch. They travel with the request, so keep them short."
          }
        />
      ) : null}
      {audioAllowed ? (
        <MediaReferencePicker
          kind="audio"
          items={referenceAudio}
          cap={maxReferenceAudio(family?.referenceModel)}
          gallery={galleryTracks}
          error={audioError}
          onAdd={addTrack}
          onReject={setAudioError}
          onRemove={removeTrack}
          mentionOf={(index) => referenceMention(family?.referenceModel, "audio", index)}
          hint={
            referenceAudio.length > 0
              ? "A track never travels alone, so keep a photo or a clip in play."
              : "Optional audio for the render to follow, alongside a photo or a clip."
          }
        />
      ) : null}
      <textarea
        className="mobile-studio-prompt"
        value={prompt}
        rows={3}
        placeholder={
          openingFrame.length > 0
            ? "Describe the motion"
            : references.length > 0
              ? "Describe the scene to build from the reference"
              : "Describe the video to generate"
        }
        onChange={(event) => setPrompt(event.target.value)}
      />
      {/* Seedance routes from the prompt's opening words, and a wrong opening
          does not fail: it runs another workflow and bills for it. So the
          openings are buttons that write themselves, and only the ones this
          model can honour are offered. */}
      {workflows.length > 0 ? (
        <div className="mobile-reference-actions">
          {workflows.map((recipe) => (
            <button
              key={recipe.id}
              type="button"
              className="mobile-chip-button"
              title={recipe.description}
              onClick={() =>
                setPrompt((current) =>
                  current.startsWith(recipe.prefix) ? current : recipe.prefix,
                )
              }
            >
              {recipe.label}
            </button>
          ))}
        </div>
      ) : null}
      {promptAdvice ? <p className="mobile-workflow-param-hint">{promptAdvice}</p> : null}
      <textarea
        className="mobile-studio-prompt"
        value={negativePrompt}
        rows={2}
        placeholder="Negative prompt (optional)"
        aria-label="Negative prompt"
        onChange={(event) => setNegativePrompt(event.target.value)}
      />
      {needsConsent ? (
        <div className="mobile-toggle-row mobile-studio-consent">
          <Switch
            checked={consent}
            aria-label="I have the right to use this media"
            onCheckedChange={(next) => {
              setConsent(next);
              rememberSeedanceConsent(next);
            }}
          />
          <span>
            I have the right to use this media and accept this model's face-media policy for anyone
            shown in it.
            {personMediaCaveat ? (
              <span className="mobile-workflow-param-hint">{personMediaCaveat}</span>
            ) : null}
          </span>
        </div>
      ) : null}
      {oversize ? <p className="mobile-dictation-error">{oversize}</p> : null}
      <button
        type="button"
        className="mobile-studio-generate"
        disabled={
          !model || !prompt.trim() || (needsConsent && !consent) || busy || Boolean(oversize)
        }
        onClick={start}
      >
        {busy ? <Spinner /> : "Generate"}
        {!busy && quote !== undefined ? (
          <span className="mobile-studio-cost">{formatCredits(quote)}</span>
        ) : null}
      </button>
      {references.length > 0 && model && !isReferenceToVideoModel(model.id) ? (
        <p className="mobile-reference-hint">
          {`${family?.name ?? "This model"} cannot take reference photos, so only the opening frame will be used.`}
        </p>
      ) : null}
      {busy ? (
        <p className="mobile-studio-progress" data-shimmer="true">
          Rendering video. You can leave this tab; the job resumes.
        </p>
      ) : null}
      {job.state.phase === "failed" ? (
        <JobFailureNotice
          message={job.state.message}
          status={job.state.status}
          className="mobile-dictation-error"
          retryClassName="mobile-chip-button"
          onRetry={job.canRetry ? job.retry : undefined}
        />
      ) : null}
      {pickerOpen ? (
        <ModelSheet
          title="Video model"
          entries={familiesForMode.map((entry) => ({
            id: entry.key,
            name: entry.name,
            subtitle: [
              entry.textModel ? "text" : undefined,
              entry.imageModel ? "photo" : undefined,
              entry.referenceModel ? "reference" : undefined,
            ]
              .filter(Boolean)
              .join(" · "),
            // One row stands for up to four backend models, so searching what
            // the row shows cannot find a variant by its own name or id.
            keywords: videoFamilySearchTerms(entry),
          }))}
          selectedId={family?.key ?? ""}
          onSelect={(id) => {
            if (id) setFamilyKey(id);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

// --- Music ------------------------------------------------------------------

/** A labelled switch row. Studio used raw `<input type="checkbox">`, which
 * renders as the iOS system checkbox: a blue tick that belongs to no other
 * surface in the app now that Settings uses `Switch`. */
function StudioToggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  hint?: ReactNode;
}) {
  return (
    <div className="mobile-toggle-row">
      <span className="mobile-toggle-label">
        {label}
        {hint ? <span className="mobile-toggle-hint">{hint}</span> : null}
      </span>
      <Switch
        checked={checked}
        onCheckedChange={(next) => {
          hapticSelection();
          onChange(next);
        }}
        aria-label={typeof label === "string" ? label : undefined}
      />
    </div>
  );
}

/** Everything past "describe it and go", folded away by default.
 *
 * The generate form exposed nine controls at once, which pushed the Generate
 * button itself below the fold: the primary action was the one thing you
 * could not see. */
function MoreOptions({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mobile-studio-more" data-open={open ? "true" : undefined}>
      <button
        type="button"
        className="mobile-studio-more-trigger"
        aria-expanded={open}
        onClick={() => {
          hapticSelection();
          setOpen((current) => !current);
        }}
      >
        <span>{open ? "Fewer options" : "More options"}</span>
        <IconChevronDownSmall size={14} aria-hidden />
      </button>
      {open ? <div className="mobile-studio-more-body">{children}</div> : null}
    </div>
  );
}

// --- Audio (music / speech / sound effects) -----------------------------------

function AudioPanel({
  catalog,
  mode,
  onModeChange,
  onGenerated,
}: {
  catalog: MediaCatalog;
  mode: AudioMode;
  onModeChange: (mode: AudioMode) => void;
  onGenerated: () => void;
}) {
  return (
    <div className="mobile-studio-form">
      <div className="mobile-segmented" role="tablist" aria-label="Audio mode">
        {(["music", "speech", "sfx"] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={mode === entry}
            className="mobile-segmented-item"
            data-active={mode === entry ? "true" : undefined}
            onClick={() => onModeChange(entry)}
          >
            {entry === "music" ? "Music" : entry === "speech" ? "Speech" : "Effects"}
          </button>
        ))}
      </div>
      {mode === "music" ? (
        <MusicPanel catalog={catalog} onGenerated={onGenerated} />
      ) : mode === "speech" ? (
        <SpeechPanel catalog={catalog} onGenerated={onGenerated} />
      ) : (
        <SfxPanel catalog={catalog} onGenerated={onGenerated} />
      )}
    </div>
  );
}

function SpeechPanel({ catalog, onGenerated }: { catalog: MediaCatalog; onGenerated: () => void }) {
  const models = useMemo(() => modelsOfType(catalog, "tts"), [catalog]);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((entry) => entry.id === modelId) ?? models[0];
  const voices = model?.voices ?? [];
  const [voice, setVoice] = useState("");
  const effectiveVoice = pickEffective(voices, voice);
  const [text, setText] = useState("");
  const [speed, setSpeed] = useState(SPEECH_SPEED.default);
  const [format, setFormat] = useState<SpeechFormat>("mp3");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => abortRef.current?.abort(), []);

  const generate = useCallback(async () => {
    if (!model || !text.trim() || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      const input = text.trim().slice(0, SPEECH_INPUT_LIMIT);
      const { base64 } = await generateSpeech({
        model: model.id,
        input,
        voice: effectiveVoice || undefined,
        speed,
        format,
        signal: controller.signal,
      });
      await saveArtifactFromBase64(base64, format, {
        kind: "speech",
        model: model.id,
        prompt: input,
      });
      hapticNotify("success");
      onGenerated();
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        hapticNotify("error");
        setError(err instanceof Error ? err.message : "The narration failed.");
      }
    } finally {
      setBusy(false);
    }
  }, [model, text, busy, effectiveVoice, speed, format, onGenerated]);

  return (
    <>
      <ModelPickerButton
        label="Speech model"
        value={model?.name ?? ""}
        onOpen={() => setPickerOpen(true)}
      />
      {voices.length > 0 ? (
        <ModelPickerButton
          label="Voice"
          value={effectiveVoice}
          onOpen={() => setVoicePickerOpen(true)}
        />
      ) : null}
      <textarea
        className="mobile-studio-prompt"
        value={text}
        rows={4}
        maxLength={SPEECH_INPUT_LIMIT}
        placeholder="Text to narrate"
        aria-label="Text to narrate"
        onChange={(event) => setText(event.target.value)}
      />
      <div className="mobile-studio-field">
        <div className="mobile-studio-field-head">
          <span className="mobile-studio-field-label">Speed</span>
          <span className="mobile-studio-field-value">{`x${speed}`}</span>
        </div>
        <input
          type="range"
          className="mobile-studio-slider"
          min={SPEECH_SPEED.min}
          max={SPEECH_SPEED.max}
          step={SPEECH_SPEED.step}
          value={speed}
          aria-label="Speed"
          onChange={(event) => setSpeed(Number(event.target.value))}
        />
      </div>
      <StudioSetting label="Format">
        <div className="mobile-pill-row" role="radiogroup" aria-label="Audio format">
          {SPEECH_FORMATS.map((entry) => (
            <button
              key={entry}
              type="button"
              className="mobile-pill"
              data-active={format === entry ? "true" : undefined}
              onClick={() => setFormat(entry)}
            >
              {entry}
            </button>
          ))}
        </div>
      </StudioSetting>
      <button
        type="button"
        className="mobile-studio-generate"
        disabled={!model || !text.trim() || busy}
        onClick={() => void generate()}
      >
        {busy ? <Spinner /> : "Generate"}
      </button>
      {busy ? (
        <button
          type="button"
          className="mobile-chip-button"
          onClick={() => abortRef.current?.abort()}
        >
          Cancel
        </button>
      ) : null}
      {error ? <p className="mobile-dictation-error">{error}</p> : null}
      {pickerOpen ? (
        <ModelSheet
          title="Speech model"
          entries={models.map((entry) => ({
            id: entry.id,
            name: entry.name,
            subtitle: [entry.tier, entry.privacy].filter(Boolean).join(" · "),
          }))}
          selectedId={model?.id ?? ""}
          onSelect={(id) => {
            if (id) setModelId(id);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
      {voicePickerOpen ? (
        <ModelSheet
          title="Voice"
          entries={voices.map((entry) => ({ id: entry, name: entry, subtitle: "" }))}
          selectedId={effectiveVoice}
          onSelect={(id) => {
            if (id) setVoice(id);
            setVoicePickerOpen(false);
          }}
          onClose={() => setVoicePickerOpen(false)}
        />
      ) : null}
    </>
  );
}

/** Effects are described in a line, not a paragraph. */
const SFX_PROMPT_LIMIT = 250;

function SfxPanel({ catalog, onGenerated }: { catalog: MediaCatalog; onGenerated: () => void }) {
  const models = useMemo(() => soundEffectsModels(catalog), [catalog]);
  const paths = musicPaths(catalog.backend);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((entry) => entry.id === modelId) ?? models[0];
  const caps = musicCapabilities(model?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [autoDuration, setAutoDuration] = useState(true);
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [pickerOpen, setPickerOpen] = useState(false);

  // The file is already in the gallery directory (Rust downloaded it, possibly
  // while the app was closed); indexing it is all that is left.
  const job = useMediaJob("sfx", (artifact, finished) => {
    registerDownloadedArtifact(artifact, {
      kind: "sfx",
      model: finished.model,
      prompt: finished.prompt,
    });
    hapticNotify("success");
    onGenerated();
  });

  const duration = caps.durationSeconds
    ? Math.min(Math.max(durationSeconds, caps.durationSeconds.min), caps.durationSeconds.max)
    : durationSeconds;
  const cost = model
    ? estimateCostCredits(model, {
        durationSeconds: autoDuration ? undefined : duration,
        multiplier: catalog.priceMultiplier,
      })
    : undefined;
  const busy =
    job.state.phase === "queueing" ||
    job.state.phase === "queued" ||
    job.state.phase === "processing";

  const start = useCallback(() => {
    if (!model || !prompt.trim()) return;
    const body: Record<string, unknown> = {
      model: model.id,
      prompt: prompt.trim().slice(0, SFX_PROMPT_LIMIT),
    };
    if (!autoDuration) body.duration_seconds = duration;
    void job.start({
      kind: "sfx",
      model: model.id,
      prompt: prompt.trim(),
      extension: "mp3",
      queuePath: paths.queue,
      queueBody: body,
      retrieve: (queueId) => ({
        path: paths.retrieve,
        body: retrieveBody(queueId, model.id),
      }),
      urlFields: AUDIO_URL_FIELDS,
    });
  }, [model, prompt, autoDuration, duration, job, paths]);

  return (
    <>
      <ModelPickerButton
        label="Effect model"
        value={model?.name ?? ""}
        onOpen={() => setPickerOpen(true)}
      />
      <textarea
        className="mobile-studio-prompt"
        value={prompt}
        rows={2}
        maxLength={SFX_PROMPT_LIMIT}
        placeholder="Describe a short sound (a door creak, rain on glass)"
        onChange={(event) => setPrompt(event.target.value)}
      />
      <StudioToggle label="Auto duration" checked={autoDuration} onChange={setAutoDuration} />
      {!autoDuration && caps.durationSeconds ? (
        <div className="mobile-studio-field">
          <div className="mobile-studio-field-head">
            <span className="mobile-studio-field-label">Duration</span>
            <span className="mobile-studio-field-value">{`${duration}s`}</span>
          </div>
          <input
            type="range"
            className="mobile-studio-slider"
            min={caps.durationSeconds.min}
            max={caps.durationSeconds.max}
            step={caps.durationSeconds.step}
            value={duration}
            aria-label="Duration"
            onChange={(event) => setDurationSeconds(Number(event.target.value))}
          />
        </div>
      ) : null}
      <button
        type="button"
        className="mobile-studio-generate"
        disabled={!model || !prompt.trim() || busy}
        onClick={start}
      >
        {busy ? <Spinner /> : "Generate"}
        {!busy && cost !== undefined ? (
          <span className="mobile-studio-cost">{formatCredits(cost)}</span>
        ) : null}
      </button>
      {busy ? (
        <p className="mobile-studio-progress" data-shimmer="true">
          Rendering. You can leave this tab; the job resumes.
        </p>
      ) : null}
      {job.state.phase === "failed" ? (
        <JobFailureNotice
          message={job.state.message}
          status={job.state.status}
          className="mobile-dictation-error"
          retryClassName="mobile-chip-button"
          onRetry={job.canRetry ? job.retry : undefined}
        />
      ) : null}
      {pickerOpen ? (
        <ModelSheet
          title="Effect model"
          entries={models.map((entry) => ({
            id: entry.id,
            name: entry.name,
            subtitle: [entry.tier, entry.privacy].filter(Boolean).join(" · "),
          }))}
          selectedId={model?.id ?? ""}
          onSelect={(id) => {
            if (id) setModelId(id);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </>
  );
}

function MusicPanel({ catalog, onGenerated }: { catalog: MediaCatalog; onGenerated: () => void }) {
  const models = useMemo(() => musicModels(catalog), [catalog]);
  const paths = musicPaths(catalog.backend);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((entry) => entry.id === modelId) ?? models[0];
  const caps = musicCapabilities(model?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [instrumental, setInstrumental] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // The file is already in the gallery directory (Rust downloaded it, possibly
  // while the app was closed); indexing it is all that is left.
  const job = useMediaJob("music", (artifact, finished) => {
    registerDownloadedArtifact(artifact, {
      kind: "music",
      model: finished.model,
      prompt: finished.prompt,
    });
    hapticNotify("success");
    onGenerated();
  });

  const duration = caps.durationSeconds
    ? Math.min(Math.max(60, caps.durationSeconds.min), caps.durationSeconds.max)
    : undefined;
  const cost = model
    ? estimateCostCredits(model, { durationSeconds: duration, multiplier: catalog.priceMultiplier })
    : undefined;
  const lyricsMissing = caps.lyrics === "required" && !instrumental && !lyrics.trim();
  const busy =
    job.state.phase === "queueing" ||
    job.state.phase === "queued" ||
    job.state.phase === "processing";

  const start = useCallback(() => {
    if (!model || !prompt.trim()) return;
    const body: Record<string, unknown> = { model: model.id, prompt: prompt.trim() };
    if (caps.lyrics !== "none" && !instrumental && lyrics.trim()) {
      body.lyrics_prompt = lyrics.trim();
    }
    if (caps.instrumental && caps.lyrics !== "none" && instrumental) {
      body.force_instrumental = true;
    }
    if (duration !== undefined) body.duration_seconds = duration;
    void job.start({
      kind: "music",
      model: model.id,
      prompt: prompt.trim(),
      extension: "mp3",
      queuePath: paths.queue,
      queueBody: body,
      retrieve: (queueId) => ({
        path: paths.retrieve,
        body: retrieveBody(queueId, model.id),
      }),
      urlFields: AUDIO_URL_FIELDS,
    });
  }, [model, prompt, caps, instrumental, lyrics, duration, job, paths]);

  return (
    <>
      <ModelPickerButton
        label="Music model"
        value={model?.name ?? ""}
        onOpen={() => setPickerOpen(true)}
      />
      <textarea
        className="mobile-studio-prompt"
        value={prompt}
        rows={2}
        placeholder="Describe the track (style, mood, tempo)"
        onChange={(event) => setPrompt(event.target.value)}
      />
      {caps.lyrics !== "none" ? (
        <>
          {caps.instrumental ? (
            <StudioToggle
              label="Instrumental (no vocals)"
              checked={instrumental}
              onChange={setInstrumental}
            />
          ) : null}
          {!instrumental ? (
            <textarea
              className="mobile-studio-prompt"
              value={lyrics}
              rows={3}
              placeholder={caps.lyrics === "required" ? "Lyrics (required)" : "Lyrics (optional)"}
              onChange={(event) => setLyrics(event.target.value)}
            />
          ) : null}
        </>
      ) : null}
      <button
        type="button"
        className="mobile-studio-generate"
        disabled={!model || !prompt.trim() || lyricsMissing || busy}
        onClick={start}
      >
        {busy ? <Spinner /> : "Generate"}
        {!busy && cost !== undefined ? (
          <span className="mobile-studio-cost">{formatCredits(cost)}</span>
        ) : null}
      </button>
      {busy ? (
        <p className="mobile-studio-progress" data-shimmer="true">
          Composing. You can leave this tab; the job resumes.
        </p>
      ) : null}
      {job.state.phase === "failed" ? (
        <JobFailureNotice
          message={job.state.message}
          status={job.state.status}
          className="mobile-dictation-error"
          retryClassName="mobile-chip-button"
          onRetry={job.canRetry ? job.retry : undefined}
        />
      ) : null}
      {pickerOpen ? (
        <ModelSheet
          title="Music model"
          entries={models.map((entry) => ({
            id: entry.id,
            name: entry.name,
            subtitle: [entry.tier, entry.privacy].filter(Boolean).join(" · "),
          }))}
          selectedId={model?.id ?? ""}
          onSelect={(id) => {
            if (id) setModelId(id);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </>
  );
}

// --- Gallery + lightbox -------------------------------------------------------

/**
 * Everything ever generated, in one place.
 *
 * The per-kind galleries hang under their own generate form, so answering
 * "what have I made?" meant visiting four tabs and scrolling past four forms.
 * This is the library that question deserves: every kind together, newest
 * first, grouped by day, filterable by kind and searchable by prompt.
 */
function Library({
  items,
  onOpen,
  onChanged,
}: {
  items: StudioArtifact[];
  onOpen: (artifact: StudioArtifact) => void;
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ArtifactKind | "all">("all");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);

  const exitSelection = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);

  const toggle = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // A library you cannot prune is an archive. Deleting frees real disk on the
  // phone, so it belongs here and not only under each kind's own tab.
  const deleteSelected = useCallback(async () => {
    if (selected.size === 0) return;
    setDeleting(true);
    for (const artifact of items.filter((entry) => selected.has(entry.path))) {
      try {
        await deleteArtifact(artifact);
        evictArtifactDataUrl(artifact.path);
      } catch {
        // Leave failures in place; the next listing reconciles with disk.
      }
    }
    setDeleting(false);
    hapticNotify("success");
    exitSelection();
    onChanged();
  }, [items, selected, exitSelection, onChanged]);

  // Only offer filters for kinds actually present: a chip row of empty
  // categories is noise on a phone.
  const kinds = useMemo(() => {
    const present = new Set(items.map((artifact) => artifact.kind));
    return (["image", "video", "music", "speech", "sfx"] as const).filter((kind) =>
      present.has(kind),
    );
  }, [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((artifact) => {
      if (filter !== "all" && artifact.kind !== filter) return false;
      if (!q) return true;
      return (
        (artifact.prompt ?? "").toLowerCase().includes(q) ||
        (artifact.model ?? "").toLowerCase().includes(q)
      );
    });
  }, [items, filter, query]);

  // Day buckets, in order. A flat wall of two hundred tiles gives the eye
  // nothing to hold on to.
  const groups = useMemo(() => {
    const buckets = new Map<string, StudioArtifact[]>();
    for (const artifact of filtered) {
      const label = dayLabel(artifact.createdAt);
      const bucket = buckets.get(label);
      if (bucket) bucket.push(artifact);
      else buckets.set(label, [artifact]);
    }
    return [...buckets.entries()];
  }, [filtered]);

  if (items.length === 0) {
    return (
      <EmptyState
        title="Nothing generated yet"
        description="Images, videos and audio you make in Studio collect here, on this device."
      />
    );
  }

  return (
    <div className="mobile-studio-gallery">
      <div className="mobile-studio-gallery-bar">
        <input
          className="mobile-studio-search"
          type="search"
          value={query}
          placeholder="Search everything"
          aria-label="Search the library"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="mobile-chip-button"
          onClick={() => (selecting ? exitSelection() : setSelecting(true))}
        >
          {selecting ? "Done" : "Select"}
        </button>
      </div>
      {kinds.length > 1 ? (
        <div className="mobile-pill-row" role="radiogroup" aria-label="Filter by kind">
          {(["all", ...kinds] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              role="radio"
              aria-checked={filter === entry}
              className="mobile-pill"
              data-active={filter === entry ? "true" : undefined}
              onClick={() => {
                hapticSelection();
                setFilter(entry);
              }}
            >
              {entry === "all" ? "All" : KIND_LABELS[entry]}
            </button>
          ))}
        </div>
      ) : null}
      {filtered.length === 0 ? (
        <p className="mobile-studio-empty-hint">Nothing matches that search.</p>
      ) : (
        groups.map(([label, group]) => (
          <section key={label} className="mobile-library-day">
            <h3 className="mobile-library-day-title">{label}</h3>
            <div className="mobile-studio-grid mobile-library-grid">
              {group.map((artifact) =>
                artifact.kind === "image" || artifact.kind === "video" ? (
                  <LibraryCell
                    key={artifact.path}
                    artifact={artifact}
                    selecting={selecting}
                    selected={selected.has(artifact.path)}
                    onOpen={() => (selecting ? toggle(artifact.path) : onOpen(artifact))}
                  />
                ) : (
                  <AudioTile
                    key={artifact.path}
                    artifact={artifact}
                    selected={selecting && selected.has(artifact.path)}
                    onOpen={() => (selecting ? toggle(artifact.path) : onOpen(artifact))}
                  />
                ),
              )}
            </div>
          </section>
        ))
      )}
      <p className="mobile-studio-empty-hint">
        {items.length} {items.length === 1 ? "item" : "items"} on this device.
      </p>
      {selecting ? (
        <div className="mobile-studio-select-bar">
          <span>{selected.size} selected</span>
          <button
            type="button"
            className="mobile-studio-delete-selected"
            disabled={selected.size === 0 || deleting}
            onClick={() => void deleteSelected()}
          >
            {deleting ? <Spinner /> : `Delete${selected.size ? ` (${selected.size})` : ""}`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

const KIND_LABELS: Record<ArtifactKind, string> = {
  image: "Images",
  video: "Videos",
  music: "Music",
  speech: "Speech",
  sfx: "Effects",
};

/** Audio has no thumbnail, so its tile is a label rather than a black square. */
function AudioTile({
  artifact,
  onOpen,
  selected,
}: {
  artifact: StudioArtifact;
  onOpen: () => void;
  selected?: boolean;
}) {
  return (
    <button
      type="button"
      className="mobile-studio-cell mobile-studio-cell-audio"
      data-selected={selected ? "true" : undefined}
      onClick={onOpen}
    >
      <IconAudio size={20} aria-hidden />
      <span>{artifact.prompt?.slice(0, 48) || KIND_LABELS[artifact.kind]}</span>
    </button>
  );
}

/** "Today", "Yesterday", then a written date. */
function dayLabel(createdAt: number): string {
  const date = new Date(createdAt);
  const today = new Date();
  const startOf = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(date)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: days < 7 ? "long" : undefined,
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function Gallery({
  items,
  kind,
  onOpen,
  onChanged,
}: {
  items: StudioArtifact[];
  kind: ArtifactKind;
  onOpen: (artifact: StudioArtifact) => void;
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (artifact) =>
        (artifact.prompt ?? "").toLowerCase().includes(q) ||
        (artifact.model ?? "").toLowerCase().includes(q),
    );
  }, [items, query]);

  const toggle = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const exitSelection = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);

  const deleteSelected = useCallback(async () => {
    if (selected.size === 0) return;
    setDeleting(true);
    const targets = items.filter((artifact) => selected.has(artifact.path));
    for (const artifact of targets) {
      try {
        await deleteArtifact(artifact);
        evictArtifactDataUrl(artifact.path);
      } catch {
        // Leave failures in place; the next refresh reconciles with disk.
      }
    }
    setDeleting(false);
    hapticNotify("success");
    exitSelection();
    onChanged();
  }, [items, selected, exitSelection, onChanged]);

  const isAudioKind = kind === "music" || kind === "speech" || kind === "sfx";

  if (items.length === 0) {
    return (
      <EmptyState
        title={
          kind === "image"
            ? "No images yet"
            : kind === "video"
              ? "No videos yet"
              : kind === "speech"
                ? "No narrations yet"
                : kind === "sfx"
                  ? "No sound effects yet"
                  : "No tracks yet"
        }
        description="Everything you generate stays on this device."
      />
    );
  }

  return (
    <div className="mobile-studio-gallery">
      <div className="mobile-studio-gallery-bar">
        <input
          className="mobile-studio-search"
          type="search"
          value={query}
          placeholder={
            isAudioKind ? "Search audio" : kind === "video" ? "Search videos" : "Search images"
          }
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="mobile-chip-button"
          onClick={() => (selecting ? exitSelection() : setSelecting(true))}
        >
          {selecting ? "Done" : "Select"}
        </button>
      </div>
      {filtered.length === 0 ? (
        <p className="mobile-studio-empty-hint">No results for “{query.trim()}”.</p>
      ) : isAudioKind ? (
        <ul className="mobile-note-list" aria-label="Generated audio">
          {filtered.map((artifact) => (
            <MusicRow
              key={artifact.path}
              artifact={artifact}
              selecting={selecting}
              selected={selected.has(artifact.path)}
              onToggle={() => toggle(artifact.path)}
            />
          ))}
        </ul>
      ) : (
        <div className="mobile-studio-grid">
          {filtered.map((artifact) => (
            <GalleryCell
              key={artifact.path}
              artifact={artifact}
              selecting={selecting}
              selected={selected.has(artifact.path)}
              onOpen={() => (selecting ? toggle(artifact.path) : onOpen(artifact))}
            />
          ))}
        </div>
      )}
      {selecting ? (
        <div className="mobile-studio-select-bar">
          <span>{selected.size} selected</span>
          <button
            type="button"
            className="mobile-studio-delete-selected"
            disabled={selected.size === 0 || deleting}
            onClick={() => void deleteSelected()}
          >
            {deleting ? <Spinner /> : `Delete${selected.size ? ` (${selected.size})` : ""}`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A library tile: the picture, plus what made it.
 *
 * The per-kind strips are three columns of bare thumbnails, which is right for
 * glancing at what you just generated. The library is where you go to *find*
 * something, so it trades a column for a caption: without one, a grid of
 * images carries no prompt, no model, and no way to tell a video from a still.
 */
function LibraryCell({
  artifact,
  onOpen,
  selecting = false,
  selected = false,
}: {
  artifact: StudioArtifact;
  onOpen: () => void;
  selecting?: boolean;
  selected?: boolean;
}) {
  const src = useArtifactThumbnail(artifact);
  const [duration, setDuration] = useState<string | null>(null);
  const isVideo = artifact.kind === "video";

  return (
    <div className="mobile-library-item">
      <button
        type="button"
        className="mobile-studio-cell"
        data-selected={selected ? "true" : undefined}
        onClick={onOpen}
      >
        {src ? (
          isVideo ? (
            // `#t=0.1` nudges WKWebView to decode and paint the first frame as
            // a poster; without it the tile stays black until played.
            <video
              src={`${src}#t=0.1`}
              muted
              playsInline
              preload="metadata"
              onLoadedMetadata={(event) => {
                const seconds = event.currentTarget.duration;
                if (Number.isFinite(seconds) && seconds > 0) {
                  setDuration(formatClipLength(seconds));
                }
              }}
            />
          ) : (
            <img src={src} alt={artifact.prompt || "Generated image"} />
          )
        ) : (
          <span className="mobile-studio-cell-loading" aria-hidden />
        )}
        {isVideo ? (
          <span className="mobile-library-badge" aria-hidden>
            <IconPlay size={11} />
            {duration ?? ""}
          </span>
        ) : null}
        {selecting ? (
          <span
            className="mobile-studio-cell-check"
            data-on={selected ? "true" : undefined}
            aria-hidden
          >
            {selected ? <IconCheckmark1Small size={14} /> : null}
          </span>
        ) : null}
      </button>
      <span className="mobile-library-caption">
        <span className="mobile-library-prompt">
          {artifact.prompt?.trim() || "No prompt recorded"}
        </span>
        <span className="mobile-library-meta">
          {[artifact.model, formatNoteTime(new Date(artifact.createdAt).toISOString())]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
    </div>
  );
}

/** "0:42", "3:07" — the way a player writes it. */
function formatClipLength(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${(whole % 60).toString().padStart(2, "0")}`;
}

function GalleryCell({
  artifact,
  onOpen,
  selecting = false,
  selected = false,
}: {
  artifact: StudioArtifact;
  onOpen: () => void;
  selecting?: boolean;
  selected?: boolean;
}) {
  const src = useArtifactThumbnail(artifact);
  return (
    <button
      type="button"
      className="mobile-studio-cell"
      data-selected={selected ? "true" : undefined}
      onClick={onOpen}
    >
      {src ? (
        artifact.kind === "video" ? (
          // `#t=0.1` nudges WKWebView to decode and paint the first frame as a
          // poster; without it the grid tile stays black until played.
          <video src={`${src}#t=0.1`} muted playsInline preload="metadata" />
        ) : (
          <img src={src} alt={artifact.prompt ?? "Generated image"} />
        )
      ) : (
        <span className="mobile-studio-cell-loading" aria-hidden />
      )}
      {selecting ? (
        <span
          className="mobile-studio-cell-check"
          data-on={selected ? "true" : undefined}
          aria-hidden
        >
          {selected ? <IconCheckmark1Small size={14} /> : null}
        </span>
      ) : null}
    </button>
  );
}

function MusicRow({
  artifact,
  selecting,
  selected,
  onToggle,
}: {
  artifact: StudioArtifact;
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const src = useArtifactDataUrl(artifact);
  return (
    <li className="mobile-music-row" data-selected={selected ? "true" : undefined}>
      {selecting ? (
        <button
          type="button"
          className="mobile-studio-row-check"
          data-on={selected ? "true" : undefined}
          onClick={onToggle}
          aria-label={selected ? "Deselect track" : "Select track"}
        >
          {selected ? <IconCheckmark1Small size={14} /> : null}
        </button>
      ) : null}
      <span className="mobile-note-row-title">{artifact.prompt?.slice(0, 60) || "Track"}</span>
      {src ? (
        <audio
          src={src}
          controls
          preload="metadata"
          onPlay={() => markMediaPlayback(true)}
          onPause={() => markMediaPlayback(false)}
          onEnded={() => markMediaPlayback(false)}
        />
      ) : (
        <Spinner />
      )}
    </li>
  );
}

function Lightbox({
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

  return (
    <div className="mobile-studio-preview" role="dialog" aria-label="Media preview">
      <button
        type="button"
        className="mobile-studio-preview-scrim"
        aria-label="Close"
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
              aria-label="Copy prompt"
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
              Use as reference
            </button>
          ) : null}
          {onContinueShot ? (
            <button type="button" className="mobile-chip-button" onClick={onContinueShot}>
              Continue this shot
            </button>
          ) : null}
          <button
            type="button"
            className="mobile-chip-button"
            data-tone="destructive"
            onClick={onDelete}
          >
            Delete
          </button>
          <button type="button" className="mobile-chip-button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Reference picker ---------------------------------------------------------

/** Multi-reference input: photos from the native picker (the hidden file
 * input opens Photos/camera/Files with no plugin) or images from the app's
 * own gallery. Thumbnails render as removable chips. */
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
function MediaReferencePicker({
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
              From gallery
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
            <h2 className="mobile-sheet-title">From your gallery</h2>
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

function ReferencePicker({
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
          Add a photo
        </button>
        {isMobilePlatform() ? (
          <button
            type="button"
            className="mobile-chip-button"
            onClick={() => cameraRef.current?.click()}
          >
            Take a photo
          </button>
        ) : null}
        {galleryImages.length > 0 ? (
          <button type="button" className="mobile-chip-button" onClick={() => setGalleryOpen(true)}>
            From gallery
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
            aria-label="Pick a gallery image"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="mobile-sheet-title">From your gallery</h2>
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
