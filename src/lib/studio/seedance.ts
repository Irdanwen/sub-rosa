/**
 * What the seedance family expects of its reference inputs.
 *
 * Seedance's reference-to-video contract is unlike every other family's: the
 * *prompt* is what routes the request. The model reads canonical mentions —
 * `<Image 1>`, `<Video 1>`, `<Audio 1>`, case-sensitive, spaces included — and
 * a leading phrase decides which of four workflows runs (reference a donor,
 * strictly edit a clip, extend a clip, stitch clips together). Get the wording
 * wrong and the request does not fail: it silently runs the wrong workflow and
 * bills for it. So the wording is knowledge, and it belongs here rather than
 * in a placeholder string in one surface.
 *
 * Verified against Venice's Seedance 2.0 guide (docs.venice.ai, read
 * 2026-08-14). Anything version-specific is keyed off the model id, because
 * the same family ships 2.0, 2.0-fast and 2.5 with different limits.
 */

import { isReferenceToVideoModel, isSeedanceModel } from "./catalog";
import type { MediaModel } from "./types";

/** The kinds of media a seedance prompt can address. */
export type ReferenceKind = "image" | "video" | "audio";

/** How many reference photos a model's contract accepts.
 *
 * Not one number: seedance 2.0 takes 9 and 2.5 takes 30, while every other
 * family in the catalog is happy with a handful. The default stays low on
 * purpose — each reference inflates the request and their influence thins
 * out — but a family that documents more should not be capped at our default.
 */
export function maxVideoReferences(model: Pick<MediaModel, "id"> | undefined): number {
  const id = model?.id.toLowerCase() ?? "";
  if (!id.includes("seedance")) return 4;
  if (id.includes("seedance-2-5")) return 30;
  if (id.includes("seedance-2-0")) return 9;
  // Older seedance (1.5) publishes no figure; keep the conservative default.
  return 4;
}

/** A model reference media is decided for: the id is always needed, the
 * published constraints are used when the caller has them. */
type ReferenceMediaModel = Pick<MediaModel, "id"> & Partial<Pick<MediaModel, "constraints">>;

/**
 * A seedance reference-to-video variant.
 *
 * This is what the family's *prompt* contract keys off: the canonical mentions
 * and the four prompt-routed workflows apply to these variants and to no others,
 * whatever media they happen to accept.
 */
export function isSeedanceReferenceModel(model: ReferenceMediaModel | undefined): boolean {
  return Boolean(model && isSeedanceModel(model.id) && isReferenceToVideoModel(model.id));
}

/**
 * Whether this model takes reference *clips* (`reference_video_urls`) — the
 * input the edit, extend and stitch workflows work from.
 *
 * Answered from the operator's published constraints first, and only then from
 * the id. That order matters: reading the id alone is what put a clip slot in
 * front of models that refuse clips outright. Every public `-basic` reference
 * variant publishes `video_input: false` while its family's guide describes the
 * clip workflows at length, so the guide is about the full tier and the id says
 * nothing about which tier is in hand.
 *
 * A published flag is an answer, in both directions. An *absent* flag means
 * nobody said - the full seedance ids publish only their option lists - and
 * then the id decides, minus the `-basic` variants we have measured.
 */
export function takesReferenceClips(model: ReferenceMediaModel | undefined): boolean {
  const published = model?.constraints?.video_input;
  if (typeof published === "boolean") return published;
  return isSeedanceReferenceModel(model) && !isBasicVariant(model);
}

/**
 * Whether this model takes reference *audio* (`reference_audio_urls`) — a
 * timbre or a voice for the render to follow.
 *
 * Same rule as the clips, and it lands the other way round: the `-basic`
 * reference variants publish `audio_input: true`. Audio may never be the only
 * reference (see `videoRequestBody`), so this permits an input, it does not
 * make one sufficient.
 */
export function takesReferenceAudio(model: ReferenceMediaModel | undefined): boolean {
  const published = model?.constraints?.audio_input;
  if (typeof published === "boolean") return published;
  return isSeedanceReferenceModel(model);
}

/** The public tier. Its ids end in `-basic`, and what separates it from the
 * full tier is exactly what the surfaces get wrong: no reference clips, and no
 * person-bearing media whatever is attested (see `seedancePersonMediaCaveat`). */
function isBasicVariant(model: ReferenceMediaModel | undefined): boolean {
  return Boolean(model?.id.toLowerCase().endsWith("-basic"));
}

/** How many reference media of one kind a version documents. Not one number:
 * seedance 2.5 raised every reference ceiling its predecessors set. */
function perVersionCap(model: ReferenceMediaModel | undefined): number {
  return model?.id.toLowerCase().includes("seedance-2-5") ? 10 : 3;
}

/** Reference clips (`reference_video_urls`), for the models that take them. */
export function maxReferenceVideos(model: ReferenceMediaModel | undefined): number {
  return takesReferenceClips(model) ? perVersionCap(model) : 0;
}

/** Reference audio (`reference_audio_urls`), for the models that take it. No
 * figure is published for audio specifically, so it keeps the clip ceiling:
 * conservative, and the mention syntax (`<Audio 1>`, `<Audio 2>`) is the same. */
export function maxReferenceAudio(model: ReferenceMediaModel | undefined): number {
  return takesReferenceAudio(model) ? perVersionCap(model) : 0;
}

/** Combined duration of the reference clips, in seconds. */
export function maxReferenceVideoSeconds(model: Pick<MediaModel, "id"> | undefined): number {
  return model?.id.toLowerCase().includes("seedance-2-5") ? 30 : 15;
}

/**
 * How to name a reference inside a prompt.
 *
 * Seedance wants `<Image 1>`; everything else has no documented syntax at all,
 * so plain positional prose ("image 1") is the honest fallback — it reads
 * naturally to any instruction-following model without pretending a contract
 * exists. Indexes are 1-based, matching what the numbering shows on screen.
 */
export function referenceMention(
  model: Pick<MediaModel, "id"> | undefined,
  kind: ReferenceKind,
  index: number,
): string {
  const position = Math.max(1, Math.trunc(index));
  if (!model || !isSeedanceModel(model.id)) {
    return `${kind} ${position}`;
  }
  const label = kind === "image" ? "Image" : kind === "video" ? "Video" : "Audio";
  return `<${label} ${position}>`;
}

/**
 * What the face-media attestation actually buys on this model.
 *
 * The public `-basic` seedance variants do not carry consent attestation at
 * all: media with a detectable person is refused by content policy whatever
 * the caller attests (Venice's guide is explicit, and points at the Venice app
 * or Studio for the full feature set). The attestation still rides along —
 * it is optional in the schema and harmless where it is not read — but the
 * checkbox must not promise what it cannot deliver, so surfaces show this
 * next to it. Returns undefined where the attestation does work.
 */
export function seedancePersonMediaCaveat(
  model: Pick<MediaModel, "id"> | undefined,
): string | undefined {
  const id = model?.id.toLowerCase() ?? "";
  if (!id.includes("seedance") || !id.endsWith("-basic")) return undefined;
  return "This public model refuses photos with a recognisable person whatever you attest, so use photos of places, objects or scenes here.";
}

/** The four workflows a seedance reference prompt can route to. */
export type SeedanceWorkflow = "reference" | "edit" | "extend" | "stitch";

export interface SeedanceWorkflowRecipe {
  id: SeedanceWorkflow;
  label: string;
  /** What it does, in the user's terms. */
  description: string;
  /** What the prompt must open with for the router to pick this workflow. */
  prefix: string;
  /** A complete example prompt, ready to edit. */
  example: string;
  /** Whether the workflow needs at least one reference clip. */
  needsClip: boolean;
}

/**
 * The canonical openings, verbatim from the guide. These are not suggestions:
 * the guide lists "workflow misrouting" as its most common failure and points
 * at exactly these prefixes as the fix.
 */
export const SEEDANCE_WORKFLOWS: SeedanceWorkflowRecipe[] = [
  {
    id: "reference",
    label: "Reference",
    description:
      "Generate a new shot that borrows a subject, style or object from what you give it.",
    prefix: "Refer to <Subject 1> in <Image 1> to generate ",
    example:
      "Refer to <Subject 1> in <Image 1> to generate a 5 second clip of the same character walking through a neon-lit street at night.",
    needsClip: false,
  },
  {
    id: "edit",
    label: "Edit a clip",
    description: "Change one thing in a clip and keep everything else — motion, framing, timing.",
    prefix: "Strictly edit <Video 1>, changing its ",
    example:
      "Strictly edit <Video 1>, changing its weather from sunny to a heavy rainstorm, with all original motions and camera work preserved.",
    needsClip: true,
  },
  {
    id: "extend",
    label: "Extend a clip",
    description: 'Carry a clip on past its end (or before its start, with "backward").',
    prefix: "Extend <Video 1>, generate ",
    example:
      "Extend <Video 1>, generate a dramatic chase through narrow alleys at dusk, neon signs flickering.",
    needsClip: true,
  },
  {
    id: "stitch",
    label: "Stitch clips",
    description: "Join clips with a transition the model generates between them.",
    prefix: "<Video 1> + ",
    example: "<Video 1> + a wisp of smoke turns into a flock of birds + followed by <Video 2>",
    needsClip: true,
  },
];

/**
 * The workflows this model can actually run.
 *
 * Offering an opening a model cannot honour is worse than offering none: the
 * prompt is what routes, so "Extend <Video 1>" on a variant that takes no clips
 * does not fail, it renders something else and bills for it. So the three
 * clip-driven recipes are withheld from the variants that publish no video
 * input, and only "Refer to..." is left.
 */
export function seedanceWorkflowsFor(
  model: ReferenceMediaModel | undefined,
): SeedanceWorkflowRecipe[] {
  if (!isSeedanceReferenceModel(model)) return [];
  if (takesReferenceClips(model)) return SEEDANCE_WORKFLOWS;
  return SEEDANCE_WORKFLOWS.filter((recipe) => !recipe.needsClip);
}

/**
 * Which workflow a prompt reads as, or undefined when nothing matches — which
 * is itself the useful answer: a reference-to-video request whose prompt opens
 * with none of the canonical forms is the misrouting case, and a surface can
 * say so before the spend.
 *
 * Matching is deliberately loose on whitespace and strict on wording, because
 * that is how the router behaves.
 */
export function detectSeedanceWorkflow(prompt: string): SeedanceWorkflow | undefined {
  const text = prompt.trim();
  if (!text) return undefined;
  if (/^strictly edit\s*<video\s*\d+>/i.test(text)) return "edit";
  if (/^extend\s*<video\s*\d+>/i.test(text)) return "extend";
  if (/^<video\s*\d+>\s*\+/i.test(text)) return "stitch";
  if (/^refer to\b/i.test(text)) return "reference";
  return undefined;
}

/**
 * Whether a prompt's mentions are spelled the way the router reads them.
 *
 * The failure this catches is specific and expensive: `image 1` (or `Image 1`
 * without the angle brackets) is not a mention, so the model treats it as
 * prose, ignores the reference, and renders something plausible but wrong.
 * Returns the offending spellings so the surface can name them.
 */
export function looseMentions(prompt: string): string[] {
  const found = new Set<string>();
  // A bare "image 2" / "video 1" / "audio 3", not already inside <>.
  for (const match of prompt.matchAll(/(^|[^<\w])((?:image|video|audio)\s+\d+)(?=$|[^>\w])/gi)) {
    found.add(match[2]);
  }
  return [...found];
}

/**
 * What is wrong with a seedance reference prompt, if anything — one short
 * sentence a surface can show next to the prompt, before the spend.
 *
 * Two failures, both silent and both billed: a prompt with no canonical
 * opening runs whichever workflow the router guesses, and a prompt whose
 * mentions are plain prose renders something plausible that ignores the
 * references. Returns undefined when the prompt reads correctly, and also
 * when the model is not a seedance reference variant (nothing to advise).
 */
export function seedancePromptAdvice(
  model: Pick<MediaModel, "id"> | undefined,
  prompt: string,
): string | undefined {
  // Keyed on the prompt contract, not on which media the variant accepts: the
  // routing and the mention syntax are the same on a model that takes no clips.
  if (!isSeedanceReferenceModel(model) || !prompt.trim()) return undefined;
  const loose = looseMentions(prompt);
  if (loose.length > 0) {
    return `Write ${loose.join(" and ")} as ${loose
      .map((mention) => canonicalizeMentions(mention))
      .join(" and ")} - this model only recognises that spelling.`;
  }
  if (!detectSeedanceWorkflow(prompt)) {
    return 'Open with one of "Refer to <Image 1>...", "Strictly edit <Video 1>...", "Extend <Video 1>..." or "<Video 1> + ..." so the right workflow runs.';
  }
  return undefined;
}

/**
 * What seedance requires of a reference image, checked locally.
 *
 * The provider's limits are dimensional (min 300px on the short side, aspect
 * ratio strictly inside 0.4-2.5), and it only reports them after the request
 * has been queued — which on the durable path means a row, a poll and a
 * failure the user reads minutes later. Measuring in the webview is free and
 * catches it before the spend. Returns undefined when the image is fine, or
 * when the model has no such contract.
 */
export const SEEDANCE_MIN_IMAGE_SIDE = 300;
export const SEEDANCE_MIN_IMAGE_RATIO = 0.4;
export const SEEDANCE_MAX_IMAGE_RATIO = 2.5;

export function seedanceImageProblem(
  model: Pick<MediaModel, "id"> | undefined,
  size: { width: number; height: number },
): string | undefined {
  if (!model || !isSeedanceModel(model.id)) return undefined;
  const { width, height } = size;
  if (width <= 0 || height <= 0) return undefined;
  if (Math.min(width, height) < SEEDANCE_MIN_IMAGE_SIDE) {
    return `This photo is ${width}x${height}. Seedance needs at least ${SEEDANCE_MIN_IMAGE_SIDE}px on the short side.`;
  }
  const ratio = width / height;
  if (ratio <= SEEDANCE_MIN_IMAGE_RATIO || ratio >= SEEDANCE_MAX_IMAGE_RATIO) {
    return `This photo is too ${ratio > 1 ? "wide" : "tall"} (${width}x${height}). Seedance takes shapes between 2:5 and 5:2.`;
  }
  return undefined;
}

/**
 * The request-size ceiling, and what it means for reference clips.
 *
 * Sub Rosa has nowhere to host a clip, so every media input travels inline as
 * a data URI — and the API caps a request body at 35 MB. Base64 inflates
 * bytes by about a third, so the real budget for the clips themselves is
 * smaller than the cap suggests. This is the one limit a user can hit without
 * doing anything unreasonable (three 10 MB clips), and finding out through a
 * 413 after queueing is the worst way to learn it.
 */
export const MAX_REQUEST_BYTES = 35 * 1024 * 1024;

/** Decoded byte count behind a data URI (base64 is ~4/3 of the bytes). */
function dataUriBytes(dataUri: string): number {
  const comma = dataUri.indexOf(",");
  const payload = comma >= 0 ? dataUri.slice(comma + 1) : dataUri;
  return Math.floor((payload.length * 3) / 4);
}

/**
 * Whether these inline inputs still fit in one request, and what to say when
 * they do not. Measures the encoded form, which is what actually travels.
 */
export function requestSizeProblem(inputs: readonly string[]): string | undefined {
  const encoded = inputs.reduce((total, input) => total + input.length, 0);
  if (encoded <= MAX_REQUEST_BYTES) return undefined;
  const megabytes = Math.round(
    inputs.reduce((total, input) => total + dataUriBytes(input), 0) / 1e6,
  );
  return `These inputs add up to about ${megabytes} MB, over the ${Math.round(
    MAX_REQUEST_BYTES / 1e6,
  )} MB a single request allows. Use shorter or smaller clips.`;
}

/** The canonical spelling for a loose mention, so a fix can be offered. */
export function canonicalizeMentions(prompt: string): string {
  return prompt.replace(
    /(^|[^<\w])((?:image|video|audio))(\s+)(\d+)(?=$|[^>\w])/gi,
    (_match, before: string, kind: string, _space: string, index: string) => {
      const label = kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase();
      return `${before}<${label} ${index}>`;
    },
  );
}
