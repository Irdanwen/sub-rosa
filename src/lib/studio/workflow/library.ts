// What a workflow's library card shows: its last real result, a summary of
// what it makes, and, on request, a picture made for it (ADR-0075).

import { t } from "../../i18n";
import { saveArtifactFromBase64 } from "../artifacts";
import { defaultImageModel, estimateCostCredits } from "../catalog";
import { generateImages } from "../generate-image";
import { markArtifacts } from "../library";
import type { MediaCatalog, MediaModel, StudioArtifact } from "../types";
import type { NodeRunResult } from "./engine";
import { nodeLabel, type Workflow } from "./schema";
import { setWorkflowCover } from "./store";

/** The picture a finished run leaves for its card: what reached an output
 * node, else the last image or clip a node made. A gallery item the run only
 * read (an asset node) is not a result. */
export function coverArtifactOf(
  workflow: Pick<Workflow, "nodes" | "edges">,
  results: Map<string, NodeRunResult>,
): string | undefined {
  const visual = (nodeId: string) => {
    const output = results.get(nodeId)?.output;
    if (!output || (output.kind !== "image" && output.kind !== "video")) return undefined;
    return output.artifactId;
  };
  for (const node of workflow.nodes) {
    if (node.type !== "output") continue;
    for (const edge of workflow.edges.filter((entry) => entry.target === node.id)) {
      const found = visual(edge.source);
      if (found) return found;
    }
  }
  const makers = workflow.nodes.filter((node) => node.type !== "asset");
  for (const node of [...makers].reverse()) {
    const found = visual(node.id);
    if (found) return found;
  }
  return undefined;
}

/** "2 images, 1 video": what one run makes, for the card. */
export function workflowMakes(workflow: Pick<Workflow, "nodes">): string {
  const count = (types: string[]) =>
    workflow.nodes.filter((node) => types.includes(node.type)).length;
  const images = count(["image", "imageEdit"]);
  const videos = count(["video"]);
  const sounds = count(["tts", "music"]);
  const parts: string[] = [];
  if (videos) parts.push(videos === 1 ? t("1 video") : t("{count} videos", { count: videos }));
  if (images) parts.push(images === 1 ? t("1 image") : t("{count} images", { count: images }));
  if (sounds) parts.push(sounds === 1 ? t("1 sound") : t("{count} sounds", { count: sounds }));
  if (parts.length > 0) return parts.join(", ");
  const steps = workflow.nodes.length;
  return steps === 0
    ? t("No steps yet")
    : steps === 1
      ? t("1 step")
      : t("{count} steps", { count: steps });
}

/** The prompt for a card picture: what the workflow is about, in its own
 * words, as an illustration rather than a result. */
export function coverPrompt(workflow: Pick<Workflow, "name" | "description" | "nodes">): string {
  const prompts = workflow.nodes
    .map((node) => (typeof node.params.prompt === "string" ? node.params.prompt.trim() : ""))
    .filter(Boolean)
    .slice(0, 2)
    .map((text) => text.slice(0, 300));
  const steps = workflow.nodes
    .map((node) => nodeLabel(node))
    .slice(0, 6)
    .join(", ");
  return [
    `An evocative cover illustration for a creative workflow called "${workflow.name}".`,
    prompts.length ? `It makes: ${prompts.join(" / ")}.` : `Its steps: ${steps}.`,
    "Cinematic, rich colour, no text, no letters, no interface.",
  ].join(" ");
}

export interface CoverOffer {
  model: MediaModel;
  credits?: number;
}

/** The model a card picture would be made with, and its price. */
export function coverOffer(catalog: MediaCatalog): CoverOffer | undefined {
  const model = defaultImageModel(catalog);
  return model ? { model, credits: estimateCostCredits(model) } : undefined;
}

/** Make a picture for a workflow's card: a paid image, kept hidden in the
 * gallery so it does not crowd it, and set as the cover. */
export async function makeWorkflowCover(
  workflow: Workflow,
  offer: CoverOffer,
): Promise<StudioArtifact> {
  const prompt = coverPrompt(workflow);
  const [image] = await generateImages(offer.model.id, {
    model: offer.model.id,
    prompt,
    variants: 1,
    format: "webp",
    hide_watermark: true,
    safe_mode: false,
  });
  if (!image) throw new Error(t("The picture could not be made."));
  const artifact = await saveArtifactFromBase64(image, "webp", {
    kind: "image",
    model: offer.model.id,
    prompt,
    costCredits: offer.credits,
  });
  await markArtifacts([artifact], { hidden: true }).catch(() => undefined);
  await setWorkflowCover(workflow.id, artifact.id);
  return artifact;
}

/** Key-order-independent JSON, to tell an edit from a redraw. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Whether two copies of a workflow hold the same graph and name: opening a
 * workflow redraws its canvas, which is not an edit. */
export function sameWorkflow(a: Workflow, b: Workflow): boolean {
  return (
    a.name === b.name &&
    stableJson({ nodes: a.nodes, edges: a.edges }) ===
      stableJson({ nodes: b.nodes, edges: b.edges })
  );
}
