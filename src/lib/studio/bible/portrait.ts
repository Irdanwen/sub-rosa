/**
 * Making a reference instead of going and finding one.
 *
 * The bible could only ever *pick* an image out of the gallery, which meant a
 * character's face had to exist before the character did. Nothing said so, so
 * the honest first step of making a film was: go to the Image tab, invent
 * three prompts, generate three pictures, come back. That is the cold start,
 * and it is where people stopped.
 *
 * So an entry can make its own references. The prompt is built from what the
 * bible already knows - the name, the invariant traits, the kind, and which
 * role is being filled - because those are exactly the words that have to be
 * on every shot the character appears in anyway. A portrait generated from the
 * same sentence the shots will carry is a portrait the shots can actually hold
 * on to.
 */

import { estimateCostCredits, modelsOfType } from "../catalog";
import { generateImages } from "../generate-image";
import { saveArtifactFromBase64 } from "../artifacts";
import type { MediaCatalog, MediaModel, StudioArtifact } from "../types";
import { addBibleRef } from "./index";
import type { BibleEntry, BibleKind, BibleRole } from "./types";

/**
 * What each role has to show, in the words a generator understands.
 *
 * Framing first, because that is what distinguishes the roles from each other:
 * two "portraits" of the same person at different framings are two angles, and
 * two identical ones are one reference wasted.
 */
const ROLE_FRAMING: Record<BibleRole, string> = {
  portrait: "Head and shoulders, facing the camera, neutral expression, even light.",
  profile: "Head and shoulders in profile, the same person, the same light.",
  wide: "Wide establishing shot of the whole place, no people.",
  medium: "Medium shot of the place at eye level, no people.",
  detail: "Close detail of one telling part of it.",
  // A voice is not a picture. Surfaces gate on this rather than calling here.
  voice: "",
};

const KIND_SUBJECT: Record<BibleKind, string> = {
  character: "A single person",
  location: "A place",
  prop: "A single object on a plain background",
  look: "A frame that sets the visual style",
};

/** Roles this can generate. `voice` is not one of them. */
export function canGenerate(role: BibleRole): boolean {
  return role !== "voice";
}

/**
 * The prompt a reference is made from.
 *
 * Deliberately the same sentence the shots will carry: the traits are what
 * every shot restates, so generating the face from anything else would make
 * the reference and the prompts disagree from the first frame.
 */
export function portraitPrompt(entry: BibleEntry, role: BibleRole, style?: string): string {
  const traits = entry.traits.trim().replace(/\.$/, "");
  return [
    `${KIND_SUBJECT[entry.kind]}: ${entry.name}.`,
    traits ? `${traits}.` : "",
    ROLE_FRAMING[role],
    style?.trim() ? `${style.trim()}.` : "",
    "Photographic, consistent lighting, no text, no watermark.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The model to draw a reference with.
 *
 * The cheapest the account publishes, for the same reason the video routing
 * takes the cheapest: a reference is drawn several times per production while
 * somebody decides they like it, and the expensive ones are not better at
 * "a person, facing the camera".
 */
export function pickPortraitModel(catalog: MediaCatalog): MediaModel | undefined {
  const models = modelsOfType(catalog, "image");
  return [...models].sort(
    (left, right) =>
      (estimateCostCredits(left, { multiplier: catalog.priceMultiplier }) ??
        Number.POSITIVE_INFINITY) -
      (estimateCostCredits(right, { multiplier: catalog.priceMultiplier }) ??
        Number.POSITIVE_INFINITY),
  )[0];
}

/** What one reference costs, so a surface can say it before spending it. */
export function portraitCostCredits(catalog: MediaCatalog): number | undefined {
  const model = pickPortraitModel(catalog);
  return model ? estimateCostCredits(model, { multiplier: catalog.priceMultiplier }) : undefined;
}

export interface GeneratedReference {
  artifact: StudioArtifact;
  prompt: string;
  model: string;
}

/**
 * Draw one reference and attach it to the entry.
 *
 * The artifact lands in the gallery like any other, so it can be exported,
 * reworked, or picked by hand later. Nothing here is a special kind of file.
 */
export async function generateReference(
  entry: BibleEntry,
  role: BibleRole,
  catalog: MediaCatalog,
  options: { style?: string; aspectRatio?: string; signal?: AbortSignal } = {},
): Promise<GeneratedReference> {
  if (!canGenerate(role)) {
    throw new Error("A voice is not a picture. Audition one instead.");
  }
  const model = pickPortraitModel(catalog);
  if (!model) {
    throw new Error("No model on this account can draw a picture.");
  }
  const prompt = portraitPrompt(entry, role, options.style);
  const body: Record<string, unknown> = { prompt, model: model.id };
  // Square for a face, wide for a place: a portrait cropped to 16:9 loses the
  // top of the head, which is the part the identity is carried by.
  const ratio = options.aspectRatio ?? (entry.kind === "location" ? "16:9" : "1:1");
  const ratios = model.constraints?.aspect_ratios;
  if (!ratios || ratios.includes(ratio)) body.aspect_ratio = ratio;

  const images = await generateImages(model.id, body, options.signal);
  const base64 = images[0];
  if (!base64) throw new Error("The model returned no picture.");

  const artifact = await saveArtifactFromBase64(base64, "png", {
    kind: "image",
    model: model.id,
    prompt,
  });
  await addBibleRef({
    entryId: entry.id,
    artifactId: artifact.id,
    role,
    label: role,
  });
  return { artifact, prompt, model: model.id };
}
