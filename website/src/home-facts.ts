// What the home page states as fact, small enough for the main bundle: the
// catalog is its own chunk and the home page must not pull it in.
// src/test/website-home.test.tsx holds every number here to the snapshot and
// the family list, so a catalog refresh that moves one fails until this file
// follows.

/** The day the catalog snapshot was taken (snapshot.json `checkedAt`). */
export const PRICES_CHECKED_AT = "2026-10-16";

/** Model families a person can pick in the app (families.json). */
export const FAMILY_COUNT = 100;

/** The app's languages (src/locales plus English). */
export const LANGUAGE_COUNT = 6;

/** The cheapest private model of each kind the price examples quote. */
export const PRICE_EXAMPLES = {
  /** An hour of speech transcribed: usdPerMinute * 60. */
  transcriptionHour: { model: "fal-ai/wizper", usd: 0.162 },
  /** One image. */
  image: { model: "chroma", usd: 0.0045 },
  /** A five-second clip: usdPerSecond * 5. */
  clip: { model: "longcat-distilled-text-to-video", seconds: 5, usd: 0.0405 },
} as const;

/** The images in the Studio section, all made with Flux 2 Pro through Carpe Diem. */
export const STUDIO_CREATIONS = [
  {
    file: "made-platform",
    en: "A tram platform in Geneva at dawn",
    fr: "Un quai de tram à Genève à l’aube",
  },
  {
    file: "made-desk",
    en: "A still life: notebook, coffee, a dried rose",
    fr: "Nature morte : carnet, café, rose séchée",
  },
  { file: "made-lake", en: "An alpine lake at blue hour", fr: "Un lac alpin à l’heure bleue" },
  { file: "made-watchmaker", en: "A watchmaker at his bench", fr: "Un horloger à son établi" },
] as const;

export const STUDIO_CREATIONS_MODEL = "flux-2-pro";

/** What one of those images costs (snapshot `credits` for flux-2-pro). */
export const STUDIO_CREATION_CREDITS = 1.35;
