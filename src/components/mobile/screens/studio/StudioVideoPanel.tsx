import { t } from "../../../../lib/i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { hapticNotify } from "../../../../lib/haptics";
import { registerDownloadedArtifact } from "../../../../lib/studio/artifacts";
import { useMediaJob } from "../../../../lib/studio/async-job";
import {
  formatCredits,
  isReferenceToVideoModel,
  isSeedanceModel,
  requiresOpeningFrame,
  variantFor,
  variantHint,
  videoFamilies,
  videoFamilySearchTerms,
} from "../../../../lib/studio/catalog";
import { mediaJson } from "../../../../lib/studio/client";
import {
  hasSeedanceConsent,
  needsSeedanceConsent,
  rememberSeedanceConsent,
} from "../../../../lib/studio/consent";
import { imageSize } from "../../../../lib/studio/downscale";
import {
  effectiveVideoConstraints,
  rememberConstraintError,
} from "../../../../lib/studio/model-constraints";
import {
  retrieveBody,
  supportsVideoQuote,
  VIDEO_QUEUE_PATH,
  VIDEO_QUOTE_PATH,
  VIDEO_RETRIEVE_PATH,
} from "../../../../lib/studio/paths";
import {
  referenceAudioProblem,
  referenceClipProblem,
  type ReferenceMedia,
} from "../../../../lib/studio/reference-media";
import { estimateRenderMs, renderEtaKey } from "../../../../lib/studio/render-eta";
import {
  maxReferenceAudio,
  maxReferenceVideos,
  maxVideoReferences,
  referenceMention,
  requestSizeProblem,
  seedanceImageProblem,
  seedancePersonMediaCaveat,
  seedancePromptAdvice,
  seedanceWorkflowsFor,
  takesReferenceAudio,
  takesReferenceClips,
} from "../../../../lib/studio/seedance";
import type { MediaCatalog, StudioArtifact } from "../../../../lib/studio/types";
import { inlineMediaInputs, videoRequestBody } from "../../../../lib/studio/video-request";
import { Darkroom } from "../../../studio/Darkroom";
import { JobFailureNotice } from "../../../studio/JobFailureNotice";
import { Spinner } from "../../../ui/Spinner";
import { Switch } from "../../../ui/Switch";
import { ModelSheet } from "../../ModelSheet";
import { ModelPickerButton } from "./StudioControls";
import { MediaReferencePicker, ReferencePicker } from "./StudioLightbox";

/** Where the finished clip's URL hides in the retrieve body. */
const VIDEO_URL_FIELDS = ["video_url", "url"];

/** A frame handed off from a finished clip, waiting to open the next shot. */
export interface VideoHandoff {
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

/**
 * Making a clip.
 *
 * The most demanding form in the app: a family rather than a model, four
 * directions (text, image, reference, continuation), per-family durations, and
 * a consent gate for the families that need one.
 */
export function VideoPanel({
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
  const [_constraintEpoch, setConstraintEpoch] = useState(0);
  const constraints = useMemo(
    () => effectiveVideoConstraints(model),
    // biome-ignore lint/correctness/useExhaustiveDependencies: the epoch is the
    // signal that a rejection taught us new options.
    [model],
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
  /** The same three phases, narrowed, so the darkroom can read the clock off
   * the ones that have one. */
  const waiting =
    job.state.phase === "queueing" ||
    job.state.phase === "queued" ||
    job.state.phase === "processing"
      ? job.state
      : undefined;
  const estimate = useMemo(() => estimateRenderMs(renderEtaKey("video", model?.id)), [model?.id]);

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
        label={t("Video model")}
        value={family?.name ?? ""}
        hint={variantHint(family, model)}
        onOpen={() => setPickerOpen(true)}
      />
      {durationOptions.length > 0 ? (
        <div className="mobile-pill-row" role="radiogroup" aria-label={t("Duration")}>
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
        <div className="mobile-pill-row" role="radiogroup" aria-label={t("Aspect ratio")}>
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
        <div className="mobile-pill-row" role="radiogroup" aria-label={t("Resolution")}>
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
              ? t("Continuing {name} at {position}s of {duration}s.", {
                  name: handoffFrom.fileName,
                  position: Math.round(handoffFrom.timeSeconds * 10) / 10,
                  duration: Math.round(handoffFrom.durationSeconds * 10) / 10,
                })
              : t("Optional opening frame: the clip starts from this photo.")
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
                ? t(
                    "These photos steer style and subject. Name them in the prompt as {mentions}.",
                    {
                      mentions: references
                        .map((_, index) =>
                          referenceMention(family.referenceModel, "image", index + 1),
                        )
                        .join(", "),
                    },
                  )
                : t("These photos steer the style and subject, alongside the opening frame.")
              : t(
                  "Optional reference photos: they steer style and subject while the prompt drives the action.",
                )
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
              ? t("Name them in the prompt in this order, and start it with what you want done.")
              : t(
                  "Optional clips to edit, extend or stitch. They travel with the request, so keep them short.",
                )
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
              ? t("A track never travels alone, so keep a photo or a clip in play.")
              : t("Optional audio for the render to follow, alongside a photo or a clip.")
          }
        />
      ) : null}
      <textarea
        className="mobile-studio-prompt"
        value={prompt}
        rows={3}
        placeholder={
          openingFrame.length > 0
            ? t("Describe the motion")
            : references.length > 0
              ? t("Describe the scene to build from the reference")
              : t("Describe the video to generate")
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
        placeholder={t("Negative prompt (optional)")}
        aria-label={t("Negative prompt")}
        onChange={(event) => setNegativePrompt(event.target.value)}
      />
      {needsConsent ? (
        <div className="mobile-toggle-row mobile-studio-consent">
          <Switch
            checked={consent}
            aria-label={t("I have the right to use this media")}
            onCheckedChange={(next) => {
              setConsent(next);
              rememberSeedanceConsent(next);
            }}
          />
          <span>
            {t(
              "I have the right to use this media and accept this model's face-media policy for anyone shown in it.",
            )}
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
        {busy ? <Spinner /> : t("Generate")}
        {!busy && quote !== undefined ? (
          <span className="mobile-studio-cost">{formatCredits(quote)}</span>
        ) : null}
      </button>
      {references.length > 0 && model && !isReferenceToVideoModel(model.id) ? (
        <p className="mobile-reference-hint">
          {t("{model} cannot take reference photos, so only the opening frame will be used.", {
            model: family?.name ?? t("This model"),
          })}
        </p>
      ) : null}
      {requiresOpeningFrame(model?.id) && !openingFrame ? (
        // The body refuses to build without it, so Generate is already
        // disabled; this says why rather than leaving a dead button.
        <p className="mobile-dictation-error">
          {t(
            "{model} starts from a frame, so it needs an opening frame as well as its reference photos.",
            { model: family?.name ?? t("This model") },
          )}
        </p>
      ) : null}
      {waiting ? (
        <Darkroom
          compact
          seed={`${model?.id ?? ""}${prompt}`}
          phase={waiting.phase}
          elapsedMs={waiting.phase === "queueing" ? undefined : waiting.elapsedMs}
          estimateMs={estimate}
          aspectRatio={effectiveVideoAspect}
          meta={t("You can leave this tab; the job resumes.")}
        />
      ) : null}
      {job.state.phase === "failed" ? (
        <JobFailureNotice
          message={job.state.message}
          status={job.state.status}
          model={model?.id}
          className="mobile-dictation-error"
          retryClassName="mobile-chip-button"
          onRetry={job.canRetry ? job.retry : undefined}
        />
      ) : null}
      {pickerOpen ? (
        <ModelSheet
          title={t("Video model")}
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
