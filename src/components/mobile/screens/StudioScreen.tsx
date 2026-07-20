import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconClipboard } from "central-icons/IconClipboard";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  artifactDataUrl,
  evictArtifactDataUrl,
  useArtifactDataUrl,
  useArtifactThumbnail,
} from "../../../lib/artifact-media";
import { useCarpeDiemCredits } from "../../../lib/carpe-diem-credits";
import { hapticNotify } from "../../../lib/haptics";
import { isMobilePlatform } from "../../../lib/mobile";
import {
  deleteArtifact,
  listArtifacts,
  readArtifactBase64,
  saveArtifactFromBase64,
  saveArtifactFromResult,
} from "../../../lib/studio/artifacts";
import {
  defaultEditModel,
  estimateCostCredits,
  fetchMediaCatalog,
  formatCredits,
  imageEditModels,
  modelsOfType,
  musicCapabilities,
  musicModels,
  soundEffectsModels,
  supportsBackgroundRemoval,
  videoFamilies,
} from "../../../lib/studio/catalog";
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
import { prepareEditReference } from "../../../lib/studio/downscale";
import { compareBodies, generateImages } from "../../../lib/studio/generate-image";
import {
  fileResultFrom,
  type MediaFileResult,
  type PersistedJob,
  pendingJobs,
  useMediaJob,
} from "../../../lib/studio/async-job";
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
import { FlowsPanel } from "./FlowsPanel";

type StudioMode = "image" | "video" | "audio" | "flows";
type ImageMode = "generate" | "edit" | "upscale" | "cutout";
type AudioMode = "music" | "speech" | "sfx";

const videoResultFrom = fileResultFrom("video_url", "url");
// Carpe Diem streams the finished track as the retrieve body (one shot);
// Venice answers JSON with an `audio_url`. Both shapes must be accepted.
const audioResultFrom = fileResultFrom("audio_url", "url");

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
        {(["image", "video", "audio", "flows"] as const).map((entry) => (
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
                  : "Flows"}
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
                onGenerated={refreshGallery}
              />
            ) : mode === "audio" ? (
              <AudioPanel
                catalog={catalog}
                mode={audioMode}
                onModeChange={setAudioMode}
                onGenerated={refreshGallery}
              />
            ) : (
              <FlowsPanel catalog={catalog} onGenerated={refreshGallery} />
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
  onOpen,
}: {
  label: string;
  value: string;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="mobile-model-select" onClick={onOpen} aria-label={label}>
      <span className="mobile-model-select-label">{label}</span>
      <span className="mobile-model-select-value">{value || "Choose"}</span>
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
                  ? `Combining ${references.length} photos into one (up to ${MAX_COMPOSE_IMAGES}).`
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
              <textarea
                className="mobile-studio-prompt"
                value={negativePrompt}
                rows={2}
                placeholder="Negative prompt (optional)"
                aria-label="Negative prompt"
                onChange={(event) => setNegativePrompt(event.target.value)}
              />
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
              <label className="mobile-toggle-row">
                <input
                  type="checkbox"
                  checked={improvePrompt}
                  onChange={(event) => setImprovePrompt(event.target.checked)}
                />
                <span>Improve prompt with AI</span>
              </label>
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
              <label className="mobile-toggle-row">
                <input
                  type="checkbox"
                  checked={hideWatermark}
                  onChange={(event) => setHideWatermark(event.target.checked)}
                />
                <span>Hide watermark</span>
              </label>
              <label className="mobile-toggle-row">
                <input
                  type="checkbox"
                  checked={embedExif}
                  onChange={(event) => setEmbedExif(event.target.checked)}
                />
                <span>Embed prompt in metadata</span>
              </label>
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

/** The three video intents. Text needs no photo; "animate" uses one photo as
 * the opening frame (image-to-video); "reference" uses one or more photos to
 * steer style/subject while the prompt drives the action (reference-to-video). */
type VideoMode = "text" | "image" | "reference";

const VIDEO_MODE_SLOT: Record<VideoMode, "textModel" | "imageModel" | "referenceModel"> = {
  text: "textModel",
  image: "imageModel",
  reference: "referenceModel",
};

function VideoPanel({
  catalog,
  galleryImages,
  onGenerated,
}: {
  catalog: MediaCatalog;
  galleryImages: StudioArtifact[];
  onGenerated: () => void;
}) {
  const families = useMemo(() => videoFamilies(catalog), [catalog]);
  // Only offer a mode when at least one family provides that direction.
  const availableModes = useMemo<VideoMode[]>(
    () =>
      (["text", "image", "reference"] as const).filter((entry) =>
        families.some((family) => family[VIDEO_MODE_SLOT[entry]]),
      ),
    [families],
  );
  const [mode, setMode] = useState<VideoMode>("text");
  const effectiveMode = availableModes.includes(mode) ? mode : (availableModes[0] ?? "text");
  const slot = VIDEO_MODE_SLOT[effectiveMode];
  const familiesForMode = useMemo(
    () => families.filter((family) => family[slot]),
    [families, slot],
  );
  const [familyKey, setFamilyKey] = useState("");
  const family = familiesForMode.find((entry) => entry.key === familyKey) ?? familiesForMode[0];
  const model = family?.[slot];
  const needsReference = effectiveMode !== "text";
  const [references, setReferences] = useState<string[]>([]);
  const constraints = model?.constraints;
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [duration, setDuration] = useState("");
  const [quote, setQuote] = useState<number | undefined>(undefined);
  const [resumable, setResumable] = useState<PersistedJob[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const job = useMediaJob<MediaFileResult>(async (result, finished) => {
    await saveArtifactFromResult(result, "mp4", {
      kind: "video",
      model: finished.model,
      prompt: finished.prompt,
    });
    hapticNotify("success");
    onGenerated();
  });

  useEffect(() => {
    const pending = pendingJobs("video");
    if (pending.length === 0) return;
    // Re-attach to the newest already-paid-for job automatically (poll +
    // download its result), and keep any older ones as manual "Resume" chips.
    const [newest, ...rest] = pending;
    setResumable(rest);
    void job.resume(newest, videoResultFrom);
  }, []);

  const durationOptions = constraints?.durations ?? [];
  const effectiveDuration = duration || durationOptions[0] || "";
  const referenceReady = !needsReference || references.length > 0;

  const queueBody = useCallback((): Record<string, unknown> | undefined => {
    if (!model || !prompt.trim()) return undefined;
    if (needsReference && references.length === 0) return undefined;
    const body: Record<string, unknown> = { model: model.id, prompt: prompt.trim() };
    if (negativePrompt.trim()) body.negative_prompt = negativePrompt.trim();
    if (effectiveDuration) body.duration = effectiveDuration;
    // image-to-video takes one opening frame (a second photo becomes the end
    // frame - that pair also drives the transition models); reference-to-video
    // takes the set of style/subject references.
    if (effectiveMode === "image") {
      body.image_url = references[0];
      if (references[1]) body.end_image_url = references[1];
    } else if (effectiveMode === "reference") {
      body.reference_image_urls = references;
    }
    return body;
  }, [model, prompt, negativePrompt, effectiveDuration, references, needsReference, effectiveMode]);

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
      getResult: videoResultFrom,
    });
  }, [queueBody, model, prompt, job]);

  const resume = useCallback(
    (pending: PersistedJob) => {
      setResumable((jobs) => jobs.filter((entry) => entry.id !== pending.id));
      void job.resume(pending, videoResultFrom);
    },
    [job],
  );

  return (
    <div className="mobile-studio-form">
      {availableModes.length > 1 ? (
        <div className="mobile-segmented" role="tablist" aria-label="Video mode">
          {availableModes.map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={effectiveMode === entry}
              className="mobile-segmented-item"
              data-active={effectiveMode === entry ? "true" : undefined}
              onClick={() => {
                setMode(entry);
                setFamilyKey("");
                if (entry === "text") setReferences([]);
              }}
            >
              {entry === "text" ? "Text" : entry === "image" ? "Animate a photo" : "Reference"}
            </button>
          ))}
        </div>
      ) : null}
      <ModelPickerButton
        label="Video model"
        value={family?.name ?? ""}
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
      {needsReference ? (
        <ReferencePicker
          references={references}
          onChange={(refs) => setReferences(effectiveMode === "image" ? refs.slice(0, 2) : refs)}
          galleryImages={galleryImages}
          hint={
            effectiveMode === "image"
              ? references.length > 1
                ? "First photo opens the clip; the second is its end frame."
                : "The clip animates from this photo. Add a second to set the end frame."
              : references.length > 1
                ? "All these photos steer the style and subject."
                : "This photo steers the style and subject; the prompt drives the action."
          }
        />
      ) : null}
      <textarea
        className="mobile-studio-prompt"
        value={prompt}
        rows={3}
        placeholder={
          effectiveMode === "image"
            ? "Describe the motion"
            : effectiveMode === "reference"
              ? "Describe the scene to build from the reference"
              : "Describe the video to generate"
        }
        onChange={(event) => setPrompt(event.target.value)}
      />
      <textarea
        className="mobile-studio-prompt"
        value={negativePrompt}
        rows={2}
        placeholder="Negative prompt (optional)"
        aria-label="Negative prompt"
        onChange={(event) => setNegativePrompt(event.target.value)}
      />
      <button
        type="button"
        className="mobile-studio-generate"
        disabled={!model || !prompt.trim() || !referenceReady || busy}
        onClick={start}
      >
        {busy ? <Spinner /> : "Generate"}
        {!busy && quote !== undefined ? (
          <span className="mobile-studio-cost">{formatCredits(quote)}</span>
        ) : null}
      </button>
      {needsReference && references.length === 0 ? (
        <p className="mobile-reference-hint">
          {effectiveMode === "image"
            ? "Add a photo to animate."
            : "Add at least one reference photo."}
        </p>
      ) : null}
      {busy ? (
        <p className="mobile-studio-progress" data-shimmer="true">
          Rendering video. You can leave this tab; the job resumes.
        </p>
      ) : null}
      {job.state.phase === "failed" ? (
        <p className="mobile-dictation-error">{job.state.message}</p>
      ) : null}
      {resumable.map((pending) => (
        <button
          key={pending.id}
          type="button"
          className="mobile-chip-button"
          onClick={() => resume(pending)}
        >
          Resume: {pending.prompt.slice(0, 40)}
        </button>
      ))}
      {pickerOpen ? (
        <ModelSheet
          title="Video model"
          entries={familiesForMode.map((entry) => ({
            id: entry.key,
            name: entry.name,
            subtitle:
              effectiveMode === "text"
                ? "text to video"
                : effectiveMode === "image"
                  ? "animate a photo"
                  : "reference to video",
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
  const [resumable, setResumable] = useState<PersistedJob[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const job = useMediaJob<MediaFileResult>(async (result, finished) => {
    await saveArtifactFromResult(result, "mp3", {
      kind: "sfx",
      model: finished.model,
      prompt: finished.prompt,
    });
    hapticNotify("success");
    onGenerated();
  });

  useEffect(() => {
    const pending = pendingJobs("sfx");
    if (pending.length === 0) return;
    const [newest, ...rest] = pending;
    setResumable(rest);
    void job.resume(newest, audioResultFrom);
  }, []);

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
      getResult: audioResultFrom,
    });
  }, [model, prompt, autoDuration, duration, job, paths]);

  const resume = useCallback(
    (pending: PersistedJob) => {
      setResumable((jobs) => jobs.filter((entry) => entry.id !== pending.id));
      void job.resume(pending, audioResultFrom);
    },
    [job],
  );

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
      <label className="mobile-toggle-row">
        <input
          type="checkbox"
          checked={autoDuration}
          onChange={(event) => setAutoDuration(event.target.checked)}
        />
        <span>Auto duration</span>
      </label>
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
        <p className="mobile-dictation-error">{job.state.message}</p>
      ) : null}
      {resumable.map((pending) => (
        <button
          key={pending.id}
          type="button"
          className="mobile-chip-button"
          onClick={() => resume(pending)}
        >
          Resume: {pending.prompt.slice(0, 40)}
        </button>
      ))}
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
  const [resumable, setResumable] = useState<PersistedJob[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const job = useMediaJob<MediaFileResult>(async (result, finished) => {
    await saveArtifactFromResult(result, "mp3", {
      kind: "music",
      model: finished.model,
      prompt: finished.prompt,
    });
    hapticNotify("success");
    onGenerated();
  });

  useEffect(() => {
    const pending = pendingJobs("music");
    if (pending.length === 0) return;
    const [newest, ...rest] = pending;
    setResumable(rest);
    void job.resume(newest, audioResultFrom);
  }, []);

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
      getResult: audioResultFrom,
    });
  }, [model, prompt, caps, instrumental, lyrics, duration, job, paths]);

  const resume = useCallback(
    (pending: PersistedJob) => {
      setResumable((jobs) => jobs.filter((entry) => entry.id !== pending.id));
      void job.resume(pending, audioResultFrom);
    },
    [job],
  );

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
            <label className="mobile-toggle-row">
              <input
                type="checkbox"
                checked={instrumental}
                onChange={(event) => setInstrumental(event.target.checked)}
              />
              <span>Instrumental (no vocals)</span>
            </label>
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
        <p className="mobile-dictation-error">{job.state.message}</p>
      ) : null}
      {resumable.map((pending) => (
        <button
          key={pending.id}
          type="button"
          className="mobile-chip-button"
          onClick={() => resume(pending)}
        >
          Resume: {pending.prompt.slice(0, 40)}
        </button>
      ))}
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
          <video src={src} muted playsInline preload="metadata" />
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
  onUpscaled,
  canRemoveBackground = false,
}: {
  artifact: StudioArtifact;
  onClose: () => void;
  onDelete: () => void;
  onUseAsReference?: () => void;
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
function ReferencePicker({
  references,
  onChange,
  galleryImages,
  hint,
  prepare,
}: {
  references: string[];
  onChange: (refs: string[]) => void;
  galleryImages: StudioArtifact[];
  hint?: string;
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
              <span aria-hidden>x</span>
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
