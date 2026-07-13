// Studio model catalog: fetch + cache the merged catalog from the Rust proxy
// and derive the model groupings the views need. The backends expose the same
// video family twice (a text-to-video id and an image-to-video id); the studio
// presents one family with a Text/Image toggle, like a single "model".

import { invoke } from "@tauri-apps/api/core";
import type { MediaCatalog, MediaModel, MediaType } from "./types";

const CATALOG_TTL_MS = 5 * 60 * 1000;

let cached: { catalog: MediaCatalog; fetchedAt: number } | undefined;
let inflight: Promise<MediaCatalog> | undefined;

export async function fetchMediaCatalog(force = false): Promise<MediaCatalog> {
  if (!force && cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
    return cached.catalog;
  }
  if (!inflight) {
    inflight = invoke<MediaCatalog>("carpe_diem_media_catalog")
      .then((catalog) => {
        const patched = withVideoDurationFallbacks(catalog);
        cached = { catalog: patched, fetchedAt: Date.now() };
        return patched;
      })
      .finally(() => {
        inflight = undefined;
      });
  }
  return inflight;
}

/** Test seam + settings-change hook: drop the cache so the next fetch is live. */
export function resetMediaCatalogCache() {
  cached = undefined;
  inflight = undefined;
}

export function modelsOfType(catalog: MediaCatalog, type: MediaType): MediaModel[] {
  return catalog.models
    .filter((model) => model.mediaType === type && !model.offline)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Edit models Carpe Diem forwards to Venice but does not advertise in its
 * operator `/v1/models` catalog. Verified callable via `/image/edit` (an
 * unknown id returns `Invalid model id`, these return an image). Surfaced so
 * the picker can offer them; deduped against the live catalog in case the
 * operator later lists them. Only for the Carpe Diem backend — Venice-direct
 * already exposes its full catalog. */
const CARPE_DIEM_EXTRA_EDIT_MODELS: MediaModel[] = [
  {
    id: "qwen-edit-uncensored",
    name: "Qwen edit (uncensored)",
    mediaType: "imageEdit",
    tier: "standard",
    offline: false,
  },
];

/** Edit models for the picker: the catalog's `imageEdit` entries plus the
 * known-good unlisted Carpe Diem passthroughs. */
export function imageEditModels(catalog: MediaCatalog): MediaModel[] {
  const live = modelsOfType(catalog, "imageEdit");
  if (catalog.backend !== "carpe-diem") return live;
  const seen = new Set(live.map((model) => model.id));
  const extras = CARPE_DIEM_EXTRA_EDIT_MODELS.filter((model) => !seen.has(model.id));
  return [...live, ...extras].sort((a, b) => a.name.localeCompare(b.name));
}

/** Duration menus for video families whose constraints never arrive. Venice's
 * public catalog does not list these models, so the merged catalog carries no
 * `durations` and the studios queued without a `duration` — which these models
 * reject with a 400 ("duration Required"). Bounds probed live against
 * `/video/quote` (2026-07-13). Matched by id substring, most specific first;
 * only applied when the catalog has no durations, so live constraints win the
 * moment Venice publishes them. */
const VIDEO_DURATION_FALLBACKS: Array<{ match: string; durations: string[] }> = [
  { match: "seedance-1-5-pro", durations: secondsRange(4, 12) },
  { match: "seedance", durations: secondsRange(4, 15) },
];

function secondsRange(min: number, max: number): string[] {
  return Array.from({ length: max - min + 1 }, (_, index) => `${min + index}s`);
}

export function withVideoDurationFallbacks(catalog: MediaCatalog): MediaCatalog {
  return {
    ...catalog,
    models: catalog.models.map((model) => {
      if (model.mediaType !== "video" && model.mediaType !== "imageToVideo") return model;
      if (model.constraints?.durations?.length) return model;
      const id = model.id.toLowerCase();
      const fallback = VIDEO_DURATION_FALLBACKS.find((entry) => id.includes(entry.match));
      if (!fallback) return model;
      return { ...model, constraints: { ...model.constraints, durations: fallback.durations } };
    }),
  };
}

/** One video family = the backend models sharing a display name, split by the
 * direction they accept: text-to-video, image-to-video (animate a still), and
 * reference-to-video (a photo drives style/subject, not the first frame). */
export interface VideoFamily {
  key: string;
  name: string;
  textModel?: MediaModel;
  imageModel?: MediaModel;
  referenceModel?: MediaModel;
  modelSets: string[];
}

const VIDEO_ID_SUFFIXES = [
  "-text-to-video",
  "-image-to-video",
  "-reference-to-video",
  "-video-to-video",
];

/** Family key: the Venice display name when present (it is identical across
 * the t2v/i2v variants), else the id minus its direction suffix. */
export function videoFamilyKey(model: MediaModel): string {
  const name = model.name.trim();
  if (name && name !== model.id) {
    return stripDirectionWords(name).toLowerCase();
  }
  let key = model.id;
  for (const suffix of VIDEO_ID_SUFFIXES) {
    if (key.endsWith(suffix)) {
      key = key.slice(0, -suffix.length);
      break;
    }
  }
  return key.toLowerCase();
}

function stripDirectionWords(name: string): string {
  return name
    .replace(/\b(text|image|reference|video)\s+to\s+video\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** image-to-video and reference-to-video share the `imageToVideo` catalog type;
 * the direction word in the id (or display name) tells them apart. A single
 * `imageModel` slot silently dropped every reference-to-video variant, so they
 * get their own slot here. */
function isReferenceToVideo(model: MediaModel): boolean {
  const hay = `${model.id} ${model.name}`.toLowerCase();
  return hay.includes("reference-to-video") || hay.includes("reference to video");
}

export function videoFamilies(catalog: MediaCatalog): VideoFamily[] {
  const families = new Map<string, VideoFamily>();
  const register = (model: MediaModel, slot: "textModel" | "imageModel" | "referenceModel") => {
    const key = videoFamilyKey(model);
    const existing = families.get(key);
    const family: VideoFamily = existing ?? {
      key,
      name: familyDisplayName(model),
      modelSets: [],
    };
    if (!family[slot]) family[slot] = model;
    for (const set of model.modelSets ?? []) {
      if (!family.modelSets.includes(set)) family.modelSets.push(set);
    }
    families.set(key, family);
  };
  for (const model of modelsOfType(catalog, "video")) register(model, "textModel");
  for (const model of modelsOfType(catalog, "imageToVideo")) {
    register(model, isReferenceToVideo(model) ? "referenceModel" : "imageModel");
  }
  return [...families.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function familyDisplayName(model: MediaModel): string {
  const name = model.name.trim();
  if (name && name !== model.id) {
    const stripped = stripDirectionWords(name);
    if (stripped) return stripped;
  }
  return videoFamilyKey(model);
}

/** Per-model music input rules. The catalogs don't publish these, so this is
 * the one place they are hardcoded (matched by id substring, most specific
 * first). Unknown models get the permissive default so new backends models
 * stay usable. */
export interface MusicCapabilities {
  /** Whether the model accepts a dedicated lyrics prompt. */
  lyrics: "required" | "optional" | "none";
  instrumental: boolean;
  durationSeconds?: { min: number; max: number; step: number };
}

const MUSIC_CAPABILITIES: Array<{ match: string; caps: MusicCapabilities }> = [
  {
    match: "ace-step",
    caps: {
      lyrics: "optional",
      instrumental: true,
      durationSeconds: { min: 60, max: 210, step: 30 },
    },
  },
  // elevenlabs-music rejects lyrics_prompt with a 400 (unlike its Venice docs).
  { match: "elevenlabs-music", caps: { lyrics: "none", instrumental: true } },
  { match: "minimax-music", caps: { lyrics: "required", instrumental: false } },
  { match: "lyria", caps: { lyrics: "none", instrumental: true } },
  {
    match: "stable-audio",
    caps: { lyrics: "none", instrumental: true, durationSeconds: { min: 5, max: 180, step: 5 } },
  },
  {
    match: "sound-effects",
    caps: { lyrics: "none", instrumental: true, durationSeconds: { min: 1, max: 22, step: 1 } },
  },
  {
    match: "mmaudio",
    caps: { lyrics: "none", instrumental: true, durationSeconds: { min: 1, max: 30, step: 1 } },
  },
];

export function musicCapabilities(modelId: string): MusicCapabilities {
  const id = modelId.toLowerCase();
  for (const entry of MUSIC_CAPABILITIES) {
    if (id.includes(entry.match)) return entry.caps;
  }
  return { lyrics: "optional", instrumental: true };
}

/** Estimated cost of a generation, in credits, when the catalog knows it.
 * Music models price by duration brackets; flat-priced media use costCredits. */
export function estimateCostCredits(
  model: MediaModel,
  options: { durationSeconds?: number; multiplier?: number } = {},
): number | undefined {
  const brackets = durationBrackets(model);
  if (brackets && options.durationSeconds !== undefined) {
    const bracket = brackets.find(
      (entry) =>
        options.durationSeconds !== undefined &&
        options.durationSeconds >= entry.minSeconds &&
        options.durationSeconds <= entry.maxSeconds,
    );
    if (bracket) {
      const multiplier = options.multiplier ?? 1;
      return round2(bracket.usd * 100 * multiplier);
    }
  }
  if (model.costCredits !== undefined) return round2(model.costCredits);
  return undefined;
}

interface DurationBracket {
  minSeconds: number;
  maxSeconds: number;
  usd: number;
}

function durationBrackets(model: MediaModel): DurationBracket[] | undefined {
  const durations = model.pricing?.durations;
  if (!durations || typeof durations !== "object") return undefined;
  const brackets: DurationBracket[] = [];
  for (const value of Object.values(durations as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.usd === "number" &&
      typeof entry.min_seconds === "number" &&
      typeof entry.max_seconds === "number"
    ) {
      brackets.push({
        minSeconds: entry.min_seconds,
        maxSeconds: entry.max_seconds,
        usd: entry.usd,
      });
    }
  }
  brackets.sort((a, b) => a.minSeconds - b.minSeconds);
  return brackets.length > 0 ? brackets : undefined;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatCredits(credits: number): string {
  // Thousands separators keep large balances scannable ("12,450 credits").
  if (credits >= 100) return `${Math.round(credits).toLocaleString("en-US")} credits`;
  return `${credits.toFixed(credits < 1 ? 2 : 1)} credits`;
}
