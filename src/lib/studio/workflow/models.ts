// What a workflow node's chosen model decides: which models a "model" param
// offers, which values the params under it accept, and what to write down when
// one is picked. Shared by the desktop canvas and the mobile step editor so the
// two never drift apart again (the mobile editor once listed only
// text-to-video models for the video step).

import { imageEditModels, modelsOfType, videoDirection } from "../catalog";
import { effectiveVideoConstraints, videoFieldApplies } from "../model-constraints";
import type { MediaCatalog, MediaModel, MediaType } from "../types";
import type { NodeSchema, ParamSchema } from "./schema";

/** Every catalog type a video node draws its model from. */
const VIDEO_TYPES: MediaType[] = ["video", "imageToVideo", "referenceToVideo"];

/** Models a "model" param can pick from — a single catalog type, or several
 * merged (a video node draws on text-to-video, image-to-video, and
 * reference-to-video alike). Edit models go through `imageEditModels`, which
 * adds the known-good Carpe Diem passthroughs the catalog does not list. */
export function modelsForParam(catalog: MediaCatalog, param: ParamSchema): MediaModel[] {
  if (param.mediaType === "imageEdit" && !param.mediaTypes) return imageEditModels(catalog);
  const types = (param.mediaTypes ?? [param.mediaType ?? "text"]) as MediaType[];
  const seen = new Set<string>();
  const merged: MediaModel[] = [];
  for (const type of types) {
    for (const model of modelsOfType(catalog, type)) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      merged.push(model);
    }
  }
  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether this param picks a video model, and so decides which media inputs
 * the node carries. */
function isVideoModelParam(param: ParamSchema): boolean {
  const types = param.mediaTypes ?? (param.mediaType ? [param.mediaType] : []);
  return types.some((type) => VIDEO_TYPES.includes(type as MediaType));
}

/**
 * The catalog's entry for an id, or a stand-in carrying just the id.
 *
 * The stand-in matters: the operator forwards models it does not list (see
 * `CARPE_DIEM_EXTRA_EDIT_MODELS`), and the probed and learned constraint
 * tables are keyed by id, so a model missing from the catalog still has
 * options to offer.
 */
function modelEntry(catalog: MediaCatalog, id: string): MediaModel | undefined {
  if (id === "") return undefined;
  return (
    catalog.models.find((model) => model.id === id) ?? {
      id,
      name: id,
      mediaType: "video",
      offline: false,
    }
  );
}

function optionsFor(param: ParamSchema, model: MediaModel | undefined): string[] {
  if (!param.modelOptions || !model) return [];
  const constraints = effectiveVideoConstraints(model);
  if (param.modelOptions === "durations") return constraints.durations ?? [];
  if (param.modelOptions === "aspectRatios") return constraints.aspect_ratios ?? [];
  return constraints.resolutions ?? [];
}

/**
 * The values a param offers on this node, empty when it is free text.
 *
 * Duration, aspect ratio and resolution are not the schema's to enumerate:
 * every video model publishes its own, the operator refuses a value outside
 * them (`400 VIDEO_PARAM_REJECTED`), and half the families publish nothing at
 * all - which is why `effectiveVideoConstraints` merges what a rejection
 * taught us over what the catalog says over what we probed. An empty list is a
 * real answer: nobody knows this model's options, so the field stays free text
 * rather than inventing a menu.
 */
export function paramOptions(
  param: ParamSchema,
  params: Record<string, unknown>,
  catalog: MediaCatalog,
): string[] {
  if (!param.modelOptions) return param.enumValues ?? [];
  return optionsFor(
    param,
    modelEntry(catalog, typeof params.model === "string" ? params.model : ""),
  );
}

/**
 * What a param will actually be sent as: the stored value when the model
 * offers it, else its first option. Mirrors the request builder's own `pick`,
 * so the editor shows what will be rendered instead of a stale value the
 * submit would silently replace.
 */
/**
 * Whether this param is a setting the node's model has at all.
 *
 * Distinct from having no options: an image-to-video model takes its frame
 * from the source image and has no aspect ratio to set, and offering a free
 * text box for one would be inventing a setting whose only possible use is to
 * fail the render. A model nobody knows anything about keeps every field,
 * because withholding one it needs is the worse mistake.
 */
export function paramApplies(
  param: ParamSchema,
  params: Record<string, unknown>,
  catalog: MediaCatalog,
): boolean {
  if (!param.modelOptions) return true;
  const id = typeof params.model === "string" ? params.model : "";
  if (id === "") return true;
  return videoFieldApplies(modelEntry(catalog, id), param.modelOptions);
}

export function effectiveParamValue(options: readonly string[], value: unknown): string {
  const current = typeof value === "string" ? value : "";
  if (options.length === 0) return current;
  return options.includes(current) ? current : options[0];
}

/**
 * The params to write when a model is picked — not just the id.
 *
 * Two things travel with it. The model's *direction* decides which inputs the
 * node carries (a reference-to-video model has no opening frame), and only the
 * catalog can say it: nine of the operator's 101 video models name no
 * direction in their id, five of them image-to-video. And every option list on
 * the node belongs to the model, so a duration or a resolution the new model
 * does not offer is re-picked here rather than left on screen for the submit
 * to replace in silence (seedance 2.0 reaches 4k, 2.5 stops at 720p).
 *
 * Both shells must go through this: a picker that writes the bare id leaves
 * the ports to be guessed from the id again and the settings to go stale.
 */
export function modelParamPatch(
  schema: NodeSchema,
  params: Record<string, unknown>,
  param: ParamSchema,
  model: MediaModel | undefined,
): Record<string, unknown> {
  const patch: Record<string, unknown> = { [param.name]: model?.id ?? "" };
  if (isVideoModelParam(param)) {
    patch.modelDirection = model ? videoDirection(model) : undefined;
  }
  for (const other of schema.params) {
    if (!other.modelOptions) continue;
    const options = optionsFor(other, model);
    patch[other.name] =
      options.length === 0 ? "" : effectiveParamValue(options, params[other.name]);
  }
  return patch;
}
