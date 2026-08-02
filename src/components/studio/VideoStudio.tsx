// Video studio: model families group the text-to-video, image-to-video, and
// reference-to-video variants behind one picker with a direction toggle.
// Generation is always async (quote → queue → poll → download) and any number
// of renders can run at once. Rust owns the poll and the download once a job
// is queued, so a render survives the app being closed and lands in the
// gallery on its own — the job list here is a view of those durable rows.

import { IconVideo } from "central-icons/IconVideo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  artifactSrc,
  listArtifacts,
  readArtifactBase64,
  registerDownloadedArtifact,
} from "../../lib/studio/artifacts";
import { formatElapsed, useMediaJobQueue } from "../../lib/studio/async-job";
import {
  formatCredits,
  isReferenceToVideoModel,
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
  alternativeCount,
  anchorOf,
  type ChainShot,
  chainCost,
  chainCuts,
  chainOf,
  isChained,
} from "../../lib/studio/chain";
import {
  closestAspectRatio,
  continuationPrompt,
  extractFrameAt,
  extractHandoffFrame,
  HANDOFF_ADJUST_WINDOW_SECONDS,
} from "../../lib/studio/frames";
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
import { effectiveOption, formatSeconds, PillGroup, SliderField, StudioField } from "./controls";

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

/** The clip the opening frame was handed off from, and where in it. */
interface Handoff {
  artifactId: string;
  fileName: string;
  src: string;
  timeSeconds: number;
  durationSeconds: number;
}

/** Where in the chain's first shot the anchor frame is taken, as a fraction of
 * its length: early enough to show the subject established, past any opening
 * fade. */
const ANCHOR_AT_FRACTION = 0.15;

/** Source-clip ceiling: the backends cap media inputs around this size, and a
 * bigger clip would also stall the IPC bridge. */
const MAX_VIDEO_INPUT_BYTES = 15 * 1024 * 1024;

export function VideoStudio({
  catalog,
  onAssembleChain,
}: {
  catalog: MediaCatalog;
  /** Hand a finished chain to the Assemble tab, trims already applied. */
  onAssembleChain?: (cuts: ChainShot[]) => void;
}) {
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
  const baseModel = family?.[slot];
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
  // Continuity: which clip is being read for a handoff frame, and where the
  // opening frame currently in the form came from.
  const [continuingId, setContinuingId] = useState<string | undefined>(undefined);
  const [handoff, setHandoff] = useState<Handoff | undefined>(undefined);
  // The handoff point the slider is asking for, which trails the extracted one
  // while a re-read is in flight.
  const [handoffTime, setHandoffTime] = useState(0);
  const [handoffError, setHandoffError] = useState<string | undefined>(undefined);
  const [handoffNote, setHandoffNote] = useState<string | undefined>(undefined);
  // The chain the next render joins, and the look it is anchored to: a frame
  // from its first shot, sent as a reference so a face does not drift over
  // four generations that each only ever saw their predecessor.
  const [anchorFrame, setAnchorFrame] = useState("");
  const [keepLook, setKeepLook] = useState(true);
  const [looping, setLooping] = useState(false);
  const [videoArtifacts, setVideoArtifacts] = useState<StudioArtifact[]>([]);
  const [galleryVideos, setGalleryVideos] = useState<StudioArtifact[]>([]);
  const [quote, setQuote] = useState<undefined | number>(undefined);
  const [galleryEpoch, setGalleryEpoch] = useState(0);
  const openingInputRef = useRef<HTMLInputElement>(null);
  const endInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  /**
   * Anchoring renders the shot with the family's reference-to-video model
   * instead of its image-to-video one: that is the contract that takes several
   * photos, so the handoff frame can open the clip while the anchor holds the
   * look. Only offered when the family has both and a chain is in progress.
   */
  const canAnchor = Boolean(
    effectiveDirection === "image" && anchorFrame && family?.referenceModel,
  );
  const anchoring = canAnchor && keepLook;
  const model = anchoring ? (family?.referenceModel ?? baseModel) : baseModel;
  const constraints = model?.constraints;

  // The chain on screen: the one being continued, else the most recent one in
  // the gallery (artifacts arrive newest first).
  const activeChain = useMemo(() => {
    const seed = handoff
      ? videoArtifacts.find((entry) => entry.id === handoff.artifactId)
      : videoArtifacts.find((entry) => isChained(entry, videoArtifacts));
    return seed ? chainOf(seed, videoArtifacts) : [];
  }, [handoff, videoArtifacts]);
  const chainSpend = useMemo(() => chainCost(activeChain), [activeChain]);

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
      // Rust carried the lineage on the row, so a render that landed while the
      // app was closed still joins its chain when it is indexed here.
      parentId: finished.parentArtifactId,
      parentHandoffSeconds: finished.parentHandoffSeconds,
      costCredits: finished.costCredits,
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
        // Anchoring rides the reference-to-video contract (several photos,
        // verified), never an undocumented extra field on image-to-video: the
        // handoff frame still opens the clip, the anchor holds the look.
        if (anchorFrame && isReferenceToVideoModel(target.id)) {
          body.reference_image_urls = [openingFrame, anchorFrame];
        }
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
      anchorFrame,
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
        parentArtifactId: handoff?.artifactId,
        parentHandoffSeconds: handoff?.timeSeconds,
        costCredits: quoteCredits,
        retrieve: (queueId) => ({
          path: VIDEO_RETRIEVE_PATH,
          body: retrieveBody(queueId, target.id),
        }),
        urlFields: VIDEO_URL_FIELDS,
      });
    }
  }, [model, alsoFamilies, slot, bodyForModel, prompt, queue, handoff]);

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

  /**
   * Start the next shot where this clip ended: its handoff frame becomes the
   * opening frame, its prompt becomes the continuity prompt, and the family it
   * was rendered with is reselected when it can animate a frame.
   */
  const continueFrom = useCallback(
    async (artifact: StudioArtifact) => {
      const src = artifactSrc(artifact);
      setContinuingId(artifact.id);
      setHandoffError(undefined);
      setHandoffNote(undefined);
      try {
        const frame = await extractHandoffFrame(src);
        const source = families.find((entry) =>
          [entry.textModel, entry.imageModel, entry.referenceModel, entry.videoModel].some(
            (candidate) => candidate?.id === artifact.model,
          ),
        );
        setDirection("image");
        if (source?.imageModel) {
          setFamilyKey(source.key);
        } else if (source) {
          // Silently falling back to another family is how you end up wondering
          // why the continuation does not look like the shot it continues.
          setHandoffNote(
            `${source.name} cannot start from an image. Pick the model to continue with.`,
          );
          setFamilyKey("");
        }
        setOpeningFrame(frame.dataUrl);
        setEndFrame("");
        setPrompt((current) => continuationPrompt(artifact.prompt || current));
        // Match the clip's own shape, or the next shot silently changes format.
        const ratio = closestAspectRatio(frame.width / Math.max(1, frame.height), aspectOptions);
        if (ratio) setAspectRatio(ratio);
        setHandoff({
          artifactId: artifact.id,
          fileName: artifact.fileName,
          src,
          timeSeconds: frame.timeSeconds,
          durationSeconds: frame.durationSeconds,
        });
        setHandoffTime(frame.timeSeconds);
        // The chain this render will join, and a frame from its first shot to
        // anchor the look on. Taken early in that shot (not at its handoff
        // point) so it shows the subject established, not mid-transition.
        const joined = chainOf(artifact, videoArtifacts);
        const first = anchorOf(joined) ?? artifact;
        const anchorSrc = first.id === artifact.id ? src : artifactSrc(first);
        extractFrameAt(anchorSrc, ANCHOR_AT_FRACTION * frame.durationSeconds)
          .then((anchor) => setAnchorFrame(anchor.dataUrl))
          // Anchoring is an improvement, never a requirement: without it the
          // chain still renders, it just drifts more.
          .catch(() => setAnchorFrame(""));
      } catch {
        setHandoffError("Couldn't read a frame from that clip.");
      } finally {
        setContinuingId(undefined);
      }
    },
    [families, aspectOptions],
  );

  // Dragging the handoff point re-reads that frame. Debounced: a drag fires a
  // stream of values and each read costs a seek plus a full-size encode.
  useEffect(() => {
    if (!handoff || Math.abs(handoffTime - handoff.timeSeconds) < 0.01) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      extractFrameAt(handoff.src, handoffTime)
        .then((frame) => {
          if (cancelled) return;
          setOpeningFrame(frame.dataUrl);
          setHandoff((current) =>
            current && current.artifactId === handoff.artifactId
              ? { ...current, timeSeconds: frame.timeSeconds }
              : current,
          );
        })
        .catch(() => {
          if (!cancelled) setHandoffError("Couldn't read that frame.");
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [handoff, handoffTime]);

  /**
   * Close the loop: end this shot on the frame the chain opened with, so the
   * sequence can play round. Only the models that accept an end frame honour
   * it - the same bet the End frame field already makes.
   */
  const closeLoop = useCallback(
    async (next: boolean) => {
      setLooping(next);
      const first = activeChain[0];
      if (!next || !first) {
        setEndFrame("");
        return;
      }
      try {
        const frame = await extractFrameAt(artifactSrc(first), 0);
        setEndFrame(frame.dataUrl);
      } catch {
        setLooping(false);
        setHandoffError("Couldn't read the first shot's opening frame.");
      }
    },
    [activeChain],
  );

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
          <StudioField
            label="Opening frame"
            hint={
              handoff
                ? `Continuing at ${formatSeconds(handoff.timeSeconds)} of ${formatSeconds(handoff.durationSeconds)}`
                : undefined
            }
          >
            <div className="studio-upload">
              {openingFrame ? (
                <img src={openingFrame} alt="Opening frame" className="studio-upload-preview" />
              ) : null}
              {handoff ? (
                <p className="studio-field-note">Handed off from {handoff.fileName}</p>
              ) : null}
              {handoffNote ? <p className="studio-field-note">{handoffNote}</p> : null}
              {handoffError ? <p className="studio-error">{handoffError}</p> : null}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setHandoff(undefined);
                  openingInputRef.current?.click();
                }}
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
          {canAnchor ? (
            <label className="studio-consent">
              <input
                type="checkbox"
                checked={keepLook}
                onChange={(event) => setKeepLook(event.currentTarget.checked)}
              />
              <span>
                Keep the first shot's look
                <span className="studio-consent-meta">
                  Renders with {family?.referenceModel?.name ?? "the reference model"} so a frame
                  from the first shot can hold the subject and lighting steady down the chain.
                </span>
              </span>
            </label>
          ) : null}
          {handoff ? (
            <SliderField
              label="Handoff point"
              min={Math.max(0, handoff.durationSeconds - HANDOFF_ADJUST_WINDOW_SECONDS)}
              max={handoff.durationSeconds}
              step={0.05}
              value={handoffTime}
              format={formatSeconds}
              onChange={setHandoffTime}
            />
          ) : null}
          {activeChain.length > 1 ? (
            <label className="studio-consent">
              <input
                type="checkbox"
                checked={looping}
                onChange={(event) => void closeLoop(event.currentTarget.checked)}
              />
              <span>
                Close the loop
                <span className="studio-consent-meta">
                  Ends this shot on the frame the chain opened with, so the sequence plays round.
                </span>
              </span>
            </label>
          ) : null}
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
      {handoffError && !openingFrame ? <p className="studio-error">{handoffError}</p> : null}
      {activeChain.length > 1 ? (
        <section className="studio-chain" aria-label="Shot chain">
          <div className="studio-chain-head">
            <span className="studio-field-label">Shot chain · {activeChain.length} shots</span>
            {onAssembleChain ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => onAssembleChain(chainCuts(activeChain))}
              >
                Send to assemble
              </button>
            ) : null}
          </div>
          <ol className="studio-chain-list">
            {activeChain.map((shot, index) => (
              <li
                key={shot.id}
                className="studio-chain-shot"
                data-continuing={shot.id === handoff?.artifactId ? "true" : undefined}
              >
                <span className="studio-chain-index">{index + 1}</span>
                <span className="studio-chain-prompt" title={shot.prompt}>
                  {shot.prompt || shot.fileName}
                </span>
                {alternativeCount(shot, activeChain, videoArtifacts) > 0 ? (
                  <span className="studio-chain-index" title="Other takes continue from this shot">
                    +{alternativeCount(shot, activeChain, videoArtifacts)}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
          <p className="studio-field-note">
            Each shot is cut where the next one took over, so the seam is not played twice.
          </p>
        </section>
      ) : null}
      <GalleryStrip
        kind="video"
        epoch={galleryEpoch}
        onArtifactsChanged={setVideoArtifacts}
        onContinue={(artifact) => void continueFrom(artifact)}
        continuingId={continuingId}
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
