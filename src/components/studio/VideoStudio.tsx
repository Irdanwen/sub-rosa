// Video studio: model families group the text-to-video, image-to-video, and
// reference-to-video variants behind one picker with a direction toggle.
// Generation is always async (quote → queue → poll → download) and any number
// of renders can run at once. Rust owns the poll and the download once a job
// is queued, so a render survives the app being closed and lands in the
// gallery on its own — the job list here is a view of those durable rows.

import { t } from "../../lib/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  artifactSrc,
  listArtifacts,
  readArtifactBase64,
  registerDownloadedArtifact,
} from "../../lib/studio/artifacts";
import { useMediaJobQueue } from "../../lib/studio/async-job";
import {
  formatCredits,
  isReferenceToVideoModel,
  variantFor,
  variantHint,
  isSeedanceModel,
  isVideoUpscaleModel,
  requiresOpeningFrame,
  type VideoFamily,
  videoFamilies,
} from "../../lib/studio/catalog";
import { mediaJson } from "../../lib/studio/client";
import { inlineMediaInputs, videoRequestBody } from "../../lib/studio/video-request";
import { hasSeedanceConsent, rememberSeedanceConsent } from "../../lib/studio/consent";
import { imageSize } from "../../lib/studio/downscale";
import {
  maxReferenceAudio,
  maxReferenceVideos,
  maxVideoReferences,
  referenceMention,
  seedanceImageProblem,
  seedancePersonMediaCaveat,
  seedancePromptAdvice,
  requestSizeProblem,
  seedanceWorkflowsFor,
  takesReferenceAudio,
  takesReferenceClips,
} from "../../lib/studio/seedance";
import { takesKlingReferences } from "../../lib/studio/kling";
import {
  dataUriSeconds,
  mediaSeconds,
  type ReferenceMedia,
  referenceAudioProblem,
  referenceClipProblem,
} from "../../lib/studio/reference-media";
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
import { describeJobFailure } from "../../lib/studio/job-errors";
import { estimateRenderMs, renderEtaKey } from "../../lib/studio/render-eta";
import {
  effectiveVideoConstraints,
  explainConstraintError,
  missingRequiredFields,
  rememberConstraintError,
} from "../../lib/studio/model-constraints";
import {
  retrieveBody,
  supportsVideoQuote,
  VIDEO_QUEUE_PATH,
  VIDEO_QUOTE_PATH,
  VIDEO_RETRIEVE_PATH,
} from "../../lib/studio/paths";
import type {
  ArtifactKind,
  MediaCatalog,
  MediaModel,
  StudioArtifact,
} from "../../lib/studio/types";
import { Select } from "../ui/Select";
import { MediaModelPicker, videoFamilyOption } from "./MediaModelPicker";
import { withInvariant } from "../../lib/studio/bible";
import { GalleryPicker } from "./GalleryPicker";
import { Filmstrip } from "./desk/Filmstrip";
import { DeskTools, StudioDesk } from "./desk/StudioDesk";
import { Dock, DockComposer, type DockBlocker } from "./stage/Dock";
import { DockSelectChip } from "./stage/DockChip";
import { ModelPickerChip } from "./stage/ModelPicker";
import { type StageResult, StageScene } from "./stage/Scene";
import { videoDirectionFilters, videoFamilyEntry } from "../../lib/studio/video-family-entries";
import { effectiveOption, formatSeconds, PillGroup, SliderField, StudioField } from "./controls";

/** "720p" and "1k" read in capitals in a chip. */
function formatResolution(option: string) {
  return option.toUpperCase();
}

const VIDEO_URL_FIELDS = ["video_url", "url"];

/**
 * Two surfaces, not four.
 *
 * "shot" builds a new clip out of whatever is provided: nothing (text to
 * video), an opening frame (image to video), reference photos (reference to
 * video), or a frame *and* references - which the backend accepts, and which
 * is exactly what continuing a shot while keeping a character sheet needs.
 * The variant is derived from the inputs rather than picked by hand, the same
 * way a family already hides its variants behind one entry.
 *
 * "video" stays separate: restyling or upscaling an existing clip is a
 * genuinely different contract (a source clip, no opening frame, sometimes no
 * prompt), and folding it in would only blur that.
 */
type VideoSurface = "shot" | "video";

/** Style/subject references the user supplies. How many a model actually takes
 * is per family (`maxVideoReferences`): seedance 2.0 documents 9, 2.5 documents
 * 30, and everything else keeps a low default because each reference inflates
 * the request and their influence thins out. The chain's own anchor frame rides
 * on top of this. */

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

/** Which gallery buckets hold something a reference clip can come from. */
const CLIP_KINDS: ArtifactKind[] = ["video"];

/** Which ones hold something reference audio can come from: everything the
 * studio renders as sound, whether it was written as a track or spoken. */
const AUDIO_KINDS: ArtifactKind[] = ["music", "speech", "sfx"];

export function VideoStudio({
  catalog,
  onAssembleChain,
  onOpenGallery,
}: {
  catalog: MediaCatalog;
  /** Hand a finished chain to the montage, trims already applied. */
  onAssembleChain?: (cuts: ChainShot[]) => void;
  onOpenGallery?: () => void;
}) {
  const families = useMemo(() => videoFamilies(catalog), [catalog]);
  const availableSurfaces = useMemo<VideoSurface[]>(
    () =>
      (["shot", "video"] as const).filter((entry) =>
        families.some((family) =>
          entry === "video"
            ? family.videoModel
            : family.textModel || family.imageModel || family.referenceModel,
        ),
      ),
    [families],
  );
  const [surface, setSurface] = useState<VideoSurface>("shot");
  const effectiveSurface = availableSurfaces.includes(surface)
    ? surface
    : (availableSurfaces[0] ?? "shot");
  const familiesForSurface = useMemo(
    () =>
      families.filter((family) =>
        effectiveSurface === "video"
          ? family.videoModel
          : family.textModel || family.imageModel || family.referenceModel,
      ),
    [families, effectiveSurface],
  );
  const [familyKey, setFamilyKey] = useState("");
  const family =
    familiesForSurface.find((entry) => entry.key === familyKey) ?? familiesForSurface[0];
  // Comparison: extra families that render the same request in parallel; each
  // shows up as its own card in the job list.
  const [alsoKeys, setAlsoKeys] = useState<string[]>([]);
  const alsoFamilies = useMemo(
    () =>
      alsoKeys
        .filter((key) => key !== family?.key)
        .map((key) => familiesForSurface.find((entry) => entry.key === key))
        .filter((entry): entry is VideoFamily => Boolean(entry)),
    [alsoKeys, family, familiesForSurface],
  );

  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [duration, setDuration] = useState("");
  const [aspectRatio, setAspectRatio] = useState("");
  const [resolution, setResolution] = useState("");
  // Shot inputs, all optional and all combinable: an opening frame (with an
  // optional end frame - the pair is how transition models morph between two
  // stills) and style/subject reference photos.
  const [openingFrame, setOpeningFrame] = useState("");
  const [endFrame, setEndFrame] = useState("");
  const [references, setReferences] = useState<string[]>([]);
  /** Why the last reference photo was refused, if it was. */
  const [referenceError, setReferenceError] = useState<string | undefined>(undefined);
  /** Reference clips: what the seedance edit, extend and stitch workflows work
   * from. Each carries its gallery id (the bytes are read at submit) and its
   * length, which the quote needs to match what the queue bills. */
  const [referenceClips, setReferenceClips] = useState<ReferenceMedia[]>([]);
  /** Why the last clip was refused (too long, or the request got too big). */
  const [clipError, setClipError] = useState<string | undefined>(undefined);
  /** Reference audio: a timbre or a voice for the render to follow. Never sent
   * alone - the contract forbids it - so it rides with the photos or clips. */
  const [referenceAudio, setReferenceAudio] = useState<ReferenceMedia[]>([]);
  const [audioError, setAudioError] = useState<string | undefined>(undefined);
  // Which image slot the gallery picker is filling, if any. One picker serves
  // all three: they differ only in what they do with what comes back.
  const [picking, setPicking] = useState<
    "opening" | "end" | "reference" | "clip" | "audio" | undefined
  >(undefined);
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
  /** The clip last made here, for the scene, and whether its wipe has played. */
  const [lastResult, setLastResult] = useState<StageResult | undefined>(undefined);
  const [reveal, setReveal] = useState(false);
  const [galleryEpoch, setGalleryEpoch] = useState(0);
  const openingInputRef = useRef<HTMLInputElement>(null);
  const endInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  /**
   * The chain's anchor frame is one more reference photo, offered when a chain
   * is in progress and the family can take references at all.
   */
  const canAnchor = Boolean(effectiveSurface === "shot" && anchorFrame && family?.referenceModel);
  const anchoring = canAnchor && keepLook;
  /** Everything that goes out as `reference_image_urls`: the user's photos
   * first (they were chosen deliberately), the chain's anchor last. */
  const outgoingReferences = useMemo(
    () => (anchoring ? [...references, anchorFrame] : references),
    [references, anchoring, anchorFrame],
  );
  // The variant follows the inputs: photos mean reference-to-video (the only
  // one that also takes a starting frame), a frame alone means image-to-video,
  // neither means text-to-video.
  const model =
    effectiveSurface === "video"
      ? family?.videoModel
      : variantFor(family, {
          hasFrame: Boolean(openingFrame),
          // A reference clip resolves the variant just like a photo does:
          // edit, extend and stitch all live on reference-to-video.
          hasReferences: outgoingReferences.length > 0 || referenceClips.length > 0,
        });
  /** How many reference photos this family takes. Read off the reference
   * variant rather than the resolved one: the cap has to hold while the user
   * is still adding the first photo, when `model` is not the reference
   * variant yet. */
  const referenceCap = maxVideoReferences(family?.referenceModel ?? model);
  /** Whether this family's reference variant takes clips at all. Most do not:
   * the public `-basic` variants publish `video_input: false`. */
  const clipsAllowed = takesReferenceClips(family?.referenceModel);
  /** Reference audio lands the other way round: the public variants do take it. */
  const audioAllowed = takesReferenceAudio(family?.referenceModel);
  /** Seedance reference renders route from the prompt: a wrong opening or a
   * loose mention silently runs the wrong workflow (and bills for it), so the
   * advice sits under the prompt rather than in a failure message after. */
  const promptAdvice = seedancePromptAdvice(model, prompt);
  /** The public seedance variants refuse person-bearing media whatever is
   * attested, so the checkbox says what it actually buys. */
  const personMediaCaveat = seedancePersonMediaCaveat(model);
  // Bumped when a rejection teaches us something, so the pickers re-derive.
  const [constraintEpoch, setConstraintEpoch] = useState(0);
  const constraints = useMemo(
    () => effectiveVideoConstraints(model),
    // biome-ignore lint/correctness/useExhaustiveDependencies: the epoch is the
    // signal that learned constraints changed under us.
    [model, constraintEpoch],
  );

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
  /** Any media showing a person can drive the render, whether it opens it,
   * steers it, or is the clip being extended - so the attestation follows the
   * presence of face-bearing media, not a mode. */
  const buildsFromFaceMedia =
    Boolean(openingFrame) || outgoingReferences.length > 0 || referenceClips.length > 0;
  const consentTargets = useMemo(
    () =>
      [
        model,
        ...alsoFamilies.map((entry) =>
          effectiveSurface === "video"
            ? entry.videoModel
            : variantFor(entry, {
                hasFrame: Boolean(openingFrame),
                hasReferences: outgoingReferences.length > 0,
              }),
        ),
      ].filter((entry): entry is MediaModel => Boolean(entry)),
    [model, alsoFamilies, effectiveSurface, openingFrame, outgoingReferences.length],
  );
  const needsConsent =
    buildsFromFaceMedia && consentTargets.some((target) => isSeedanceModel(target.id));

  // Switching family can land on a reference variant that takes no clips. Clips
  // already picked would then be dropped by `videoRequestBody` at submit, after
  // the prompt had been written around them - so they are let go here, while the
  // slot they were in is still on screen.
  useEffect(() => {
    if (clipsAllowed) return;
    setReferenceClips((current) => (current.length > 0 ? [] : current));
    setClipError(undefined);
  }, [clipsAllowed]);

  // Same for the audio, which most families do not take either.
  useEffect(() => {
    if (audioAllowed) return;
    setReferenceAudio((current) => (current.length > 0 ? [] : current));
    setAudioError(undefined);
  }, [audioAllowed]);

  // The gallery's own clips are the natural v2v sources; refresh the list as
  // finished renders land.
  useEffect(() => {
    if (effectiveSurface !== "video") return;
    listArtifacts("video")
      .then(setGalleryVideos)
      .catch(() => undefined);
  }, [effectiveSurface, galleryEpoch]);

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
    // The newest clip takes the scene, and wipes in once it can play.
    setLastResult({ kind: "video", src: artifactSrc({ path: artifact.path }) });
    setReveal(true);
  });
  /** How long each model in the queue has taken here before. Keyed off the
   * model list rather than the jobs: the entries are rebuilt every second by
   * the shared clock, and re-reading the store at 1 Hz for a number that
   * changes once per finished render is waste. */
  const queuedModels = queue.jobs.map((entry) => entry.job.model).join("|");
  const estimates = useMemo(() => {
    const known = new Map<string, number>();
    for (const model of queuedModels.split("|")) {
      if (!model || known.has(model)) continue;
      const estimate = estimateRenderMs(renderEtaKey("video", model));
      if (estimate !== undefined) known.set(model, estimate);
    }
    return known;
  }, [queuedModels]);

  // A rejected render carries the provider's own account of what the model
  // wanted. Read it once per job: the pickers then offer the right values, so
  // the second attempt is informed even for a model the catalog says nothing
  // about.
  const learnedJobs = useRef(new Set<string>());
  useEffect(() => {
    let learnedSomething = false;
    for (const entry of queue.jobs) {
      if (entry.phase !== "failed" || !entry.message) continue;
      if (learnedJobs.current.has(entry.job.id)) continue;
      learnedJobs.current.add(entry.job.id);
      if (Object.keys(rememberConstraintError(entry.job.model, entry.message)).length > 0) {
        learnedSomething = true;
      }
    }
    if (learnedSomething) setConstraintEpoch((epoch) => epoch + 1);
  }, [queue.jobs]);

  // Request body for any target model on the active surface. The shape lives
  // in `videoRequestBody` so both shells build the same one and it can be
  // tested without a component.
  const bodyForModel = useCallback(
    (target: MediaModel): Record<string, unknown> | undefined =>
      videoRequestBody({
        target,
        prompt,
        negativePrompt,
        openingFrame: effectiveSurface === "shot" ? openingFrame : undefined,
        endFrame: effectiveSurface === "shot" ? endFrame : undefined,
        references: effectiveSurface === "shot" ? outgoingReferences : undefined,
        // The chain's anchor is the look of the previous clip, a stage rather
        // than an identity: kling takes it as a scene image, after the
        // person's own photos have taken the elements.
        referenceRoles: anchoring
          ? [...references.map(() => undefined), { scene: true }]
          : undefined,
        referenceVideos:
          effectiveSurface === "shot" ? referenceClips.map((clip) => clip.dataUri) : undefined,
        referenceVideoSeconds:
          effectiveSurface === "shot" ? referenceClips.map((clip) => clip.seconds) : undefined,
        referenceAudio:
          effectiveSurface === "shot" ? referenceAudio.map((track) => track.dataUri) : undefined,
        sourceVideo: effectiveSurface === "video" ? sourceVideo : undefined,
        upscaleFactor: Number(upscaleFactor),
        duration,
        aspectRatio,
        resolution,
        consent,
      }),
    [
      prompt,
      negativePrompt,
      effectiveSurface,
      openingFrame,
      endFrame,
      outgoingReferences,
      anchoring,
      references,
      referenceClips,
      referenceAudio,
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
    const targets = [
      model,
      ...alsoFamilies.map((entry) =>
        effectiveSurface === "video"
          ? entry.videoModel
          : variantFor(entry, {
              hasFrame: Boolean(openingFrame),
              hasReferences: outgoingReferences.length > 0,
            }),
      ),
    ].filter((entry): entry is MediaModel => Boolean(entry));
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
        costCredits: quote !== undefined ? quote * 100 * (catalog.priceMultiplier ?? 1) : undefined,
        retrieve: (queueId) => ({
          path: VIDEO_RETRIEVE_PATH,
          body: retrieveBody(queueId, target.id),
        }),
        urlFields: VIDEO_URL_FIELDS,
      });
    }
  }, [
    model,
    alsoFamilies,
    effectiveSurface,
    openingFrame,
    outgoingReferences.length,
    bodyForModel,
    prompt,
    queue,
    handoff,
    quote,
    catalog.priceMultiplier,
  ]);

  /**
   * Add a reference clip: measure it, check it against what this version
   * documents, and only then keep it. Every one of those limits is reported by
   * the provider *after* a render is queued and billed, so they are checked
   * here instead - and in `reference-media`, so the phone checks the same ones.
   */
  const addReferenceClip = useCallback(
    async (dataUri: string, artifact: StudioArtifact) => {
      setClipError(undefined);
      const candidate: ReferenceMedia = {
        id: artifact.id,
        label: artifact.prompt || artifact.fileName,
        dataUri,
        seconds: await mediaSeconds(artifactSrc(artifact), "video"),
      };
      const problem = referenceClipProblem(family?.referenceModel, referenceClips, candidate);
      if (problem) {
        setClipError(problem);
        return;
      }
      setReferenceClips((current) => [...current, candidate]);
    },
    [referenceClips, family?.referenceModel],
  );

  /** Add a reference audio track, off the device. The gallery's own music and
   * speech are offered too, through the same picker as the clips. */
  const addReferenceAudio = useCallback(
    async (dataUri: string, entry: { id: string; label: string }) => {
      setAudioError(undefined);
      const candidate: ReferenceMedia = {
        ...entry,
        dataUri,
        seconds: await dataUriSeconds(dataUri, "audio"),
      };
      const problem = referenceAudioProblem(referenceAudio, candidate);
      if (problem) {
        setAudioError(problem);
        return;
      }
      setReferenceAudio((current) => [...current, candidate]);
    },
    [referenceAudio],
  );

  /** Add a reference photo, refusing the shapes the model is known to reject
   * before the render is queued rather than after it has been billed. */
  const addReference = useCallback(
    async (dataUri: string) => {
      setReferenceError(undefined);
      const problem = seedanceImageProblem(family?.referenceModel, await imageSize(dataUri));
      if (problem) {
        setReferenceError(problem);
        return;
      }
      setReferences((current) => [...current, dataUri].slice(0, referenceCap));
    },
    [family?.referenceModel, referenceCap],
  );

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
        setSurface("shot");
        if (source?.imageModel || source?.referenceModel) {
          setFamilyKey(source.key);
        } else if (source) {
          // Silently falling back to another family is how you end up wondering
          // why the continuation does not look like the shot it continues.
          setHandoffNote(
            t("{model} cannot start from an image. Pick the model to continue with.", {
              model: source.name,
            }),
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
  // Anything a provider has already refused this model for. Only fields it
  // complained about explicitly, so this can never block a valid render.
  const missingFields = useMemo(() => {
    const body = queueBody();
    return model && body ? missingRequiredFields(model.id, body) : [];
    // biome-ignore lint/correctness/useExhaustiveDependencies: the epoch tracks
    // what the last rejection taught us.
  }, [model, queueBody, constraintEpoch]);
  /** Whether everything together still fits in one request. Each input can be
   * within its own limit and the body still be over the shared cap, and the
   * backend only says so with a 413 once the render has been queued. */
  const oversize = useMemo(() => {
    const body = queueBody();
    return body ? requestSizeProblem(inlineMediaInputs(body)) : undefined;
  }, [queueBody]);
  const canSubmit =
    Boolean(queueBody()) && (!needsConsent || consent) && missingFields.length === 0 && !oversize;
  /** This variant wants the frame the clip starts from, on top of the photos.
   * The body refuses to build without it, so the button is already disabled;
   * this is what says why. */
  const needsOpeningFrame = Boolean(
    effectiveSurface === "shot" && requiresOpeningFrame(model?.id) && !openingFrame,
  );
  /** Photos were supplied but the resolved variant cannot carry them. */
  const droppedReferences = Boolean(
    effectiveSurface === "shot" &&
      outgoingReferences.length > 0 &&
      model &&
      !isReferenceToVideoModel(model.id),
  );

  const inspector = (
    <>
      {familiesForSurface.length > 1 ? (
        <StudioField
          label={t("Also render with")}
          hint={
            alsoFamilies.length > 0
              ? t("{count} renders", { count: alsoFamilies.length + 1 })
              : t("Optional")
          }
        >
          <div className="studio-upload">
            {alsoFamilies.length > 0 ? (
              <div className="studio-compare-chips">
                {alsoFamilies.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    className="studio-compare-chip"
                    aria-label={t("Stop rendering with {model}", { model: entry.name })}
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
            <MediaModelPicker
              value={null}
              placeholder={t("Add a model")}
              ariaLabel={t("Add a model to render with")}
              onChange={(key) =>
                setAlsoKeys((current) => (current.includes(key) ? current : [...current, key]))
              }
              options={familiesForSurface
                .filter((entry) => entry.key !== family?.key && !alsoKeys.includes(entry.key))
                .map(videoFamilyOption)}
            />
          </div>
        </StudioField>
      ) : null}
      {effectiveSurface === "shot" ? (
        <>
          <StudioField
            label={t("Opening frame")}
            hint={
              handoff
                ? t("Continuing at {position} of {duration}", {
                    position: formatSeconds(handoff.timeSeconds),
                    duration: formatSeconds(handoff.durationSeconds),
                  })
                : undefined
            }
          >
            <div className="studio-upload">
              {openingFrame ? (
                <img
                  src={openingFrame}
                  alt={t("Opening frame")}
                  className="studio-upload-preview"
                />
              ) : null}
              {handoff ? (
                <p className="studio-field-note">
                  {t("Handed off from {fileName}", { fileName: handoff.fileName })}
                </p>
              ) : null}
              {handoffNote ? <p className="studio-field-note">{handoffNote}</p> : null}
              {handoffError ? <p className="studio-error">{handoffError}</p> : null}
              <div className="studio-upload-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setHandoff(undefined);
                    openingInputRef.current?.click();
                  }}
                >
                  {openingFrame ? t("Replace image") : t("Choose an image")}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setPicking("opening")}
                >
                  {t("From the gallery")}
                </button>
              </div>
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
                {t("Keep the first shot's look")}
                <span className="studio-consent-meta">
                  {t(
                    "Renders with {model} so a frame from the first shot can hold the subject and lighting steady down the chain.",
                    { model: family?.referenceModel?.name ?? t("the reference model") },
                  )}
                </span>
              </span>
            </label>
          ) : null}
          {handoff ? (
            <SliderField
              label={t("Handoff point")}
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
                {t("Close the loop")}
                <span className="studio-consent-meta">
                  {t(
                    "Ends this shot on the frame the chain opened with, so the sequence plays round.",
                  )}
                </span>
              </span>
            </label>
          ) : null}
          <StudioField label={t("End frame")} hint={t("Optional")}>
            <div className="studio-upload">
              {endFrame ? (
                <img src={endFrame} alt={t("End frame")} className="studio-upload-preview" />
              ) : null}
              <div className="studio-upload-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => endInputRef.current?.click()}
                >
                  {endFrame ? t("Replace image") : t("Add an end frame")}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setPicking("end")}
                >
                  {t("From the gallery")}
                </button>
                {endFrame ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setEndFrame("")}
                  >
                    {t("Remove")}
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
      {effectiveSurface === "shot" && family?.referenceModel ? (
        <StudioField label={t("Reference photos")} hint={`${references.length} / ${referenceCap}`}>
          <div className="studio-upload">
            {references.length > 0 ? (
              <div className="studio-edit-sources">
                {references.map((reference, index) => (
                  <div key={`${index}-${reference.slice(-24)}`} className="studio-edit-source">
                    <img src={reference} alt={t("Reference {count}", { count: index + 1 })} />
                    {references.length > 1 || takesKlingReferences(family?.referenceModel) ? (
                      // The label is the name the prompt must use, so a
                      // seedance render reads "<Image 2>" here rather than a
                      // count the model would not recognise, and a kling one
                      // "@Element1" even when it is the only photo.
                      <span className="studio-edit-source-index">
                        {referenceMention(family?.referenceModel, "image", index + 1)}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="studio-edit-source-remove"
                      aria-label={t("Remove reference {count}", { count: index + 1 })}
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
            {references.length > 0 && family.referenceModel
              ? (() => {
                  // Seedance routes its workflow from the prompt and only
                  // recognises its own mention syntax, so how to name these
                  // photos is part of the input, not a nicety.
                  const mentions = references.map((_, index) =>
                    referenceMention(family.referenceModel, "image", index + 1),
                  );
                  const recipe = seedanceWorkflowsFor(family.referenceModel).find(
                    (entry) => entry.id === "reference",
                  );
                  // Kling reads its photos as elements and scene images, each
                  // with its own tag, so the tags are worth saying too.
                  if (takesKlingReferences(family.referenceModel)) {
                    return (
                      <p className="studio-hint">
                        {t(
                          "These photos steer style and subject. Name them in the prompt as {mentions}.",
                          { mentions: mentions.join(", ") },
                        )}
                      </p>
                    );
                  }
                  if (!isSeedanceModel(family.referenceModel.id)) return null;
                  return (
                    <>
                      <p className="studio-hint">
                        {t(
                          "Name them in the prompt as {mentions}, and start it with what you want done:",
                          {
                            mentions: mentions.join(", "),
                          },
                        )}
                      </p>
                      {/* Describing the opening was not enough: a prompt that
                          does not carry it verbatim routes to another workflow,
                          renders, and bills. So the button writes it. */}
                      {recipe ? (
                        <div className="studio-upload-actions">
                          <button
                            type="button"
                            className="btn btn-secondary"
                            title={recipe.description}
                            onClick={() =>
                              setPrompt((current) =>
                                current.startsWith(recipe.prefix) ? current : recipe.prefix,
                              )
                            }
                          >
                            {recipe.label}
                          </button>
                        </div>
                      ) : null}
                    </>
                  );
                })()
              : null}
            {referenceError ? <p className="studio-error">{referenceError}</p> : null}
            {references.length < referenceCap ? (
              <div className="studio-upload-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => referenceInputRef.current?.click()}
                >
                  {references.length > 0 ? t("Add another photo") : t("Choose a photo")}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setPicking("reference")}
                >
                  {t("From the gallery")}
                </button>
              </div>
            ) : null}
            <input
              ref={referenceInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(event) => {
                readInto(event.target.files?.[0], (dataUri) => void addReference(dataUri));
                event.target.value = "";
              }}
            />
          </div>
        </StudioField>
      ) : null}
      {effectiveSurface === "shot" && clipsAllowed ? (
        <StudioField
          label={t("Reference clips")}
          hint={`${referenceClips.length} / ${maxReferenceVideos(family?.referenceModel)}`}
        >
          <div className="studio-upload">
            {referenceClips.length > 0 ? (
              <ul className="studio-clip-list">
                {referenceClips.map((clip, index) => (
                  <li key={clip.id}>
                    <span className="studio-port-order-index">{index + 1}</span>
                    <span className="studio-port-order-label">{clip.label}</span>
                    <button
                      type="button"
                      className="studio-icon-button"
                      aria-label={t("Remove clip {count}", { count: index + 1 })}
                      onClick={() =>
                        setReferenceClips((current) =>
                          current.filter((entry) => entry.id !== clip.id),
                        )
                      }
                    >
                      <span aria-hidden>x</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {clipError ? <p className="studio-error">{clipError}</p> : null}
            <div className="studio-upload-actions">
              {referenceClips.length < maxReferenceVideos(family?.referenceModel) ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setPicking("clip")}
                >
                  {referenceClips.length > 0 ? t("Add another clip") : t("Choose a clip")}
                </button>
              ) : null}
            </div>
            {referenceClips.length > 0 ? (
              <>
                <p className="studio-hint">
                  {t(
                    "Name them in the prompt as {mentions}, and start it with what you want done:",
                    {
                      mentions: referenceClips
                        .map((_, index) =>
                          referenceMention(family?.referenceModel, "video", index + 1),
                        )
                        .join(", "),
                    },
                  )}
                </p>
                <div className="studio-upload-actions">
                  {seedanceWorkflowsFor(family?.referenceModel)
                    .filter((recipe) => recipe.needsClip)
                    .map((recipe) => (
                      <button
                        key={recipe.id}
                        type="button"
                        className="btn btn-secondary"
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
              </>
            ) : null}
          </div>
        </StudioField>
      ) : null}
      {effectiveSurface === "shot" && audioAllowed ? (
        <StudioField
          label={t("Reference audio")}
          hint={`${referenceAudio.length} / ${maxReferenceAudio(family?.referenceModel)}`}
        >
          <div className="studio-upload">
            {referenceAudio.length > 0 ? (
              <ul className="studio-clip-list">
                {referenceAudio.map((track, index) => (
                  <li key={track.id}>
                    <span className="studio-port-order-index">{index + 1}</span>
                    <span className="studio-port-order-label">{track.label}</span>
                    <button
                      type="button"
                      className="studio-icon-button"
                      aria-label={t("Remove track {count}", { count: index + 1 })}
                      onClick={() =>
                        setReferenceAudio((current) =>
                          current.filter((entry) => entry.id !== track.id),
                        )
                      }
                    >
                      <span aria-hidden>x</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {audioError ? <p className="studio-error">{audioError}</p> : null}
            {referenceAudio.length < maxReferenceAudio(family?.referenceModel) ? (
              <div className="studio-upload-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => audioInputRef.current?.click()}
                >
                  {referenceAudio.length > 0 ? t("Add another track") : t("Choose a track")}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setPicking("audio")}
                >
                  {t("From the gallery")}
                </button>
              </div>
            ) : null}
            <input
              ref={audioInputRef}
              type="file"
              accept="audio/*"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  readInto(file, (dataUri) => {
                    // A device file has no gallery id; its name and size stand
                    // in, so picking the same track twice is still caught.
                    void addReferenceAudio(dataUri, {
                      id: `file:${file.name}:${file.size}`,
                      label: file.name,
                    });
                  });
                }
                event.target.value = "";
              }}
            />
            {referenceAudio.length > 0 ? (
              <p className="studio-hint">
                {t(
                  "Name them in the prompt as {mentions}. A track never travels alone, so keep a photo or a clip in play.",
                  {
                    mentions: referenceAudio
                      .map((_, index) =>
                        referenceMention(family?.referenceModel, "audio", index + 1),
                      )
                      .join(", "),
                  },
                )}
              </p>
            ) : null}
          </div>
        </StudioField>
      ) : null}
      {effectiveSurface === "video" ? (
        <>
          <StudioField label={t("Source clip")} hint={sourceVideoName || undefined}>
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
                {sourceVideo ? t("Replace clip") : t("Choose a clip")}
              </button>
              {galleryVideos.length > 0 ? (
                <Select
                  value={null}
                  placeholder={t("Or pick from your gallery")}
                  ariaLabel={t("Pick a gallery clip")}
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
            <StudioField label={t("Upscale")} hint={t("x1 enhances without resizing")}>
              <PillGroup
                options={[
                  { value: "1", label: "x1" },
                  { value: "2", label: "x2" },
                  { value: "4", label: "x4" },
                ]}
                value={upscaleFactor}
                onChange={setUpscaleFactor}
                ariaLabel={t("Upscale factor")}
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
            {t(
              "I have the right to use this media and accept the model's face-media policy for anyone shown in it.",
            )}
            <span className="studio-consent-meta">
              {personMediaCaveat ??
                t("Seedance requires this before it will build a clip from a photo of a person.")}
            </span>
          </span>
        </label>
      ) : null}
      <StudioField label={t("Negative prompt")}>
        <textarea
          className="studio-textarea"
          rows={2}
          value={negativePrompt}
          placeholder={t("What to avoid (optional)")}
          onChange={(event) => setNegativePrompt(event.target.value)}
        />
      </StudioField>
    </>
  );

  /** Why the round button cannot be pressed, and what unblocks it. */
  const blocker: DockBlocker | undefined = needsOpeningFrame
    ? {
        text: t(
          "{model} starts from a frame, so it needs an opening frame as well as its reference photos. The photos steer the look from there.",
          { model: family?.name ?? t("This model") },
        ),
        actions: [
          {
            label: t("Choose an image"),
            onAction: () => {
              setHandoff(undefined);
              openingInputRef.current?.click();
            },
          },
          { label: t("From the gallery"), onAction: () => setPicking("opening") },
        ],
      }
    : missingFields.length > 0
      ? {
          text: t("This model needs {fields} before it will render.", {
            fields: missingFields.map((field) => field.replace(/_/g, " ")).join(", "),
          }),
        }
      : oversize
        ? { text: oversize }
        : needsConsent && !consent
          ? {
              text: t(
                "I have the right to use this media and accept the model's face-media policy for anyone shown in it.",
              ),
              actions: [
                {
                  label: t("Accept"),
                  onAction: () => {
                    setConsent(true);
                    rememberSeedanceConsent(true);
                  },
                },
              ],
            }
          : undefined;

  // The scene: the render on its way (the newest one still running), else
  // the last clip made here, else the frame the next one opens on.
  const running = queue.jobs.filter((entry) => entry.phase !== "failed");
  const failed = queue.jobs.filter((entry) => entry.phase === "failed");
  const onScene = running[0];
  const sceneWait = onScene
    ? {
        seed: onScene.job.id + onScene.job.prompt,
        phase: onScene.phase === "failed" ? ("processing" as const) : onScene.phase,
        startedAt: Date.now() - onScene.elapsedMs,
        estimateMs: estimates.get(onScene.job.model),
      }
    : undefined;
  const sceneResult: StageResult | undefined =
    lastResult ??
    (effectiveSurface === "shot" && openingFrame
      ? { kind: "image", src: openingFrame, alt: t("Opening frame") }
      : undefined);

  const scene = (
    <StageScene
      aspect={effectiveAspect || "16:9"}
      result={sceneResult}
      wait={sceneWait}
      waitLabel={t("Rendering")}
      reveal={reveal}
      onRevealEnd={() => setReveal(false)}
      idle={{
        seed: "video",
        hint:
          effectiveSurface === "video"
            ? t("Pick a clip to transform. The result will play here.")
            : t("Describe a shot. It will play here."),
      }}
    />
  );

  const attachments =
    effectiveSurface === "shot" && (openingFrame || references.length > 0) ? (
      <ul className="studio-desk-attachments" aria-label={t("Inputs")}>
        {openingFrame ? (
          <li>
            <img src={openingFrame} alt={t("Opening frame")} />
            <button
              type="button"
              className="studio-desk-attachment-remove"
              aria-label={t("Remove the opening frame")}
              onClick={() => {
                setHandoff(undefined);
                setOpeningFrame("");
              }}
            >
              <span aria-hidden>x</span>
            </button>
          </li>
        ) : null}
        {references.map((reference, index) => (
          // The same photo can be picked twice; its place is its identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
          <li key={`${index}-${reference.slice(-24)}`}>
            <img src={reference} alt={t("Reference {count}", { count: index + 1 })} />
            <span className="studio-desk-attachment-tag">
              {referenceMention(family?.referenceModel, "image", index + 1)}
            </span>
            <button
              type="button"
              className="studio-desk-attachment-remove"
              aria-label={t("Remove reference {count}", { count: index + 1 })}
              onClick={() => setReferences((current) => current.filter((_, i) => i !== index))}
            >
              <span aria-hidden>x</span>
            </button>
          </li>
        ))}
      </ul>
    ) : null;

  const dock = (
    <Dock>
      <DockComposer
        value={prompt}
        onChange={setPrompt}
        placeholder={
          effectiveSurface === "video"
            ? isUpscale
              ? t("Optional note for the upscaler")
              : t("Describe how to restyle the clip")
            : openingFrame
              ? t("Describe the motion")
              : references.length > 0
                ? t("Describe the scene to build from the references")
                : t("Describe the scene and the motion")
        }
        ariaLabel={t("Prompt")}
        cost={quoteCredits}
        canSend={canSubmit}
        onSend={start}
        sendLabel={t("Generate video")}
        blocker={blocker}
        tools={
          <>
            <ModelPickerChip
              label={t("Video model")}
              selectedId={family?.key ?? ""}
              entries={familiesForSurface.map((entry) =>
                videoFamilyEntry(entry, videoFamilyOption(entry).details),
              )}
              filters={effectiveSurface === "shot" ? videoDirectionFilters() : undefined}
              initialFilter={
                references.length > 0 || referenceClips.length > 0
                  ? "reference"
                  : openingFrame
                    ? "image"
                    : undefined
              }
              onSelect={setFamilyKey}
            />
            {durationOptions.length > 0 ? (
              <DockSelectChip
                label={t("Duration")}
                value={effectiveDuration}
                options={durationOptions}
                onChange={setDuration}
              />
            ) : null}
            {aspectOptions.length > 0 ? (
              <DockSelectChip
                label={t("Aspect ratio")}
                value={effectiveAspect}
                options={aspectOptions}
                onChange={setAspectRatio}
              />
            ) : null}
            {resolutionOptions.length > 0 ? (
              <DockSelectChip
                label={t("Resolution")}
                value={effectiveResolution}
                options={resolutionOptions}
                onChange={setResolution}
                format={formatResolution}
              />
            ) : null}
          </>
        }
      >
        {attachments}
        {model && variantHint(family, model) ? (
          <p className="stage-dock-hint studio-desk-variant">{variantHint(family, model)}</p>
        ) : null}
        {promptAdvice ? <p className="stage-dock-hint">{promptAdvice}</p> : null}
        {droppedReferences ? (
          <p className="stage-dock-hint">
            {t("{model} cannot take reference photos, so only the opening frame will be used.", {
              model: family?.name ?? t("This model"),
            })}
          </p>
        ) : null}
      </DockComposer>
    </Dock>
  );

  const notices =
    failed.length > 0 || running.length > 1 || continuingId || (handoffError && !openingFrame) ? (
      <div className="studio-desk-notices">
        {continuingId ? (
          <p className="stage-notice" role="status">
            {t("Reading the last frame of that clip.")}
          </p>
        ) : null}
        {handoffError && !openingFrame ? (
          <p className="stage-notice" data-tone="error" role="alert">
            {handoffError}
          </p>
        ) : null}
        {running.length > 1
          ? running.slice(1).map((entry) => (
              <div key={entry.job.id} className="stage-notice">
                <span>
                  {t("Rendering")} · {entry.job.model}
                  {entry.job.prompt ? ` · "${entry.job.prompt.slice(0, 48)}"` : ""}
                </span>
                <button
                  type="button"
                  className="stage-dock-action"
                  onClick={() => queue.stop(entry.job.id)}
                >
                  {t("Stop waiting")}
                </button>
              </div>
            ))
          : null}
        {failed.map((entry) => {
          // A constraint error names the field to fix and is the most useful
          // thing we can say, so it wins. Everything else goes through the
          // failure reader, which turns a backend's own vocabulary into
          // something to do next.
          const constraint = explainConstraintError(entry.message ?? "");
          const failure = constraint
            ? undefined
            : describeJobFailure({
                message: entry.message,
                status: entry.status,
                model: entry.job.model,
              });
          return (
            <div key={entry.job.id} className="stage-notice" data-tone="error" role="alert">
              {/* The backend's own words stay reachable on hover: the summary
               * is for acting on, the detail is for reporting. */}
              <span title={failure?.detail}>
                {constraint ?? failure?.text ?? t("The render failed.")}
                {" · "}
                {entry.job.model}
              </span>
              <span className="studio-card-actions">
                {failure?.retryable && entry.canRetry ? (
                  <button
                    type="button"
                    className="stage-dock-action"
                    onClick={() => void queue.retry(entry.job.id)}
                  >
                    {t("Start again")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="stage-dock-action"
                  onClick={() => queue.dismiss(entry.job.id)}
                >
                  {t("Dismiss")}
                </button>
              </span>
            </div>
          );
        })}
      </div>
    ) : undefined;

  return (
    <>
      <StudioDesk
        tools={
          availableSurfaces.length > 1 ? (
            <DeskTools
              value={effectiveSurface}
              onChange={(value) => {
                setSurface(value);
                setFamilyKey("");
              }}
              label={t("What to build")}
              options={availableSurfaces.map((entry) => ({
                value: entry,
                label: entry === "shot" ? t("New shot") : t("From video"),
              }))}
            />
          ) : undefined
        }
        scene={
          <>
            {scene}
            {onScene ? (
              <div className="studio-desk-scene-actions">
                <button
                  type="button"
                  className="stage-dock-action"
                  onClick={() => queue.stop(onScene.job.id)}
                >
                  {t("Stop waiting")}
                </button>
              </div>
            ) : null}
          </>
        }
        notice={notices}
        dock={dock}
        inspector={inspector}
        strip={
          <>
            {activeChain.length > 1 ? (
              <section className="studio-chain" aria-label={t("Shot chain")}>
                <div className="studio-chain-head">
                  <span className="studio-field-label">
                    {t("Shot chain · {count} shots", { count: activeChain.length })}
                    {chainSpend.known > 0
                      ? ` · ${chainSpend.known < chainSpend.total ? t("at least ") : ""}${formatCredits(chainSpend.credits)}`
                      : ""}
                  </span>
                  {onAssembleChain ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => onAssembleChain(chainCuts(activeChain))}
                    >
                      {t("Send to assemble")}
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
                        <span
                          className="studio-chain-index"
                          title={t("Other takes continue from this shot")}
                        >
                          +{alternativeCount(shot, activeChain, videoArtifacts)}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
                <p className="studio-field-note">
                  {t(
                    "Each shot is cut where the next one took over, so the seam is not played twice.",
                  )}
                </p>
              </section>
            ) : null}
            <Filmstrip
              kinds={["video"]}
              epoch={galleryEpoch}
              pending={running.length}
              onArtifactsChanged={setVideoArtifacts}
              onOpenGallery={onOpenGallery}
              onReusePrompt={(artifact) => setPrompt(artifact.prompt)}
              onContinue={(artifact) => void continueFrom(artifact)}
            />
          </>
        }
      />
      {picking ? (
        <GalleryPicker
          onClose={() => setPicking(undefined)}
          kinds={picking === "clip" ? CLIP_KINDS : picking === "audio" ? AUDIO_KINDS : undefined}
          title={
            picking === "clip"
              ? t("Pick a clip")
              : picking === "audio"
                ? t("Pick a track")
                : undefined
          }
          description={
            picking === "clip"
              ? t(
                  "Pick a clip to edit, extend or stitch. It travels with the request, so keep it short.",
                )
              : picking === "audio"
                ? t(
                    "Pick a track for the render to follow. It travels with the request, so keep it short.",
                  )
                : picking === "reference"
                  ? t(
                      "Pick an image you have already produced. It steers style and subject, alongside the opening frame.",
                    )
                  : t("Pick an image you have already produced.")
          }
          onPick={(dataUri, artifact, entry) => {
            // A face picked out of the bible brings its traits with it. Nothing
            // carries over between separately generated clips, so restating
            // "green coat, scar over the left brow" on this shot is the whole
            // difference between a character and a resemblance. Appended once:
            // a prompt that already says it is left alone.
            if (entry) setPrompt((current) => withInvariant(current, entry));
            if (picking === "clip") {
              void addReferenceClip(dataUri, artifact);
              return;
            }
            if (picking === "audio") {
              void addReferenceAudio(dataUri, {
                id: artifact.id,
                label: artifact.prompt || artifact.fileName,
              });
              return;
            }
            if (picking === "opening") {
              // Same reset the file input does: the handoff describes a frame
              // read out of a clip, and it would otherwise keep captioning a
              // picture it has nothing to do with - and overwrite it on the
              // next drag of the handoff slider.
              setHandoff(undefined);
              setOpeningFrame(dataUri);
            } else if (picking === "end") {
              setEndFrame(dataUri);
            } else {
              void addReference(dataUri);
            }
          }}
        />
      ) : null}
    </>
  );
}
