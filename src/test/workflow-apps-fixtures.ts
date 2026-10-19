// What the "every app" benches share: a catalog derived from the templates,
// the gallery items a filled form points at, and the generic way to fill a
// field. Not a test file: both benches import it.

import { videoDirectionFromId } from "../lib/studio/catalog";
import type { MediaCatalog, MediaModel, MediaType } from "../lib/studio/types";
import { type ShownField, shownFields } from "../lib/studio/workflow/app";
import { nodeSchema, type Workflow, type WorkflowNode } from "../lib/studio/workflow/schema";

/** The gallery items a filled form points at. */
export const STAND_INS = {
  image: { id: "hero.png", label: "hero.png" },
  video: { id: "clip.mp4", label: "clip.mp4" },
  audio: { id: "theme.mp3", label: "theme.mp3" },
} as const;

function mediaTypeFor(node: WorkflowNode, modelId: string): MediaType {
  const param = nodeSchema(node.type).params.find((entry) => entry.type === "model");
  if (param?.mediaTypes) {
    const direction = videoDirectionFromId(modelId);
    if (direction === "image") return "imageToVideo";
    if (direction === "reference") return "referenceToVideo";
    return "video";
  }
  return (param?.mediaType as MediaType | undefined) ?? "text";
}

/** One model per id the templates name, typed by the step that names it. */
export function catalogFor(templates: readonly Workflow[]): MediaCatalog {
  const models = new Map<string, MediaModel>();
  for (const template of templates)
    for (const node of template.nodes) {
      const id = node.params.model;
      if (typeof id !== "string" || !id || models.has(id)) continue;
      models.set(id, {
        id,
        name: id,
        offline: false,
        mediaType: mediaTypeFor(node, id),
        costCredits: 1,
      });
    }
  return { backend: "carpe-diem", models: [...models.values()] };
}

export function assetKindOf(node: WorkflowNode): keyof typeof STAND_INS {
  return node.params.assetKind === "video"
    ? "video"
    : node.params.assetKind === "audio"
      ? "audio"
      : "image";
}

export const filled = (value: unknown) =>
  value !== undefined && value !== null && !(typeof value === "string" && !value.trim());

/** What a person would put in a field, when the template left it empty. */
export function fillField({ node, param }: ShownField): Record<string, unknown> {
  const value = node.params[param.name];
  switch (param.type) {
    case "artifact": {
      const standIn = STAND_INS[assetKindOf(node)];
      return { [param.name]: standIn.id, assetLabel: standIn.label };
    }
    case "artifacts":
      return { [param.name]: [STAND_INS.image.id] };
    case "boolean":
      return { [param.name]: true };
    case "number":
      return { [param.name]: filled(value) ? value : (param.min ?? 1) };
    case "enum":
      return { [param.name]: filled(value) ? value : param.enumValues?.[0] };
    case "model":
      return {};
    default:
      return { [param.name]: filled(value) ? value : "matrix" };
  }
}

export function filledApp(template: Workflow, catalog: MediaCatalog): Workflow {
  const fills = new Map<string, Record<string, unknown>>();
  for (const shown of shownFields(template.app, template, catalog))
    fills.set(shown.node.id, { ...fills.get(shown.node.id), ...fillField(shown) });
  return {
    ...template,
    nodes: template.nodes.map((node) => ({
      ...node,
      params: { ...node.params, ...fills.get(node.id) },
    })),
  };
}
