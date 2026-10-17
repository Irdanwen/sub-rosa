// A template names the models it was drawn with; the catalog a person has
// today may not offer them any more. Before a template is shown or used,
// each of its model choices is kept when the catalog still offers it, and
// otherwise moved to the closest model the catalog does offer: the same
// direction of video, the same family when there is one, else the cheapest.
// A step no offered model can make is named, and the template is not
// started.

import { videoDirection, videoDirectionFromId } from "../catalog";
import type { MediaCatalog, MediaModel } from "../types";
import { modelsForParam } from "./models";
import { maybeNodeSchema, type Workflow } from "./schema";

export interface ResolvedTemplate {
  workflow: Workflow;
  /** The steps no offered model can make, by label. */
  missing: string[];
}

function closest(id: string, candidates: MediaModel[]): MediaModel | undefined {
  const family = id.split("-")[0];
  const sameFamily = family
    ? candidates.find((model) => model.id.startsWith(`${family}-`))
    : undefined;
  if (sameFamily) return sameFamily;
  const priced = candidates
    .filter((model) => typeof model.costCredits === "number")
    .sort((a, b) => (a.costCredits ?? 0) - (b.costCredits ?? 0));
  return priced[0] ?? candidates[0];
}

export function resolveTemplateModels(template: Workflow, catalog: MediaCatalog): ResolvedTemplate {
  // No catalog yet (offline, or still loading): nothing can be judged.
  if (catalog.models.length === 0) return { workflow: template, missing: [] };
  const missing: string[] = [];
  const nodes = template.nodes.map((node) => {
    const schema = maybeNodeSchema(node.type);
    if (!schema) return node;
    let params = node.params;
    for (const param of schema.params) {
      if (param.type !== "model") continue;
      const id = typeof params[param.name] === "string" ? (params[param.name] as string) : "";
      if (id === "" && !param.required) continue;
      const offered = modelsForParam(catalog, param);
      if (offered.some((model) => model.id === id)) continue;
      const direction =
        node.type === "video"
          ? (videoDirectionFromId(id) ??
            (typeof params.modelDirection === "string" ? params.modelDirection : undefined))
          : undefined;
      const candidates = direction
        ? offered.filter((model) => videoDirection(model) === direction)
        : offered;
      const picked = closest(id, candidates);
      if (!picked) {
        missing.push(node.label || schema.label);
        continue;
      }
      params = {
        ...params,
        [param.name]: picked.id,
        ...(node.type === "video" ? { modelDirection: videoDirection(picked) } : {}),
      };
    }
    return params === node.params ? node : { ...node, params };
  });
  return { workflow: { ...template, nodes }, missing };
}
