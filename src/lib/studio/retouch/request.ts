// What a retouch may send to an edit model, and the request that carries it.
//
// Facts measured against the operator on 2026-10-02 (ideogram-v4-5-edit):
// - `/image/multi-edit` takes `resolution` and `quality`; `/image/edit`
//   refuses `quality`. A retouch therefore always goes through multi-edit,
//   which also takes a single image and honors `aspect_ratio`.
// - The operator caps `images` at three whatever the catalog advertises
//   (`maxInputImages: 5` for Ideogram): a fourth image is a 400 at queue time.
// - Each image must stay under 5 MB (413 at queue time).
// - Validation of the values (an unknown ratio or resolution) happens after
//   the queue accepts the job, so a bad value only surfaces at retrieve: send
//   nothing the catalog did not list.

import { t } from "../../i18n";
import { defaultEditModel, imageEditModels } from "../catalog";
import type { MediaCatalog, MediaModel } from "../types";

/** How many images the operator's multi-edit accepts, the source included.
 * Raise it when the operator follows the catalog's `maxInputImages`. */
export const MULTI_EDIT_OPERATOR_CAP = 3;

/** The model a retouch starts on: Ideogram's editor when the catalog has it. */
export const PREFERRED_RETOUCH_MODEL = "ideogram-v4-5-edit";

export interface EditCaps {
  /** Images per request, the source included. */
  maxInputs: number;
  resolutions: string[];
  defaultResolution?: string;
  qualities: string[];
  defaultQuality?: string;
  /** Explicit ratios only: "auto" is what sending none means. */
  aspectRatios: string[];
  promptLimit?: number;
}

export function editCaps(model: MediaModel | undefined): EditCaps {
  const constraints = model?.constraints ?? {};
  const advertised =
    constraints.combineImages === false
      ? 1
      : (constraints.maxInputImages ?? MULTI_EDIT_OPERATOR_CAP);
  const resolutions = constraints.resolutions ?? [];
  const qualities = constraints.qualities ?? [];
  return {
    maxInputs: Math.max(1, Math.min(advertised, MULTI_EDIT_OPERATOR_CAP)),
    resolutions,
    defaultResolution: pick(constraints.defaultResolution, resolutions),
    qualities,
    defaultQuality: pick(constraints.defaultQuality, qualities),
    aspectRatios: (constraints.aspectRatios ?? []).filter((ratio) => ratio !== "auto"),
    promptLimit: constraints.promptCharacterLimit,
  };
}

function pick(value: string | undefined, allowed: string[]): string | undefined {
  return value && allowed.includes(value) ? value : undefined;
}

/** The model a new retouch opens on. */
export function defaultRetouchModel(catalog: MediaCatalog): MediaModel | undefined {
  return (
    imageEditModels(catalog).find((model) => model.id === PREFERRED_RETOUCH_MODEL) ??
    defaultEditModel(catalog)
  );
}

export interface EditRequestInput {
  model: string;
  prompt: string;
  /** Data URIs, the source first. */
  images: string[];
  resolution?: string;
  quality?: string;
  /** Omit, or "auto", to follow the source's shape. */
  aspectRatio?: string;
}

export interface EditRequest {
  base: "/image/multi-edit";
  body: Record<string, unknown>;
}

export class EditRequestError extends Error {
  constructor(
    readonly code: "no_image" | "too_many_images" | "empty_prompt" | "prompt_too_long",
    message: string,
  ) {
    super(message);
    this.name = "EditRequestError";
  }
}

/** Build the queue body for one edit. Values the model does not list are
 * dropped rather than sent: the operator would only refuse them after the job
 * was accepted. */
export function buildEditRequest(caps: EditCaps, input: EditRequestInput): EditRequest {
  const images = input.images.filter((uri) => uri.trim());
  if (images.length === 0) throw new EditRequestError("no_image", t("Add an image to retouch."));
  if (images.length > caps.maxInputs)
    throw new EditRequestError("too_many_images", t("This model takes fewer images."));
  const prompt = input.prompt.trim();
  if (!prompt) throw new EditRequestError("empty_prompt", t("Describe the change you want."));
  if (caps.promptLimit !== undefined && prompt.length > caps.promptLimit)
    throw new EditRequestError("prompt_too_long", t("The instruction is too long for this model."));
  const body: Record<string, unknown> = {
    model: input.model,
    prompt,
    images,
    safe_mode: false,
  };
  if (input.resolution && caps.resolutions.includes(input.resolution))
    body.resolution = input.resolution;
  if (input.quality && caps.qualities.includes(input.quality)) body.quality = input.quality;
  if (input.aspectRatio && caps.aspectRatios.includes(input.aspectRatio))
    body.aspect_ratio = input.aspectRatio;
  return { base: "/image/multi-edit", body };
}
