// Video studio: model families group the text-to-video, image-to-video, and
// reference-to-video variants behind one picker with a direction toggle.
// Generation is always async (quote → queue → poll → download) and any number
// of renders can run at once. Rust owns the poll and the download once a job
// is queued, so a render survives the app being closed and lands in the
// gallery on its own — the job list here is a view of those durable rows.

import { IconVideo } from "central-icons/IconVideo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listArtifacts,
  readArtifactBase64,
  registerDownloadedArtifact,
} from "../../lib/studio/artifacts";
import { formatElapsed, useMediaJobQueue } from "../../lib/studio/async-job";
import {
  formatCredits,
  isSeedanceModel,
  isVideoUpscaleModel,
  type VideoFamily,
  videoFamilies,
} from "../../lib/studio/catalog";
import { mediaJson } from "../../lib/studio/client";
import {
  hasSeedanceConsent,
  rememberSeedanceConsent,
  withSeedanceConsent,
} from "../../lib/studio/consent";
import {
  retrieveBody,
  supportsVideoQuote,
  VIDEO_QUEUE_PATH,
  VIDEO_QUOTE_PATH,
  VIDEO_RETRIEVE_PATH,
} from "../../lib/studio/paths";
import type { MediaCatalog, MediaModel, StudioArtifact } from "../../lib/studio/types";
import { EmptyState } from "../ui/EmptyState";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { GalleryStrip } from "./GalleryStrip";
import { GenerationLayout } from "./GenerationLayout";
import { effectiveOption, PillGroup, StudioField } from "./controls";

const VIDEO_URL_FIELDS = ["video_url", "url"];

/** The four video intents. Text needs no photo; "image" animates one photo
 * as the opening frame (with an optional end frame - that pair also drives
 * the transition models); "reference" sends photos that steer style/subject
 * while the prompt drives the action; "video" restyles or upscales an
 * existing clip. */
type VideoDirection = "text" | "image" | "reference" | "video";

const DIRECTION_SLOT: Record<
  VideoDirection,
  "textModel" | "imageModel" | "referenceModel" | "videoModel"
> = {
  text: "textModel",
  image: "imageModel",
  reference: "referenceModel",
  video: "videoModel",
};

/** Style/subject references stay a small set - more rarely helps and every
 * one inflates the request. */
const MAX_VIDEO_REFERENCES = 4;

/** Source-clip ceiling: the backends cap media inputs around this size, and a
 * bigger clip would also stall the IPC bridge. */
const MAX_VIDEO_INPUT_BYTES = 15 * 1024 * 1024;

export function VideoStudio({ catalog }: { catalog: MediaCatalog }) {
  const families = useMemo(() => videoFamilies(catalog), [catalog]);
  const availableDirections = useMemo<VideoDirection[]>(
    () =>
      (["text", "image", "reference", "video"] as const).filter((entry) =>
        families.some((family) => family[DIRECTION_SLOT[entry]]),
      ),
    [families],
  );
  const [direction, setDirection] = useState<VideoDirection>("text");
  const effectiveDirection = availableDirections.includes(direction)
    ? direction
    : (availableDirections[0] ?? "text");
  const slot = DIRECTION_SLOT[effectiveDirection];
  const familiesForDirection = useMemo(
    () => families.filter((family) => family[slot]),
    [families, slot],
  );
  const [familyKey, setFamilyKey] = useState("");
  const family =
    familiesForDirection.find((entry) => entry.key === familyKey) ?? familiesForDirection[0];
  const model = family?.[slot];
  const constraints = model?.constraints;
  // Comparison: extra families that render the same request in parallel; each
  // shows up as its own card in the job list.
  const [alsoKeys, setAlsoKeys] = useState<string[]>([]);
  const alsoFamilies = useMemo(
    () =>
      alsoKeys
        .filter((key) => key !== family?.key)
        .map((key) => familiesForDirection.find((entry) => entry.key === key))
        .filter((entry): entry is VideoFamily => Boolean(entry)),
    [alsoKeys, family, familiesForDirection],
  );

  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [duration, setDuration] = useState("");
  const [aspectRatio, setAspectRatio] = useState("");
  const [resolution, setResolution] = useState("");
  // Image direction: one opening frame plus an optional end frame (the pair
  // is how transition models morph between two stills).
  const [openingFrame, setOpeningFrame] = useState("");
  const [endFrame, setEndFrame] = useState("");
  // Reference direction: a small set of style/subject photos.
  const [references, setReferences] = useState<string[]>([]);
  // Video direction: one source clip (upload or gallery) + the upscale factor
  // for the upscaler models.
  const [sourceVideo, setSourceVideo] = useState("");
  const [sourceVideoName, setSourceVideoName] = useState("");
  const [sourceVideoError, setSourceVideoError] = useState<string | undefined>(undefined);
  const [upscaleFactor, setUpscaleFactor] = useState<"1" | "2" | "4">("2");
  const [galleryVideos, setGalleryVideos] = useState<StudioArtifact[]>([]);
  const [quote, setQuote] = useState<number | undefined>(undefined);
  const [galleryEpoch, setGalleryEpoch] = useState(0);
  const openingInputRef = useRef<HTMLInputElement>(null);
  const endInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  const isUpscale = Boolean(model && isVideoUpscaleModel(model.id));

  // Seedance gates any clip built from a photo behind a face-media attestation,
  // remembered so it is asked once. A comparison render can target several
  // models at once, so any seedance target in a reference direction pulls it in.
  const [consent, setConsent] = useState(hasSeedanceConsent);
  const referenceDirection = effectiveDirection === "image" || effectiveDirection === "reference";
  const consentTargets = useMemo(
    () =>
      [model, ...alsoFamilies.map((entry) => entry[slot])].filter((entry): entry is MediaModel =>
        Boolean(entry),
      ),
    [model, alsoFamilies, slot],
  );
  const needsConsent =
    referenceDirection && consentTargets.some((target) => isSeedanceModel(target.id));

  // The gallery's own clips are the natural v2v sources; refresh the list as
  // finished renders land.
  useEffect(() => {
    if (effectiveDirection !== "video") return;
    listArtifacts("video")
      .then(setGalleryVideos)
      .catch(() => undefined);
  }, [effectiveDirection, galleryEpoch]);

  const durationOptions = constraints?.durations ?? [];
  const aspectOptions = constraints?.aspect_ratios ?? [];
  const resolutionOptions = constraints?.resolutions ?? [];
  const effectiveDuration = effectiveOption(durationOptions, duration);
  const effectiveAspect = effectiveOption(aspectOptions, aspectRatio);
  const effectiveResolution = effectiveOption(resolutionOptions, resolution);

  // Rust downloaded the file into the gallery directory already (possibly
  // while the app was closed); the hook hydrates from the durable rows on
  // mount, so pending renders re-appear on their own.
  const queue = useMediaJobQueue("video", (artifact, finished) => {
    registerDownloadedArtifact(artifact, {
      kind: "video",
      model: finished.model,
      prompt: finished.prompt,
    });
    setGalleryEpoch((epoch) => epoch + 1);
  });

  // Request body for any target model of the active direction: settings are
  // resolved against that model's own constraints so a comparison family never
  // receives an option it does not offer.
  const bodyForModel = useCallback(
    (target: MediaModel): Record<string, unknown> | undefined => {
      const targetUpscale = isVideoUpscaleModel(target.id);
      // Upscaling needs no prompt; every other direction does.
      if (!prompt.trim() && !targetUpscale) return undefined;
      if (effectiveDirection === "image" && !openingFrame) return undefined;
      if (effectiveDirection === "reference" && references.length === 0) return undefined;
      if (effectiveDirection === "video" && !sourceVideo) return undefined;
      const body: Record<string, unknown> = { model: target.id };
      if (prompt.trim()) body.prompt = prompt.trim();
      if (negativePrompt.trim()) body.negative_prompt = negativePrompt.trim();
      if (effectiveDirection === "video" && targetUpscale) {
        // The upscaler contract: source clip + factor, duration "Auto".
        body.video_url = sourceVideo;
        body.upscale_factor = Number(upscaleFactor);
        body.duration = "Auto";
        return body;
      }
      const targetConstraints = target.constraints;
      const targetDuration = effectiveOption(targetConstraints?.durations ?? [], duration);
      const targetAspect = effectiveOption(targetConstraints?.aspect_ratios ?? [], aspectRatio);
      const targetResolution = effectiveOption(targetConstraints?.resolutions ?? [], resolution);
      if (targetDuration) body.duration = targetDuration;
      if (targetAspect) body.aspect_ratio = targetAspect;
      if (targetResolution) body.resolution = targetResolution;
      if (effectiveDirection === "image") {
        body.image_url = openingFrame;
        if (endFrame) body.end_image_url = endFrame;
      } else if (effectiveDirection === "reference") {
        body.reference_image_urls = references;
      } else if (effectiveDirection === "video") {
        body.video_url = sourceVideo;
      }
      // Only the seedance targets carry the face-media attestation, and only
      // once the user has acknowledged it.
      const referenceRender = effectiveDirection === "image" || effectiveDirection === "reference";
      if (referenceRender && consent && isSeedanceModel(target.id)) {
        return withSeedanceConsent(body);
      }
      return body;
    },
    [
      prompt,
      negativePrompt,
      effectiveDirection,
      openingFrame,
      endFrame,
      references,
      sourceVideo,
      upscaleFactor,
      duration,
      aspectRatio,
      resolution,
      consent,
    ],
  );

  const queueBody = useCallback(
    (): Record<string, unknown> | undefined => (model ? bodyForModel(model) : undefined),
    [model, bodyForModel],
  );

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
    if (!model) return;
    const targets = [model, ...alsoFamilies.map((entry) => entry[slot])].filter(
      (entry): entry is MediaModel => Boolean(entry),
    );
    for (const target of targets) {
      const body = bodyForModel(target);
      if (!body) continue;
      void queue.start({
        kind: "video",
        model: target.id,
        prompt: prompt.trim(),
        extension: "mp4",
        queuePath: VIDEO_QUEUE_PATH,
        queueBody: body,
        retrieve: (queueId) => ({
          path: VIDEO_RETRIEVE_PATH,
          body: retrieveBody(queueId, target.id),
        }),
        urlFields: VIDEO_URL_FIELDS,
      });
    }
  }, [model, alsoFamilies, slot, bodyForModel, prompt, queue]);

  const readInto = useCallback((file: File | undefined, set: (dataUri: string) => void) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") set(reader.result);
    };
    reader.readAsDataURL(file);
  }, []);

  const onPickVideoFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      setSourceVideoError(undefined);
      if (file.size > MAX_VIDEO_INPUT_BYTES) {
        setSourceVideoError("That clip is too large. Keep the source under 15 MB.");
        return;
      }
      readInto(file, (dataUri) => {
        setSourceVideo(dataUri);
        setSourceVideoName(file.name);
      });
    },
    [readInto],
  );

  const pickGalleryVideo = useCallback(async (artifact: StudioArtifact) => {
    setSourceVideoError(undefined);
    if (artifact.bytes > MAX_VIDEO_INPUT_BYTES) {
      setSourceVideoError("That clip is too large. Keep the source under 15 MB.");
      return;
    }
    try {
      const base64 = await readArtifactBase64(artifact);
      setSourceVideo(`data:video/mp4;base64,${base64}`);
      setSourceVideoName(artifact.fileName);
    } catch {
      setSourceVideoError("Couldn't read that clip from the gallery.");
    }
  }, []);

  const multiplier = catalog.priceMultiplier ?? 1;
  const quoteCredits = quote !== undefined ? quote * 100 * multiplier : undefined;
  const canSubmit = Boolean(queueBody()) && (!needsConsent || consent);

  const controls = (
    <>
      {availableDirections.length > 1 ? (
        <SegmentedControl
          value={effectiveDirection}
          onValueChange={(value) => {
            setDirection(value);
            setFamilyKey("");
          }}
          aria-label="Video input"
          options={availableDirections.map((entry) => ({
            value: entry,
            label:
              entry === "text"
                ? "From text"
                : entry === "image"
                  ? "From image"
                  : entry === "reference"
                    ? "From reference"
                    : "From video",
          }))}
        />
      ) : null}
      <StudioField label="Model">
        <Select
          value={family?.key ?? null}
          placeholder="Choose a model"
          ariaLabel="Video model"
          onChange={setFamilyKey}
          options={familiesForDirection.map((entry) => ({ value: entry.key, label: entry.name }))}
        />
      </StudioField>
      {familiesForDirection.length > 1 ? (
        <StudioField
          label="Also render with"
          hint={alsoFamilies.length > 0 ? `${alsoFamilies.length + 1} renders` : "Optional"}
        >
          <div className="studio-upload">
            {alsoFamilies.length > 0 ? (
              <div className="studio-compare-chips">
                {alsoFamilies.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    className="studio-compare-chip"
                    aria-label={`Stop rendering with ${entry.name}`}
                    onClick={() =>
                      setAlsoKeys((current) => current.filter((key) => key !== entry.key))
                    }
                  >
                    <span>{entry.name}</span>
                    <span aria-hidden>x</span>
                  </button>
                ))}
              </div>
            ) : null}
            <Select
              value={null}
              placeholder="Add a model"
              ariaLabel="Add a model to render with"
              onChange={(key) =>
                setAlsoKeys((current) => (current.includes(key) ? current : [...current, key]))
              }
              options={familiesForDirection
                .filter((entry) => entry.key !== family?.key && !alsoKeys.includes(entry.key))
                .map((entry) => ({ value: entry.key, label: entry.name }))}
            />
          </div>
        </StudioField>
      ) : null}
      {effectiveDirection === "image" ? (
        <>
          <StudioField label="Opening frame">
            <div className="studio-upload">
              {openingFrame ? (
                <img src={openingFrame} alt="Opening frame" className="studio-upload-preview" />
              ) : null}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => openingInputRef.current?.click()}
              >
                {openingFrame ? "Replace image" : "Choose an image"}
              </button>
              <input
                ref={openingInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(event) => {
                  readInto(event.target.files?.[0], setOpeningFrame);
                  event.target.value = "";
                }}
              />
            </div>
          </StudioField>
          <StudioField label="End frame" hint="Optional">
            <div className="studio-upload">
              {endFrame ? (
                <img src={endFrame} alt="End frame" className="studio-upload-preview" />
              ) : null}
              <div className="studio-card-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => endInputRef.current?.click()}
                >
                  {endFrame ? "Replace image" : "Add an end frame"}
                </button>
                {endFrame ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setEndFrame("")}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              <input
                ref={endInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(event) => {
                  readInto(event.target.files?.[0], setEndFrame);
                  event.target.value = "";
                }}
              />
            </div>
          </StudioField>
        </>
      ) : null}
      {effectiveDirection === "reference" ? (
        <StudioField
          label="Reference photos"
          hint={`${references.length} / ${MAX_VIDEO_REFERENCES}`}
        >
          <div className="studio-upload">
            {references.length > 0 ? (
              <div className="studio-edit-sources">
                {references.map((reference, index) => (
                  <div key={`${index}-${reference.slice(-24)}`} className="studio-edit-source">
                    <img src={reference} alt={`Reference ${index + 1}`} />
                    <button
                      type="button"
                      className="studio-edit-source-remove"
                      aria-label={`Remove reference ${index + 1}`}
                      onClick={() =>
                        setReferences((current) => current.filter((_, i) => i !== index))
                      }
                    >
                      <span aria-hidden>x</span>
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {references.length < MAX_VIDEO_REFERENCES ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => referenceInputRef.current?.click()}
              >
                {references.length > 0 ? "Add another photo" : "Choose a photo"}
              </button>
            ) : null}
            <input
              ref={referenceInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(event) => {
                readInto(event.target.files?.[0], (dataUri) =>
                  setReferences((current) => [...current, dataUri].slice(0, MAX_VIDEO_REFERENCES)),
                );
                event.target.value = "";
              }}
            />
          </div>
        </StudioField>
      ) : null}
      {effectiveDirection === "video" ? (
        <>
          <StudioField label="Source clip" hint={sourceVideoName || undefined}>
            <div className="studio-upload">
              {sourceVideo ? (
                // biome-ignore lint/a11y/useMediaCaption: user-picked source clip has no track
                <video src={sourceVideo} className="studio-upload-preview" controls muted />
              ) : null}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => videoInputRef.current?.click()}
              >
                {sourceVideo ? "Replace clip" : "Choose a clip"}
              </button>
              {galleryVideos.length > 0 ? (
                <Select
                  value={null}
                  placeholder="Or pick from your gallery"
                  ariaLabel="Pick a gallery clip"
                  onChange={(path) => {
                    const artifact = galleryVideos.find((entry) => entry.path === path);
                    if (artifact) void pickGalleryVideo(artifact);
                  }}
                  options={galleryVideos.map((entry) => ({
                    value: entry.path,
                    label: entry.prompt ? entry.prompt.slice(0, 48) : entry.fileName,
                  }))}
                />
              ) : null}
              <input
                ref={videoInputRef}
                type="file"
                accept="video/mp4,video/quicktime,video/webm"
                hidden
                onChange={(event) => {
                  onPickVideoFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </div>
            {sourceVideoError ? <p className="studio-error">{sourceVideoError}</p> : null}
          </StudioField>
          {isUpscale ? (
            <StudioField label="Upscale" hint="x1 enhances without resizing">
              <PillGroup
                options={[
                  { value: "1", label: "x1" },
                  { value: "2", label: "x2" },
                  { value: "4", label: "x4" },
                ]}
                value={upscaleFactor}
                onChange={setUpscaleFactor}
                ariaLabel="Upscale factor"
              />
            </StudioField>
          ) : null}
        </>
      ) : null}
      {needsConsent ? (
        <label className="studio-consent">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => {
              setConsent(event.currentTarget.checked);
              rememberSeedanceConsent(event.currentTarget.checked);
            }}
          />
          <span>
            I have the right to use this photo and accept the model's face-media policy for anyone
            shown in it.
            <span className="studio-consent-meta">
              Seedance requires this before it will build a clip from a photo of a person.
            </span>
          </span>
        </label>
      ) : null}
      <StudioField label="Prompt" hint={isUpscale ? "Optional" : undefined}>
        <textarea
          className="studio-textarea"
          rows={4}
          value={prompt}
          placeholder={
            effectiveDirection === "image"
              ? "Describe the motion"
              : effectiveDirection === "reference"
                ? "Describe the scene to build from the references"
                : effectiveDirection === "video"
                  ? isUpscale
                    ? "Optional note for the upscaler"
                    : "Describe how to restyle the clip"
                  : "Describe the scene and the motion"
          }
          onChange={(event) => setPrompt(event.target.value)}
        />
      </StudioField>
      <StudioField label="Negative prompt">
        <textarea
          className="studio-textarea"
          rows={2}
          value={negativePrompt}
          placeholder="What to avoid (optional)"
          onChange={(event) => setNegativePrompt(event.target.value)}
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
      {quoteCredits !== undefined ? (
        <p className="studio-quote">This render will cost about {formatCredits(quoteCredits)}.</p>
      ) : null}
      <button type="button" className="studio-primary-button" disabled={!canSubmit} onClick={start}>
        Generate video
      </button>
      {queue.jobs.length > 0 ? (
        <p className="studio-queue-hint">
          {queue.jobs.length === 1
            ? "1 render in progress. You can queue another."
            : `${queue.jobs.length} renders in progress. You can queue another.`}
        </p>
      ) : null}
    </>
  );

  return (
    <GenerationLayout controls={controls} action={action}>
      {queue.jobs.map((entry) => (
        <div key={entry.job.id} className="studio-resume" data-phase={entry.phase}>
          <span>
            {entry.phase === "failed"
              ? (entry.message ?? "The render failed.")
              : entry.phase === "processing"
                ? `Rendering - ${formatElapsed(entry.elapsedMs)}`
                : `Queued - ${formatElapsed(entry.elapsedMs)}`}
            {" · "}
            {entry.job.model}
            {entry.job.prompt ? ` · "${entry.job.prompt.slice(0, 60)}"` : ""}
          </span>
          <span className="studio-card-actions">
            {entry.phase === "failed" ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => queue.dismiss(entry.job.id)}
              >
                Dismiss
              </button>
            ) : (
              <>
                <Spinner aria-hidden />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => queue.stop(entry.job.id)}
                >
                  Stop waiting
                </button>
              </>
            )}
          </span>
        </div>
      ))}
      <GalleryStrip
        kind="video"
        epoch={galleryEpoch}
        empty={
          queue.jobs.length === 0 ? (
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
