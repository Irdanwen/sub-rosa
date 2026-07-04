// Video studio: model families group the text-to-video and image-to-video
// variants behind one picker with a Text/Image toggle. Generation is always
// async (quote → queue → poll → download); queued jobs persist so a render
// paid for before a restart can be re-attached instead of orphaned.

import { IconVideo } from "central-icons/IconVideo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { saveArtifactFromUrl } from "../../lib/studio/artifacts";
import {
  formatElapsed,
  pendingJobs,
  removePersistedJob,
  useMediaJob,
  type PersistedJob,
} from "../../lib/studio/async-job";
import { videoFamilies } from "../../lib/studio/catalog";
import { formatCredits } from "../../lib/studio/catalog";
import { mediaJson } from "../../lib/studio/client";
import {
  retrieveBody,
  supportsVideoQuote,
  VIDEO_QUEUE_PATH,
  VIDEO_QUOTE_PATH,
  VIDEO_RETRIEVE_PATH,
} from "../../lib/studio/paths";
import type { MediaCatalog, MediaModel } from "../../lib/studio/types";
import { EmptyState } from "../ui/EmptyState";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { GalleryStrip } from "./GalleryStrip";
import { GenerationLayout } from "./GenerationLayout";
import { effectiveOption, PillGroup, StudioField } from "./controls";

function videoUrlFrom(response: Record<string, unknown>): string | undefined {
  const url = response.video_url ?? response.url;
  return typeof url === "string" && url.trim() ? url : undefined;
}

export function VideoStudio({ catalog }: { catalog: MediaCatalog }) {
  const families = useMemo(() => videoFamilies(catalog), [catalog]);
  const [familyKey, setFamilyKey] = useState(families[0]?.key ?? "");
  const family = families.find((entry) => entry.key === familyKey) ?? families[0];
  const [direction, setDirection] = useState<"text" | "image">("text");

  const model: MediaModel | undefined =
    direction === "image"
      ? (family?.imageModel ?? family?.textModel)
      : (family?.textModel ?? family?.imageModel);
  const effectiveDirection = model === family?.imageModel && family?.imageModel ? "image" : "text";
  const constraints = model?.constraints;

  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState("");
  const [aspectRatio, setAspectRatio] = useState("");
  const [resolution, setResolution] = useState("");
  const [referenceDataUri, setReferenceDataUri] = useState("");
  const [quote, setQuote] = useState<number | undefined>(undefined);
  const [resumable, setResumable] = useState<PersistedJob[]>([]);
  const [galleryEpoch, setGalleryEpoch] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const durationOptions = constraints?.durations ?? [];
  const aspectOptions = constraints?.aspect_ratios ?? [];
  const resolutionOptions = constraints?.resolutions ?? [];
  const effectiveDuration = effectiveOption(durationOptions, duration);
  const effectiveAspect = effectiveOption(aspectOptions, aspectRatio);
  const effectiveResolution = effectiveOption(resolutionOptions, resolution);

  const job = useMediaJob<string>(async (url, finished) => {
    await saveArtifactFromUrl(url, "mp4", {
      kind: "video",
      model: finished.model,
      prompt: finished.prompt,
    });
    setGalleryEpoch((epoch) => epoch + 1);
  });

  useEffect(() => {
    setResumable(pendingJobs("video"));
  }, []);

  const queueBody = useCallback((): Record<string, unknown> | undefined => {
    if (!model || !prompt.trim()) return undefined;
    if (effectiveDirection === "image" && !referenceDataUri) return undefined;
    const body: Record<string, unknown> = { model: model.id, prompt: prompt.trim() };
    if (effectiveDuration) body.duration = effectiveDuration;
    if (effectiveAspect) body.aspect_ratio = effectiveAspect;
    if (effectiveResolution) body.resolution = effectiveResolution;
    if (effectiveDirection === "image") body.image_url = referenceDataUri;
    return body;
  }, [
    model,
    prompt,
    effectiveDirection,
    referenceDataUri,
    effectiveDuration,
    effectiveAspect,
    effectiveResolution,
  ]);

  // Free price check, refreshed as the form changes (skipped for families
  // whose quote endpoint rejects valid payloads).
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

  const onPickFile = useCallback((file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setReferenceDataUri(reader.result);
    };
    reader.readAsDataURL(file);
  }, []);

  const busy =
    job.state.phase === "queueing" ||
    job.state.phase === "queued" ||
    job.state.phase === "processing";
  const multiplier = catalog.priceMultiplier ?? 1;
  const quoteCredits = quote !== undefined ? quote * 100 * multiplier : undefined;
  const canSubmit = Boolean(queueBody()) && !busy;

  const controls = (
    <>
      <StudioField label="Model">
        <Select
          value={family?.key ?? null}
          placeholder="Choose a model"
          ariaLabel="Video model"
          onChange={setFamilyKey}
          options={families.map((entry) => ({ value: entry.key, label: entry.name }))}
        />
      </StudioField>
      {family?.textModel && family?.imageModel ? (
        <SegmentedControl
          value={effectiveDirection}
          onValueChange={setDirection}
          aria-label="Video input"
          options={[
            { value: "text", label: "From text" },
            { value: "image", label: "From image" },
          ]}
        />
      ) : null}
      {effectiveDirection === "image" ? (
        <StudioField label="Reference image">
          <div className="studio-upload">
            {referenceDataUri ? (
              <img src={referenceDataUri} alt="Reference" className="studio-upload-preview" />
            ) : null}
            <button
              type="button"
              className="studio-secondary-button"
              onClick={() => fileInputRef.current?.click()}
            >
              {referenceDataUri ? "Replace image" : "Choose an image"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(event) => onPickFile(event.target.files?.[0])}
            />
          </div>
        </StudioField>
      ) : null}
      <StudioField label="Prompt">
        <textarea
          className="studio-textarea"
          rows={4}
          value={prompt}
          placeholder="Describe the scene and the motion"
          onChange={(event) => setPrompt(event.target.value)}
        />
      </StudioField>
      {durationOptions.length > 0 ? (
        <StudioField label="Duration">
          <PillGroup
            options={durationOptions.map((value) => ({ value }))}
            value={effectiveDuration}
            onChange={setDuration}
            ariaLabel="Duration"
          />
        </StudioField>
      ) : null}
      {aspectOptions.length > 0 ? (
        <StudioField label="Aspect ratio">
          <PillGroup
            options={aspectOptions.map((value) => ({ value }))}
            value={effectiveAspect}
            onChange={setAspectRatio}
            ariaLabel="Aspect ratio"
          />
        </StudioField>
      ) : null}
      {resolutionOptions.length > 0 ? (
        <StudioField label="Resolution">
          <PillGroup
            options={resolutionOptions.map((value) => ({ value }))}
            value={effectiveResolution}
            onChange={setResolution}
            ariaLabel="Resolution"
          />
        </StudioField>
      ) : null}
    </>
  );

  const action = (
    <>
      {quoteCredits !== undefined && !busy ? (
        <p className="studio-quote">This render will cost about {formatCredits(quoteCredits)}.</p>
      ) : null}
      {busy ? (
        <div className="studio-progress">
          <Spinner aria-hidden />
          <span>
            {job.state.phase === "queued"
              ? "Queued, waiting for a slot"
              : job.state.phase === "processing"
                ? "Rendering your video"
                : "Submitting"}
            {job.state.phase === "queued" || job.state.phase === "processing"
              ? ` - ${formatElapsed(job.state.elapsedMs)}`
              : ""}
          </span>
          <button type="button" className="studio-secondary-button" onClick={job.cancel}>
            Stop waiting
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="studio-primary-button"
          disabled={!canSubmit}
          onClick={start}
        >
          Generate video
        </button>
      )}
    </>
  );

  return (
    <GenerationLayout controls={controls} action={action}>
      {job.state.phase === "failed" ? <p className="studio-error">{job.state.message}</p> : null}
      {resumable.map((pending) => (
        <div key={pending.id} className="studio-resume">
          <span>
            A video from an earlier session may still be rendering: "{pending.prompt.slice(0, 80)}"
          </span>
          <span className="studio-card-actions">
            <button
              type="button"
              className="studio-secondary-button"
              onClick={() => resume(pending)}
            >
              Check on it
            </button>
            <button
              type="button"
              className="studio-secondary-button"
              onClick={() => {
                removePersistedJob(pending.id);
                setResumable((jobs) => jobs.filter((entry) => entry.id !== pending.id));
              }}
            >
              Dismiss
            </button>
          </span>
        </div>
      ))}
      <GalleryStrip
        kind="video"
        epoch={galleryEpoch}
        empty={
          !busy ? (
            <EmptyState
              icon={<IconVideo size={22} />}
              title="No videos yet"
              description="Videos render in the background and land here when ready. Most take 30 seconds to a few minutes."
            />
          ) : null
        }
      />
    </GenerationLayout>
  );
}
