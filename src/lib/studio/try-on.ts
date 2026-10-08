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

import { TRY_ON_MODEL_PREFERENCE, tryOnPrompt } from "@subrosa/chat-core/try-on";

// The prompt and the preference are shared with the web client.
export { TRY_ON_MODEL_PREFERENCE, tryOnPrompt } from "@subrosa/chat-core/try-on";

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
