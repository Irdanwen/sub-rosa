// Studio model catalog: fetch + cache the merged catalog from the Rust proxy
// and derive the model groupings the views need. The backends expose the same
// video family twice (a text-to-video id and an image-to-video id); the studio
// presents one family with a Text/Image toggle, like a single "model".

import { invoke } from "@tauri-apps/api/core";
import { probedConstraints } from "./model-constraints";
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
        const patched = withVideoConstraintFallbacks(catalog);
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

/** Every catalog type that ends up in a video family: all three take the same
 * constraint fallbacks (a seedance reference-to-video rejects a request with no
 * `duration` exactly like its text variant does). */
const VIDEO_MEDIA_TYPES: MediaType[] = ["video", "imageToVideo", "referenceToVideo"];

/**
 * Fill in what the catalog leaves empty for a video model.
 *
 * The enrichment pass matches operator models against Venice's public catalog,
 * which does not publish several whole families - 43 of 101 video models come
 * back with no `aspect_ratios`, and the seedance ones with no durations at all.
 * The studio only offers what it can see, so those models were queued without
 * the fields the provider requires, and the render failed after being queued.
 *
 * Published constraints always win; this only ever fills a hole. See
 * `./model-constraints` for where the values come from and how a rejection
 * teaches the studio more.
 */
export function withVideoConstraintFallbacks(catalog: MediaCatalog): MediaCatalog {
  return {
    ...catalog,
    models: catalog.models.map((model) => {
      if (!VIDEO_MEDIA_TYPES.includes(model.mediaType)) return model;
      const probed = probedConstraints(model.id);
      if (!probed) return model;
      const constraints = { ...model.constraints };
      let changed = false;
      if (!constraints.durations?.length && probed.durations?.length) {
        constraints.durations = probed.durations;
        changed = true;
      }
      if (!constraints.aspect_ratios?.length && probed.aspectRatios?.length) {
        constraints.aspect_ratios = probed.aspectRatios;
        changed = true;
      }
      if (!constraints.resolutions?.length && probed.resolutions?.length) {
        constraints.resolutions = probed.resolutions;
        changed = true;
      }
      return changed ? { ...model, constraints } : model;
    }),
  };
}

/** One video family = the backend models sharing a display name, split by the
 * direction they accept: text-to-video, image-to-video (animate a still),
 * reference-to-video (a photo drives style/subject, not the first frame), and
 * video-to-video (restyle or upscale an existing clip). */
export interface VideoFamily {
  key: string;
  name: string;
  textModel?: MediaModel;
  imageModel?: MediaModel;
  referenceModel?: MediaModel;
  videoModel?: MediaModel;
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

/** The shorthand the catalog appends to a variant's display name ("Kling O3 4K
 * R2V", "Wan 2.7 Reference", "Grok Imagine R2V"). It names the direction, not
 * the family, so leaving it in splits one family into two. */
const DIRECTION_NAME_SUFFIX = /\s+(r2v|i2v|t2v|v2v|reference)$/i;

function stripDirectionWords(name: string): string {
  return name
    .replace(/\b(text|image|reference|video)\s+to\s+video\b/gi, "")
    .replace(DIRECTION_NAME_SUFFIX, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Reference-to-video mostly has its own catalog type now, but a few families
 * (the grok ones, probed 2026-08-02) are still published as `imageToVideo`,
 * where only the direction word in the id (or display name) tells the two
 * apart. A single `imageModel` slot silently dropped every reference-to-video
 * variant, so they get their own slot here. */
function isReferenceToVideo(model: MediaModel): boolean {
  const hay = `${model.id} ${model.name}`.toLowerCase();
  return hay.includes("reference-to-video") || hay.includes("reference to video");
}

/** True for a model whose contract takes style/subject reference photos. Every
 * such id carries the direction (checked across both catalogs), so this holds
 * for the ones the operator types `referenceToVideo` and for the few it still
 * types `imageToVideo`. */
export function isReferenceToVideoModel(modelId: string): boolean {
  return modelId.toLowerCase().includes("reference-to-video");
}

/** Video upscalers (e.g. `topaz-video-upscale`) take a source clip plus an
 * `upscale_factor` instead of a prompt-driven restyle. */
export function isVideoUpscaleModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return id.includes("video-upscale") || id.includes("upscale-video");
}

/** The seedance family. Its image/reference-to-video endpoint gates any
 * reference that carries a human face behind a face-media consent attestation
 * (see `./consent`), so the studios need to tell it apart from every other
 * video model. Matched by id substring across every seedance variant. */
export function isSeedanceModel(modelId: string): boolean {
  return modelId.toLowerCase().includes("seedance");
}

/** video-to-video variants (restyle a clip) and upscalers share the `video`
 * catalog type with text-to-video; without their own slot they used to shadow
 * (or be shadowed by) the text variant of the same family. */
function isVideoToVideo(model: MediaModel): boolean {
  const hay = `${model.id} ${model.name}`.toLowerCase();
  return (
    hay.includes("video-to-video") ||
    hay.includes("video to video") ||
    isVideoUpscaleModel(model.id)
  );
}

export function videoFamilies(catalog: MediaCatalog): VideoFamily[] {
  const families = new Map<string, VideoFamily>();
  const register = (
    model: MediaModel,
    slot: "textModel" | "imageModel" | "referenceModel" | "videoModel",
  ) => {
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
  for (const model of modelsOfType(catalog, "video")) {
    register(model, isVideoToVideo(model) ? "videoModel" : "textModel");
  }
  for (const model of modelsOfType(catalog, "imageToVideo")) {
    register(model, isReferenceToVideo(model) ? "referenceModel" : "imageModel");
  }
  for (const model of modelsOfType(catalog, "referenceToVideo")) {
    register(model, "referenceModel");
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

/** Which slot a set of inputs resolves to. Reference wins whenever photos are
 * present, because it is the only variant that takes both a starting frame and
 * references; without photos an opening frame means image-to-video, and
 * nothing at all means text-to-video. */
export function variantFor(
  family: VideoFamily | undefined,
  { hasFrame, hasReferences }: { hasFrame: boolean; hasReferences: boolean },
): MediaModel | undefined {
  if (!family) return undefined;
  if (hasReferences) return family.referenceModel ?? family.imageModel ?? family.textModel;
  if (hasFrame) return family.imageModel ?? family.referenceModel ?? family.textModel;
  return family.textModel ?? family.imageModel ?? family.referenceModel;
}

/** How a resolved variant reads next to the family name. */
export function variantLabel(modelId: string): string {
  if (isReferenceToVideoModel(modelId)) return "reference to video";
  if (modelId.includes("image-to-video")) return "image to video";
  if (modelId.includes("video-to-video")) return "video to video";
  return "text to video";
}

/** The "Automatic" edit model: a capable, reasonably priced default so the
 * edit surfaces work without picking a model first. Preference order favors
 * instruction-following editors that handle both photos and renders well;
 * unknown catalogs fall back to their first edit model. */
const AUTO_EDIT_PREFERENCE = [
  "qwen-image-2-edit",
  "seedream-v5-lite-edit",
  "seedream-v4-edit",
  "nano-banana-2-edit",
];

export function defaultEditModel(catalog: MediaCatalog): MediaModel | undefined {
  const models = imageEditModels(catalog);
  for (const preferred of AUTO_EDIT_PREFERENCE) {
    const hit = models.find((model) => model.id.toLowerCase() === preferred);
    if (hit) return hit;
  }
  return models[0];
}

/** Background removal is a dedicated Venice endpoint
 * (`/image/background-remove`), not a model call. The Carpe Diem operator does
 * not mirror it yet - its catalog lists `bria-bg-remover` but no route accepts
 * that model (probed 2026-07-20), so the surface only lights up on the Venice
 * backend until the operator adds the mirror (as it did for `/image/multi-edit`). */
export function supportsBackgroundRemoval(catalog: MediaCatalog): boolean {
  return catalog.backend === "venice";
}

/** Sound-effect generators ride the music queue (same `music` catalog type,
 * same endpoints) but are a different tool: short foley or ambience from a
 * one-line description, not a track. The catalogs don't flag them, so they
 * are told apart by id. */
export function isSoundEffectsModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return id.includes("sound-effect") || id.includes("mmaudio");
}

/** Music models for the music surface: the `music` catalog type minus the
 * sound-effect generators, which get their own surface. */
export function musicModels(catalog: MediaCatalog): MediaModel[] {
  return modelsOfType(catalog, "music").filter((model) => !isSoundEffectsModel(model.id));
}

export function soundEffectsModels(catalog: MediaCatalog): MediaModel[] {
  return modelsOfType(catalog, "music").filter((model) => isSoundEffectsModel(model.id));
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
