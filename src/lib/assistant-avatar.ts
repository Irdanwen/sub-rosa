// An assistant's face: an initial on a colour of its own, or a picture. A
// picture is always an image reference of the assistant (`avatar_ref`), the
// mechanism the definition already validates and synchronises, so choosing
// one from the gallery, from Photos, or having one generated changes no
// schema and nothing an older device would refuse (ADR-0058 addendum).

import {
  addAssistantArtifact,
  type AssistantDefinition,
  deleteAssistantReference,
  listAssistantReferences,
  saveAssistant,
} from "./assistants";
import { t } from "./i18n";
import { saveArtifactFromBase64 } from "./studio/artifacts";
import { defaultImageModel, estimateCostCredits } from "./studio/catalog";
import { downscaleDataUrl } from "./studio/downscale";
import { darkroomSeed } from "./studio/darkroom";
import { generateImages } from "./studio/generate-image";
import { reencodeAsJpeg } from "./studio/retouch/canvas-io";
import type { MediaCatalog, MediaModel, StudioArtifact } from "./studio/types";

/** Up to two initials, from the first letters of the first two words. */
export function monogramOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? "");
  return letters.join("").toLocaleUpperCase();
}

/**
 * The two hues of an assistant's initial, derived from what never changes
 * about it, so it is the same colour on every device without being stored.
 * A chosen colour would need a new synchronised column, which a device not
 * yet updated refuses outright.
 */
export function monogramHues(
  assistant: Pick<AssistantDefinition, "id" | "name">,
): [number, number] {
  const seed = darkroomSeed(assistant.id || assistant.name || "assistant");
  return [seed.hueA, seed.hueB];
}

/** What an avatar is asked for: a mark that reads at forty pixels. */
export function avatarPrompt(assistant: Pick<AssistantDefinition, "name" | "description">): string {
  const about = assistant.description.trim() || assistant.name.trim();
  return [
    `A distinctive avatar icon for a personal AI assistant called "${assistant.name.trim()}".`,
    about ? `It helps with: ${about}.` : "",
    "One simple, centred subject on a plain softly lit background, rich colour, clean shapes,",
    "readable at a small size. No text, no letters, no frame, no watermark. Square.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The model an avatar is generated with, and what one image costs on it. */
export function avatarModel(
  catalog: MediaCatalog,
): { model: MediaModel; unitCost?: number } | null {
  const model = defaultImageModel(catalog);
  if (!model) return null;
  return { model, unitCost: estimateCostCredits(model) };
}

/** Generates avatar proposals and files them in the gallery, where they stay
 * whatever is chosen: they were paid for. */
export async function generateAvatars(
  assistant: Pick<AssistantDefinition, "name" | "description">,
  model: MediaModel,
  variants: number,
): Promise<StudioArtifact[]> {
  const prompt = avatarPrompt(assistant);
  const body: Record<string, unknown> = {
    model: model.id,
    prompt,
    variants,
    format: "png",
    hide_watermark: true,
    safe_mode: false,
  };
  if (model.constraints?.aspectRatios?.includes("1:1")) body.aspect_ratio = "1:1";
  const images = await generateImages(model.id, body);
  if (images.length === 0) throw new Error(t("The backend returned no image."));
  const saved: StudioArtifact[] = [];
  for (const base64 of images) {
    saved.push(
      await saveArtifactFromBase64(base64, "png", { kind: "image", model: model.id, prompt }),
    );
  }
  return saved;
}

/** A photo from the phone, into the gallery: the one place an image becomes
 * something an assistant can reference. Sized for a face (an avatar is drawn
 * at most a few hundred pixels wide, and the reference is synchronised), and
 * re-encoded when it comes in a format the reference store refuses, which is
 * what an iPhone photo (HEIC) does. */
export async function photoToGallery(file: File): Promise<StudioArtifact> {
  const read = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error(t("This image could not be read.")));
    reader.onerror = () => reject(new Error(t("This image could not be read.")));
    reader.readAsDataURL(file);
  });
  let dataUrl = await downscaleDataUrl(read, { maxEdge: AVATAR_EDGE, maxBytes: AVATAR_BYTES });
  if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(dataUrl))
    dataUrl = await reencodeAsJpeg(dataUrl);
  const match = /^data:image\/(png|jpe?g|webp);base64,(.*)$/i.exec(dataUrl);
  if (!match) throw new Error(t("This image could not be read."));
  const extension = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  return saveArtifactFromBase64(match[2], extension, { kind: "image", model: "", prompt: "" });
}

const AVATAR_EDGE = 1024;
const AVATAR_BYTES = 1_500_000;

/** How long a new image reference is waited on before it is called stuck. */
const READY_TRIES = 20;
const READY_STEP_MS = 300;

/**
 * Makes a gallery image the assistant's avatar: a reference of the image,
 * waited on until it is ready (the definition refuses a reference that is
 * not), then the definition saved with it.
 */
export async function adoptAvatar(
  assistant: AssistantDefinition,
  fileName: string,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<AssistantDefinition> {
  const reference = await addAssistantArtifact(assistant.id, fileName);
  let status = reference.status;
  for (let tries = 0; status === "queued" && tries < READY_TRIES; tries += 1) {
    await wait(READY_STEP_MS);
    const listed = await listAssistantReferences(assistant.id);
    status = listed.find((entry) => entry.id === reference.id)?.status ?? status;
  }
  try {
    if (status === "failed")
      throw new Error(t("This image could not be prepared. Choose another one."));
    if (status !== "ready")
      throw new Error(t("The image is still being prepared. Try again in a moment."));
    return await saveAssistant({ ...assistant, avatar_ref: reference.id });
  } catch (cause) {
    // A reference that did not become the avatar was made only for it: it
    // goes, rather than piling up among the references at every retry.
    await deleteAssistantReference(reference.id).catch(() => undefined);
    throw cause;
  }
}

/** Back to the initial. The image stays among the references. */
export function clearAvatar(assistant: AssistantDefinition): Promise<AssistantDefinition> {
  return saveAssistant({ ...assistant, avatar_ref: null });
}
