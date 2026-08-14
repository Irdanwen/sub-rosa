/**
 * The request body for one video render, from the inputs the user filled in.
 *
 * Pure and shared, for two reasons. It is where the awkward knowledge lives -
 * which fields a variant carries, which ones a provider rejects when missing,
 * which ones it rejects when unknown - and that knowledge was previously
 * duplicated in the desktop studio and the mobile panel, which is how the two
 * drift apart. And it is the part worth testing: a wrong body is only found
 * out after a render has been queued.
 *
 * The inputs are cumulative rather than exclusive. An opening frame and
 * reference photos can be supplied together; only the reference-to-video
 * contract carries both, so the caller resolves the variant first (see
 * `variantFor`) and this fills the body that variant accepts.
 */

import {
  isImageToVideoModel,
  isReferenceToVideoModel,
  isSeedanceModel,
  isVideoUpscaleModel,
} from "./catalog";
import { withSeedanceConsent } from "./consent";
import { effectiveVideoConstraints } from "./model-constraints";
import { maxReferenceAudio, maxReferenceVideos, maxVideoReferences } from "./seedance";
import type { MediaModel } from "./types";

/** Keeps a chosen value valid against the options a model actually offers,
 * falling back to its first one. Mirrors the studio's own picker behaviour. */
function pick(options: readonly string[], selected: string): string {
  if (options.length === 0) return "";
  return options.includes(selected) ? selected : options[0];
}

export interface VideoRequestInputs {
  /** The resolved variant this body is for. */
  target: MediaModel;
  prompt: string;
  negativePrompt?: string;
  /** Frame the clip starts from. */
  openingFrame?: string;
  /** Frame the clip should end on, for the models that accept one. */
  endFrame?: string;
  /** Style/subject photos, the chain's anchor frame included. */
  references?: string[];
  /**
   * Reference *clips* — what the seedance edit, extend and stitch workflows
   * work from. Data URIs like every other media input here; the prompt names
   * them `<Video 1>`, `<Video 2>` in this order.
   */
  referenceVideos?: string[];
  /** Their durations in seconds, so a quote matches what the queue bills. */
  referenceVideoSeconds?: number[];
  /** Reference audio (timbre, voice), which the contract forbids as the only
   * reference — it must ride with an image or a clip. */
  referenceAudio?: string[];
  /** Source clip, for the restyle/upscale surface. */
  sourceVideo?: string;
  upscaleFactor?: number;
  duration?: string;
  aspectRatio?: string;
  resolution?: string;
  /** Whether the face-media attestation has been given. */
  consent?: boolean;
}

/**
 * The body, or undefined when the inputs cannot make a valid render (no
 * prompt, or a variant with nothing to work from). Returning undefined is what
 * keeps the submit button honest instead of discovering it upstream.
 */
export function videoRequestBody(inputs: VideoRequestInputs): Record<string, unknown> | undefined {
  const {
    target,
    prompt,
    negativePrompt,
    openingFrame,
    endFrame,
    references = [],
    referenceVideos = [],
    referenceVideoSeconds = [],
    referenceAudio = [],
    sourceVideo,
    upscaleFactor,
    duration,
    aspectRatio,
    resolution,
    consent,
  } = inputs;

  const upscale = isVideoUpscaleModel(target.id);
  // Upscaling needs no prompt; everything else does.
  if (!prompt.trim() && !upscale) return undefined;

  const body: Record<string, unknown> = { model: target.id };
  if (prompt.trim()) body.prompt = prompt.trim();
  if (negativePrompt?.trim()) body.negative_prompt = negativePrompt.trim();

  if (upscale) {
    if (!sourceVideo) return undefined;
    // The upscaler contract: source clip + factor, duration "Auto".
    body.video_url = sourceVideo;
    body.upscale_factor = upscaleFactor ?? 2;
    body.duration = "Auto";
    return body;
  }

  const constraints = effectiveVideoConstraints(target);
  const pickedDuration = pick(constraints.durations ?? [], duration ?? "");
  const pickedAspect = pick(constraints.aspect_ratios ?? [], aspectRatio ?? "");
  const pickedResolution = pick(constraints.resolutions ?? [], resolution ?? "");
  // A known option list means the field exists on this model, so it is always
  // sent - leaving it out is what several providers reject. No list means
  // nobody knows the field applies, and an unrecognised key fails just as
  // hard, so it stays out until a rejection teaches us otherwise.
  if (pickedDuration) body.duration = pickedDuration;
  if (pickedAspect) body.aspect_ratio = pickedAspect;
  if (pickedResolution) body.resolution = pickedResolution;

  if (isVideoToVideoModel(target.id)) {
    if (!sourceVideo) return undefined;
    body.video_url = sourceVideo;
    return body;
  }

  const takesReferences = isReferenceToVideoModel(target.id);
  if (openingFrame) body.image_url = openingFrame;
  if (endFrame) body.end_image_url = endFrame;
  if (takesReferences && references.length > 0) {
    body.reference_image_urls = references.slice(0, maxVideoReferences(target));
  }

  // Reference clips and audio, capped at what this model publishes: both caps
  // are zero on a model that declares no such input, so an input a surface
  // should not have offered is dropped here rather than queued and refused.
  // Audio may never be the only reference, so it is dropped rather than sent
  // alone - the request would be refused.
  const clips = referenceVideos.slice(0, maxReferenceVideos(target));
  if (clips.length > 0) {
    body.reference_video_urls = clips;
    const seconds = referenceVideoSeconds.slice(0, clips.length);
    // The quote only matches the queue charge when it is told the combined
    // length; sending it on the queue body too keeps the two in step.
    if (seconds.length === clips.length && seconds.every((value) => Number.isFinite(value))) {
      body.reference_video_total_duration = Math.round(
        seconds.reduce((total, value) => total + value, 0),
      );
    }
  }
  const hasOtherReference = clips.length > 0 || (takesReferences && references.length > 0);
  const audioCap = maxReferenceAudio(target);
  if (audioCap > 0 && referenceAudio.length > 0 && hasOtherReference) {
    body.reference_audio_urls = referenceAudio.slice(0, audioCap);
  }

  // A variant that exists to work from a photo cannot run without one.
  const hasVisualInput =
    Boolean(openingFrame) || (takesReferences && references.length > 0) || clips.length > 0;
  if (!hasVisualInput && (takesReferences || isImageToVideoModel(target.id))) return undefined;

  // Only the seedance targets carry the face-media attestation, and only for a
  // render actually built from media that could show a person - a clip as much
  // as a photo.
  const fromFaceMedia = Boolean(openingFrame) || references.length > 0 || clips.length > 0;
  return fromFaceMedia && consent && isSeedanceModel(target.id) ? withSeedanceConsent(body) : body;
}

/** Every field of a queue body that carries media inline. */
const INLINE_MEDIA_FIELDS = [
  "image_url",
  "end_image_url",
  "video_url",
  "reference_image_urls",
  "reference_video_urls",
  "reference_audio_urls",
] as const;

/**
 * The inline media a body is about to carry, ready to be measured.
 *
 * Sub Rosa has nowhere to host media, so every input travels as a data URI in
 * the request itself and the whole body shares one size ceiling. Checking any
 * single input against it misses the case that actually happens: a frame, five
 * references and a track that are each fine and together are not. Reading the
 * finished body is the only way to see all of them, which is why this lives
 * next to the builder rather than in each surface.
 */
export function inlineMediaInputs(body: Record<string, unknown>): string[] {
  const inputs: string[] = [];
  for (const field of INLINE_MEDIA_FIELDS) {
    const value = body[field];
    if (typeof value === "string") inputs.push(value);
    else if (Array.isArray(value)) {
      for (const entry of value) if (typeof entry === "string") inputs.push(entry);
    }
  }
  return inputs;
}

function isVideoToVideoModel(modelId: string): boolean {
  return modelId.toLowerCase().includes("video-to-video");
}
