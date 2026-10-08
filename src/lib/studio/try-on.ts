// "Try it on": a photo of a person and a photo of a garment, composed into
// one picture of that person wearing it, through `/image/multi-edit`.
//
// Two images, always: the person first (the picture the edit keeps), the
// garment second (what it borrows). The prompt is the product here: an edit
// model left to itself re-renders the face and the room, so it names what must
// not move before it names the change.

import { t } from "../i18n";
import { imageEditModels } from "./catalog";
import { composeImages } from "./edit-image";
import { saveArtifactFromBase64 } from "./artifacts";
import { editCaps } from "./retouch/request";
import type { ArtifactOrigin, MediaCatalog, MediaModel, StudioArtifact } from "./types";

/** Edit models that dress a person well, best first. The first one the
 * catalog offers with room for two images wins; then any model with room. */
export const TRY_ON_MODEL_PREFERENCE = [
  "nano-banana-2-edit",
  "seedream-v4-edit",
  "seedream-v5-lite-edit",
  "qwen-image-2-edit",
  "ideogram-v4-5-edit",
];

/** The tuned prompt. `garment` is an optional few words that name it, which
 * helps when the garment photo shows more than the garment. */
export function tryOnPrompt(garment?: string): string {
  const named = garment?.trim() ? ` (${garment.trim().replace(/\s+/g, " ").slice(0, 160)})` : "";
  return [
    "Virtual try-on.",
    "Image 1 is the person. Image 2 is the garment.",
    `Dress the person from image 1 in the garment from image 2${named}.`,
    "Keep the person exactly as they are: the same face, identity, skin tone, hair, body shape, pose, hands and expression.",
    "Keep the background, the framing, the camera angle and the lighting of image 1.",
    "Replace only the clothing the garment covers, and reproduce the garment faithfully: its cut, colour, pattern, fabric texture, print or logo and details.",
    "Make it fit this body naturally, with realistic drape, folds, seams and shadows that match the light of image 1.",
    "Photorealistic, no extra people, no text.",
  ].join(" ");
}

/** The model a try-on runs on, or undefined when no edit model can take two
 * images. */
export function tryOnModel(catalog: MediaCatalog): MediaModel | undefined {
  const models = imageEditModels(catalog).filter(
    (model) => !model.offline && editCaps(model).maxInputs >= 2,
  );
  for (const preferred of TRY_ON_MODEL_PREFERENCE) {
    const hit = models.find((model) => model.id.toLowerCase() === preferred);
    if (hit) return hit;
  }
  return models[0];
}

export interface TryOnInput {
  model: MediaModel;
  /** Data URIs, already sized for an edit (`prepareEditReference`). */
  person: string;
  garment: string;
  garmentLabel?: string;
  /** Set when the try-on was asked for in a conversation. */
  origin?: ArtifactOrigin;
}

/** Runs one try-on and files the result in the gallery. */
export async function runTryOn(input: TryOnInput): Promise<StudioArtifact> {
  if (!input.person.trim() || !input.garment.trim()) {
    throw new Error(t("Choose a photo of the person and a photo of the garment."));
  }
  const prompt = tryOnPrompt(input.garmentLabel);
  const image = await composeImages(input.model.id, prompt, [input.person, input.garment]);
  return saveArtifactFromBase64(image, "png", {
    kind: "image",
    model: input.model.id,
    prompt,
    ...(input.model.costCredits !== undefined ? { costCredits: input.model.costCredits } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
  });
}
