import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  saveArtifactFromUrl,
} from "../../../lib/studio/artifacts";
import {
  estimateCostCredits,
  fetchMediaCatalog,
  formatCredits,
  imageEditModels,
  modelsOfType,
  musicCapabilities,
  videoFamilies,
} from "../../../lib/studio/catalog";
import { mediaJson } from "../../../lib/studio/client";
import { composeImages, MAX_COMPOSE_IMAGES, upscaleImage } from "../../../lib/studio/edit-image";
import { prepareEditReference } from "../../../lib/studio/downscale";
import { generateImages } from "../../../lib/studio/generate-image";
import { type PersistedJob, pendingJobs, useMediaJob } from "../../../lib/studio/async-job";
import {
  VIDEO_QUEUE_PATH,
  VIDEO_QUOTE_PATH,
  VIDEO_RETRIEVE_PATH,
  musicPaths,
  retrieveBody,
  supportsVideoQuote,
} from "../../../lib/studio/paths";
import type { ArtifactKind, MediaCatalog, StudioArtifact } from "../../../lib/studio/types";
import { saveToPhotos } from "../../../lib/tauri";
import { EmptyState } from "../../ui/EmptyState";
import { Spinner } from "../../ui/Spinner";
import { ModelSheet } from "../ModelSheet";
import { StackHeader } from "../StackHeader";
import { FlowsPanel } from "./FlowsPanel";

type StudioMode = "image" | "video" | "music" | "flows";
type ImageMode = "generate" | "edit" | "upscale";

function videoUrlFrom(response: Record<string, unknown>): string | undefined {
  const url = response.video_url ?? response.url;
  return typeof url === "string" && url.trim() ? url : undefined;
}

function audioUrlFrom(response: Record<string, unknown>): string | undefined {
  const url = response.audio_url ?? response.url;
  return typeof url === "string" && url.trim() ? url : undefined;
}

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
        : mode === "music"
          ? "music"
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
        {(["image", "video", "music", "flows"] as const).map((entry) => (
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
                : entry === "music"
                  ? "Music"
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
            ) : mode === "music" ? (
              <MusicPanel catalog={catalog} onGenerated={refreshGallery} />
            ) : (
              <FlowsPanel onGenerated={refreshGallery} />
            )}
            {galleryKind ? (
              <Gallery items={galleryItems} kind={galleryKind} onOpen={setPreview} />
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
  const models = mode === "edit" ? editModels : generateModels;
  const [generateModelId, setGenerateModelId] = useState(generateModels[0]?.id ?? "");
  const [editModelId, setEditModelId] = useState(editModels[0]?.id ?? "");
  const modelId = mode === "edit" ? editModelId : generateModelId;
  const model = models.find((entry) => entry.id === modelId) ?? models[0];
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Upscale keeps its own single-image source and factor, separate from the
  // shared edit references.
  const [upscaleRefs, setUpscaleRefs] = useState<string[]>([]);
  const [scale, setScale] = useState<2 | 3 | 4>(2);
  const cost = model
    ? estimateCostCredits(model, { multiplier: catalog.priceMultiplier })
    : undefined;

  const generate = useCallback(async () => {
    if (!model || !prompt.trim() || busy) return;
    if (mode === "edit" && references.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      let images: string[];
      if (mode === "edit") {
        // One reference edits that photo; two or three compose them into a
        // single image (Carpe Diem's multi-edit). The picker is capped to
        // MAX_COMPOSE_IMAGES, so every reference here is sent.
        images = [await composeImages(model.id, prompt.trim(), references)];
      } else {
        images = await generateImages(model.id, {
          model: model.id,
          prompt: prompt.trim(),
          variants: 1,
          format: "png",
          hide_watermark: true,
          safe_mode: false,
        });
      }
      if (images.length === 0) throw new Error("The backend returned no image.");
      for (const base64 of images) {
        await saveArtifactFromBase64(base64, "png", {
          kind: "image",
          model: model.id,
          prompt: prompt.trim(),
        });
      }
      hapticNotify("success");
      onGenerated();
    } catch (err) {
      hapticNotify("error");
      setError(err instanceof Error ? err.message : "The generation failed.");
    } finally {
      setBusy(false);
    }
  }, [model, prompt, busy, mode, references, onGenerated]);

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

  return (
    <div className="mobile-studio-form">
      <div className="mobile-segmented" role="tablist" aria-label="Image mode">
        {(["generate", "edit", "upscale"] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={mode === entry}
            className="mobile-segmented-item"
            data-active={mode === entry ? "true" : undefined}
            onClick={() => onModeChange(entry)}
          >
            {entry === "generate" ? "Generate" : entry === "edit" ? "Edit" : "Upscale"}
          </button>
        ))}
      </div>

      {mode === "upscale" ? (
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
            value={model?.id ?? ""}
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
            subtitle: entry.tier,
          }))}
          selectedId={model?.id ?? ""}
          onSelect={(id) => {
            if (id) {
              if (mode === "edit") setEditModelId(id);
              else setGenerateModelId(id);
            }
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
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
  const [duration, setDuration] = useState("");
  const [quote, setQuote] = useState<number | undefined>(undefined);
  const [resumable, setResumable] = useState<PersistedJob[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const job = useMediaJob<string>(async (url, finished) => {
    await saveArtifactFromUrl(url, "mp4", {
      kind: "video",
      model: finished.model,
      prompt: finished.prompt,
    });
    hapticNotify("success");
    onGenerated();
  });

  useEffect(() => {
    setResumable(pendingJobs("video"));
  }, []);

  const durationOptions = constraints?.durations ?? [];
  const effectiveDuration = duration || durationOptions[0] || "";
  const referenceReady = !needsReference || references.length > 0;

  const queueBody = useCallback((): Record<string, unknown> | undefined => {
    if (!model || !prompt.trim()) return undefined;
    if (needsReference && references.length === 0) return undefined;
    const body: Record<string, unknown> = { model: model.id, prompt: prompt.trim() };
    if (effectiveDuration) body.duration = effectiveDuration;
    // image-to-video takes one opening frame; reference-to-video takes the set
    // of style/subject references.
    if (effectiveMode === "image") body.image_url = references[0];
    else if (effectiveMode === "reference") body.image_urls = references;
    return body;
  }, [model, prompt, effectiveDuration, references, needsReference, effectiveMode]);

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
      getResult: videoUrlFrom,
    });
  }, [queueBody, model, prompt, job]);

  const resume = useCallback(
    (pending: PersistedJob) => {
      setResumable((jobs) => jobs.filter((entry) => entry.id !== pending.id));
      void job.resume(pending, videoUrlFrom);
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
          onChange={setReferences}
          galleryImages={galleryImages}
          hint={
            effectiveMode === "image"
              ? "The clip animates from this photo (its opening frame)."
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

function MusicPanel({ catalog, onGenerated }: { catalog: MediaCatalog; onGenerated: () => void }) {
  const models = useMemo(() => modelsOfType(catalog, "music"), [catalog]);
  const paths = musicPaths(catalog.backend);
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((entry) => entry.id === modelId) ?? models[0];
  const caps = musicCapabilities(model?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [instrumental, setInstrumental] = useState(false);
  const [resumable, setResumable] = useState<PersistedJob[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const job = useMediaJob<string>(async (url, finished) => {
    await saveArtifactFromUrl(url, "mp3", {
      kind: "music",
      model: finished.model,
      prompt: finished.prompt,
    });
    hapticNotify("success");
    onGenerated();
  });

  useEffect(() => {
    setResumable(pendingJobs("music"));
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
      getResult: audioUrlFrom,
    });
  }, [model, prompt, caps, instrumental, lyrics, duration, job, paths]);

  const resume = useCallback(
    (pending: PersistedJob) => {
      setResumable((jobs) => jobs.filter((entry) => entry.id !== pending.id));
      void job.resume(pending, audioUrlFrom);
    },
    [job],
  );

  return (
    <div className="mobile-studio-form">
      <ModelPickerButton
        label="Music model"
        value={model?.id ?? ""}
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
            subtitle: entry.tier,
          }))}
          selectedId={model?.id ?? ""}
          onSelect={(id) => {
            if (id) setModelId(id);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

// --- Gallery + lightbox -------------------------------------------------------

function Gallery({
  items,
  kind,
  onOpen,
}: {
  items: StudioArtifact[];
  kind: ArtifactKind;
  onOpen: (artifact: StudioArtifact) => void;
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        title={
          kind === "image" ? "No images yet" : kind === "video" ? "No videos yet" : "No tracks yet"
        }
        description="Everything you generate stays on this device."
      />
    );
  }
  if (kind === "music") {
    return (
      <ul className="mobile-note-list" aria-label="Generated tracks">
        {items.map((artifact) => (
          <MusicRow key={artifact.path} artifact={artifact} />
        ))}
      </ul>
    );
  }
  return (
    <div className="mobile-studio-grid">
      {items.map((artifact) => (
        <GalleryCell key={artifact.path} artifact={artifact} onOpen={() => onOpen(artifact)} />
      ))}
    </div>
  );
}

function GalleryCell({ artifact, onOpen }: { artifact: StudioArtifact; onOpen: () => void }) {
  const src = useArtifactThumbnail(artifact);
  return (
    <button type="button" className="mobile-studio-cell" onClick={onOpen}>
      {src ? (
        artifact.kind === "video" ? (
          <video src={src} muted playsInline preload="metadata" />
        ) : (
          <img src={src} alt={artifact.prompt ?? "Generated image"} />
        )
      ) : (
        <span className="mobile-studio-cell-loading" aria-hidden />
      )}
    </button>
  );
}

function MusicRow({ artifact }: { artifact: StudioArtifact }) {
  const src = useArtifactDataUrl(artifact);
  return (
    <li className="mobile-music-row">
      <span className="mobile-note-row-title">{artifact.prompt?.slice(0, 60) || "Track"}</span>
      {src ? <audio src={src} controls preload="metadata" /> : <Spinner />}
    </li>
  );
}

function Lightbox({
  artifact,
  onClose,
  onDelete,
  onUseAsReference,
  onUpscaled,
}: {
  artifact: StudioArtifact;
  onClose: () => void;
  onDelete: () => void;
  onUseAsReference?: () => void;
  onUpscaled: () => void;
}) {
  const src = useArtifactDataUrl(artifact);
  const [saved, setSaved] = useState(false);
  const [upscaling, setUpscaling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSaveToPhotos =
    isMobilePlatform() && (artifact.kind === "image" || artifact.kind === "video");

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
      setUpscaling(true);
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
        setUpscaling(false);
      }
    },
    [artifact, upscaling, onUpscaled, onClose],
  );

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
            <video src={src} controls autoPlay playsInline />
          ) : (
            <img src={src} alt={artifact.prompt ?? "Generated image"} />
          )
        ) : (
          <Spinner />
        )}
        {artifact.prompt ? <p className="mobile-studio-preview-prompt">{artifact.prompt}</p> : null}
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
                disabled={upscaling}
                onClick={() => void upscale(2)}
              >
                {upscaling ? <Spinner /> : "Upscale x2"}
              </button>
              <button
                type="button"
                className="mobile-chip-button"
                disabled={upscaling}
                onClick={() => void upscale(4)}
              >
                Upscale x4
              </button>
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
  const [galleryOpen, setGalleryOpen] = useState(false);

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
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          const reader = new FileReader();
          reader.onload = async () => {
            if (typeof reader.result !== "string") return;
            const dataUrl = prepare ? await prepare(reader.result) : reader.result;
            onChange([...references, dataUrl]);
          };
          reader.readAsDataURL(file);
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
