// Which catalog models a workflow "model" param offers. Shared by the desktop
// canvas and the mobile step editor so the two never drift apart again (the
// mobile editor once listed only text-to-video models for the video step).

import { imageEditModels, modelsOfType } from "../catalog";
import type { MediaCatalog, MediaModel, MediaType } from "../types";
import type { ParamSchema } from "./schema";

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
