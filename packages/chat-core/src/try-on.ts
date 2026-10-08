// The try-on prompt and model preference (ADR-0088), shared by the app's
// Studio and the web client. The prompt is the product here: an edit model
// left to itself re-renders the face and the room, so it names what must not
// move before it names the change.

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
