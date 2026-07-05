import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  artifactDataUrl,
  evictArtifactDataUrl,
  useArtifactDataUrl,
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
  modelsOfType,
  musicCapabilities,
  videoFamilies,
} from "../../../lib/studio/catalog";
import { mediaJson } from "../../../lib/studio/client";
import { editImage, upscaleImage } from "../../../lib/studio/edit-image";
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
  // Lifted so the lightbox's "use as reference" can feed the image panel.
  const [imageRefs, setImageRefs] = useState<string[]>([]);

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
      setImageRefs((current) => [...current, dataUrl]);
      setPreview(null);
      setMode("image");
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

function ImagePanel({
  catalog,
  references,
  onReferencesChange,
  galleryImages,
  onGenerated,
}: {
  catalog: MediaCatalog;
  references: string[];
  onReferencesChange: (refs: string[]) => void;
  galleryImages: StudioArtifact[];
  onGenerated: () => void;
}) {
  // With reference photos attached the request becomes an edit, served by
  // its own model family.
  const generateModels = useMemo(() => modelsOfType(catalog, "image"), [catalog]);
  const editModels = useMemo(() => modelsOfType(catalog, "imageEdit"), [catalog]);
  const editing = references.length > 0;
  const models = editing ? editModels : generateModels;
  const [generateModelId, setGenerateModelId] = useState(generateModels[0]?.id ?? "");
  const [editModelId, setEditModelId] = useState(editModels[0]?.id ?? "");
  const modelId = editing ? editModelId : generateModelId;
  const model = models.find((entry) => entry.id === modelId) ?? models[0];
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const cost = model
    ? estimateCostCredits(model, { multiplier: catalog.priceMultiplier })
    : undefined;

  const generate = useCallback(async () => {
    if (!model || !prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      let images: string[];
      if (editing) {
        // The edit endpoint takes a single image; extra references stay
        // visible in the UI but only the first one is sent.
        images = [await editImage(model.id, prompt.trim(), references[0])];
      } else {
        images = await generateImages(model.id, {
          model: model.id,
          prompt: prompt.trim(),
          variants: 1,
          format: "png",
          hide_watermark: true,
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
  }, [model, prompt, busy, editing, references, onGenerated]);

  return (
    <div className="mobile-studio-form">
      <ModelPickerButton
        label={editing ? "Edit model" : "Image model"}
        value={model?.id ?? ""}
        onOpen={() => setPickerOpen(true)}
      />
      <ReferencePicker
        references={references}
        onChange={onReferencesChange}
        galleryImages={galleryImages}
        hint={
          references.length > 1
            ? "This model uses the first reference; the others stay handy here."
            : references.length === 1
              ? "The prompt describes the edit to apply."
              : undefined
        }
      />
      <textarea
        className="mobile-studio-prompt"
        value={prompt}
        rows={3}
        placeholder={
          editing ? "Describe how to transform the photo" : "Describe the image to generate"
        }
        onChange={(event) => setPrompt(event.target.value)}
      />
      <button
        type="button"
        className="mobile-studio-generate"
        disabled={!model || !prompt.trim() || busy}
        onClick={() => void generate()}
      >
        {busy ? <Spinner /> : "Generate"}
        {!busy && cost !== undefined ? (
          <span className="mobile-studio-cost">{formatCredits(cost)}</span>
        ) : null}
      </button>
      {busy && editing ? (
        <p className="mobile-studio-progress" data-shimmer="true">
          Editing. Heavy models can take a minute or two.
        </p>
      ) : null}
      {error ? <p className="mobile-dictation-error">{error}</p> : null}
      {pickerOpen ? (
        <ModelSheet
          title={editing ? "Edit model" : "Image model"}
          entries={models.map((entry) => ({
            id: entry.id,
            name: entry.name,
            subtitle: entry.tier,
          }))}
          selectedId={model?.id ?? ""}
          onSelect={(id) => {
            if (id) {
              if (editing) setEditModelId(id);
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
  const [familyKey, setFamilyKey] = useState(families[0]?.key ?? "");
  const family = families.find((entry) => entry.key === familyKey) ?? families[0];
  const [references, setReferences] = useState<string[]>([]);
  // A reference photo switches the family to its image-to-video variant.
  const model = references.length
    ? (family?.imageModel ?? family?.textModel)
    : (family?.textModel ?? family?.imageModel);
  const referenceUsable = Boolean(references.length && family?.imageModel);
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

  const queueBody = useCallback((): Record<string, unknown> | undefined => {
    if (!model || !prompt.trim()) return undefined;
    const body: Record<string, unknown> = { model: model.id, prompt: prompt.trim() };
    if (effectiveDuration) body.duration = effectiveDuration;
    if (referenceUsable) body.image_url = references[0];
    return body;
  }, [model, prompt, effectiveDuration, references, referenceUsable]);

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
      {family?.imageModel ? (
        <ReferencePicker
          references={references}
          onChange={setReferences}
          galleryImages={galleryImages}
          hint={references.length ? "The clip animates from the first photo." : undefined}
        />
      ) : null}
      <textarea
        className="mobile-studio-prompt"
        value={prompt}
        rows={3}
        placeholder={references.length ? "Describe the motion" : "Describe the video to generate"}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <button
        type="button"
        className="mobile-studio-generate"
        disabled={!model || !prompt.trim() || busy}
        onClick={start}
      >
        {busy ? <Spinner /> : "Generate"}
        {!busy && quote !== undefined ? (
          <span className="mobile-studio-cost">{formatCredits(quote)}</span>
        ) : null}
      </button>
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
          entries={families.map((entry) => ({
            id: entry.key,
            name: entry.name,
            subtitle: entry.imageModel ? "text + photo reference" : "text to video",
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
  const src = useArtifactDataUrl(artifact);
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
}: {
  references: string[];
  onChange: (refs: string[]) => void;
  galleryImages: StudioArtifact[];
  hint?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);

  const addFromGallery = useCallback(
    async (artifact: StudioArtifact) => {
      try {
        const dataUrl = await artifactDataUrl(artifact);
        onChange([...references, dataUrl]);
      } finally {
        setGalleryOpen(false);
      }
    },
    [references, onChange],
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
          reader.onload = () => {
            if (typeof reader.result === "string") onChange([...references, reader.result]);
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
