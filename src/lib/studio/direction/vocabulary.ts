/**
 * The prompt bible's vocabulary: every choice a film's direction and a shot's
 * camera can make, with the exact English words a video model reads for it.
 *
 * One file, `vocabulary.json`, is the source. The webview reads it here, the
 * shot-list reader in Rust reads the same ids (`include_str!`), and the labels
 * a person sees live in `labels.ts`. A value the reader returns that is not in
 * here is dropped, never guessed at.
 */

import vocabulary from "./vocabulary.json";

export interface VocabularyEntry {
  id: string;
  /** What the prompt says, in English, ready to paste. */
  write: string;
  /** A non-photographic render: the negative block guards the other way. */
  animated?: boolean;
  /** A camera that moves on purpose: never paired with "No camera shake". */
  shaky?: boolean;
  /** No movement at all: amplitude and speed mean nothing for it. */
  still?: boolean;
  /** Music that is not music. */
  silent?: boolean;
  /** How long the montage fade lasts for this transition. */
  fadeSeconds?: number;
}

export const VOCABULARY_CATEGORIES = [
  "genres",
  "moods",
  "pacings",
  "shotSizes",
  "lenses",
  "depths",
  "angles",
  "movements",
  "amplitudes",
  "speeds",
  "transitions",
  "tones",
  "paces",
  "ambiences",
  "music",
  "looks",
  "palettes",
  "lightSources",
  "lightDirections",
  "lightQualities",
  "lightMoments",
  "lightContrasts",
  "lightEffects",
  "textures",
  "negatives",
] as const;
export type VocabularyCategory = (typeof VOCABULARY_CATEGORIES)[number];

export interface Recipe {
  id: string;
  genre: string;
  moods: string[];
  pacing: string;
  shot: { size?: string; lens?: string; depth?: string; angle?: string };
  move: { kind?: string; amplitude?: string; speed?: string };
  light: {
    source?: string;
    direction?: string;
    quality?: string;
    moment?: string;
    contrast?: string;
    effects?: string[];
  };
  palette?: string;
  look: string;
  texture?: string;
  ambience: string;
  music: string;
}

type VocabularyFile = { version: string; recipes: Recipe[] } & Record<
  VocabularyCategory,
  VocabularyEntry[]
>;

const FILE = vocabulary as unknown as VocabularyFile;

/** Bumped when a written value changes; carried by nothing that is persisted. */
export const VOCABULARY_VERSION = FILE.version;

export const RECIPES: readonly Recipe[] = FILE.recipes;

export function entries(category: VocabularyCategory): readonly VocabularyEntry[] {
  return FILE[category];
}

/** The entry for an id, or undefined for an id this vocabulary does not have. */
export function entry(
  category: VocabularyCategory,
  id: string | undefined,
): VocabularyEntry | undefined {
  if (!id) return undefined;
  return FILE[category].find((candidate) => candidate.id === id);
}

/** The words for an id; empty when the id is unknown, so a stale id writes nothing. */
export function write(category: VocabularyCategory, id: string | undefined): string {
  return entry(category, id)?.write ?? "";
}

/** An id kept only when the vocabulary has it. */
export function known(category: VocabularyCategory, id: unknown): string | undefined {
  return typeof id === "string" && entry(category, id) ? id : undefined;
}

export function recipe(id: string | undefined): Recipe | undefined {
  return id ? RECIPES.find((candidate) => candidate.id === id) : undefined;
}
