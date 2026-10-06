// Studio model catalog: fetch + cache the merged catalog from the Rust proxy
// and derive the model groupings the views need. The backends expose the same
// video family twice (a text-to-video id and an image-to-video id); the studio
// presents one family with a Text/Image toggle, like a single "model".

import { intlLocale, t } from "../i18n";
import { invoke } from "@tauri-apps/api/core";
import { probedConstraints } from "./model-constraints";
import inputRules from "./model-input-rules.json";
import type { AudioConstraints, MediaCatalog, MediaModel, MediaType } from "./types";

const CATALOG_TTL_MS = 5 * 60 * 1000;

let cached: { catalog: MediaCatalog; fetchedAt: number } | undefined;
let inflight: Promise<MediaCatalog> | undefined;
let cacheGeneration = 0;

export async function fetchMediaCatalog(force = false): Promise<MediaCatalog> {
  if (!force && cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
    return cached.catalog;
  }
  if (!inflight) {
    const generation = cacheGeneration;
    const request = invoke<MediaCatalog>("carpe_diem_media_catalog")
      .then((catalog) => {
        const patched = withVideoConstraintFallbacks(catalog);
        // A settings change can start a new request before this one finishes.
        // Its response must never restore the old backend's catalog.
        if (generation === cacheGeneration) cached = { catalog: patched, fetchedAt: Date.now() };
        return patched;
      })
      .finally(() => {
        if (inflight === request) inflight = undefined;
      });
    inflight = request;
  }
  return inflight;
}

/** Test seam + settings-change hook: drop the cache so the next fetch is live. */
export function resetMediaCatalogCache() {
  cacheGeneration += 1;
  cached = undefined;
  inflight = undefined;
}

export function modelsOfType(catalog: MediaCatalog, type: MediaType): MediaModel[] {
  return catalog.models
    .filter((model) => model.mediaType === type && !model.offline)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Image-typed entries that make nothing from a prompt.
 *
 * The catalog files a background remover under `image` because that is what
 * it returns. Offered as a generator it takes a prompt, spends, and answers
 * with an error, so the generation pickers leave it out.
 */
const NOT_A_GENERATOR = /(?:^|-)(?:bg-remover|background-remov)/i;

/** The models that turn a prompt into a picture, by name. */
export function imageGenerationModels(catalog: MediaCatalog): MediaModel[] {
  return modelsOfType(catalog, "image").filter((model) => !NOT_A_GENERATOR.test(model.id));
}

/**
 * What a new generation starts on, best first.
 *
 * Chosen for the user, not by alphabet: sorting by name made a stylised anime
 * model the default for everyone. A catalog without these falls back to its
 * first generator rather than to nothing.
 */
export const PREFERRED_IMAGE_MODELS = ["gpt-image-2-5-flare", "gpt-image-2"];

const IMAGE_MODEL_STORAGE_KEY = "subrosa:studio:image-model";

/**
 * The generation model to open on: the one last chosen here while the catalog
 * still offers it, else the preferred one, else the first.
 */
export function defaultImageModel(catalog: MediaCatalog): MediaModel | undefined {
  const models = imageGenerationModels(catalog);
  let remembered: string | null = null;
  try {
    remembered = window.localStorage.getItem(IMAGE_MODEL_STORAGE_KEY);
  } catch {
    // A remembered choice is a nicety.
  }
  const chosen = remembered ? models.find((model) => model.id === remembered) : undefined;
  if (chosen) return chosen;
  for (const preferred of PREFERRED_IMAGE_MODELS) {
    const hit = models.find((model) => model.id === preferred);
    if (hit) return hit;
  }
  return models[0];
}

/** Remembers the generation model the user picked, for the next visit. */
export function rememberImageModel(id: string): void {
  try {
    window.localStorage.setItem(IMAGE_MODEL_STORAGE_KEY, id);
  } catch {
    // Ignore: the default is a good answer too.
  }
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
  // An explicit offline entry is authoritative too: do not resurrect it as
  // an unlisted passthrough after modelsOfType has filtered it out.
  const seen = new Set(catalog.models.map((model) => model.id));
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
      // An absent field means "nobody said"; a published *empty* list means
      // "this model does not take that field" (the catalogs' own convention
      // for, say, aspect_ratio on an image-to-video model). Only the first is
      // a hole to fill - overriding the second would invent a control.
      const fill = (
        current: string[] | undefined,
        probedValues: string[] | undefined,
      ): string[] | undefined => {
        if (current !== undefined || !probedValues?.length) return current;
        changed = true;
        return probedValues;
      };
      constraints.durations = fill(constraints.durations, probed.durations);
      constraints.aspect_ratios = fill(constraints.aspect_ratios, probed.aspectRatios);
      constraints.resolutions = fill(constraints.resolutions, probed.resolutions);
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
 * the t2v/i2v variants), else the id minus its direction segment.
 *
 * Cut out rather than trimmed off the end, because the direction is not always
 * last: the public tier appends `-basic` after it. That suffix has to stay in
 * the key - the two tiers are different models with different limits and
 * different person-media policies, and merging them would put a clip slot in
 * front of the one that refuses clips. */
export function videoFamilyKey(model: MediaModel): string {
  const name = model.name.trim();
  if (name && name !== model.id) {
    return stripDirectionWords(name).toLowerCase();
  }
  let key = model.id;
  for (const suffix of VIDEO_ID_SUFFIXES) {
    const at = key.indexOf(suffix);
    if (at >= 0) {
      key = key.slice(0, at) + key.slice(at + suffix.length);
      break;
    }
  }
  return key.toLowerCase();
}

/** The public tier's id suffix. Venice names these models and documents them
 * as the openly available ones; the sibling without it is the full model. */
const BASIC_TIER_SUFFIX = "-basic";

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

/**
 * The kling reference variants (o3 standard/pro/4k, v3 4k).
 *
 * They read references as `elements` and `scene_image_urls` rather than the
 * flat `reference_image_urls` (see `./kling`), and they also take an opening
 * frame (`image_url`) and an end frame alongside them. Matched by family stem:
 * the four variants share one provider contract.
 */
export function isKlingReferenceModel(modelId: string | undefined): boolean {
  const id = modelId?.toLowerCase() ?? "";
  return id.startsWith("kling-") && isReferenceToVideoModel(id);
}

/**
 * Whether this reference model refuses to start without an opening frame.
 *
 * Kling V3's reference variant does, whatever else it is given: "image_url is
 * required for this model (a start frame image must be provided)", even with
 * elements and scene images in the body (measured 2026-10-01). The O3 variants
 * do not - they run on elements alone. The refusal arrives at render time,
 * after a 202, so it is answered here, before the request leaves.
 */
export function requiresOpeningFrame(modelId: string | undefined): boolean {
  const id = modelId?.toLowerCase() ?? "";
  return id.startsWith("kling-v3-") && isReferenceToVideoModel(id);
}

/**
 * Whether this reference model also takes the frame the clip starts from.
 *
 * Optional on kling O3, which runs on its references alone once they travel
 * as elements; required on kling V3 (see `requiresOpeningFrame`). It was once
 * held required for the whole family - a misread of kling refusing the flat
 * reference field, which left the frame as the only visual input the request
 * carried (see `./kling`). The reference families that take no frame quietly
 * ignore one, so the port stays closed on them.
 */
export function acceptsOpeningFrameWithReferences(modelId: string | undefined): boolean {
  return isKlingReferenceModel(modelId);
}

/** True for a model whose contract opens on a supplied frame (`image_url`,
 * and `end_image_url` where the family takes one). Reference-to-video ids do
 * not match: they carry their references and are told apart above. */
export function isImageToVideoModel(modelId: string): boolean {
  return modelId.toLowerCase().includes("image-to-video");
}

/** Which inputs a video model's contract is built around: a prompt alone, a
 * supplied frame, style/subject photos, or a source clip. */
export type VideoDirection = "text" | "image" | "reference" | "video";

/**
 * The direction of a model the catalog is in hand for.
 *
 * The operator's own `carpe_diem_type` is the trustworthy answer and the id is
 * only a hint: of the 101 video models it publishes, **nine carry no direction
 * in their id at all**, and five of those are image-to-video - including
 * `flux-3-first-last-frame-to-video` and the two `pixverse-*-transition`
 * models, whose whole point is the opening and end frames. Reading the id
 * alone would take the frames away from exactly the models that exist for
 * them.
 *
 * The id still decides the reference direction, because six models the
 * operator still types `imageToVideo` are reference-to-video (the grok ones),
 * which only their id and name say.
 */
export function videoDirection(model: MediaModel): VideoDirection {
  if (isVideoUpscaleModel(model.id) || isVideoToVideo(model)) return "video";
  if (model.mediaType === "referenceToVideo" || isReferenceToVideo(model)) return "reference";
  if (model.mediaType === "imageToVideo") return "image";
  return "text";
}

/**
 * The direction an id alone can vouch for, or undefined when it names none.
 *
 * The fallback for everywhere that has no catalog: the workflow validator, the
 * engine, and any graph built outside the editor. Undefined is a real answer
 * and must stay one - "this id says nothing" is not "text to video", and a
 * surface that treated it as such would close the frame port on
 * `runway-gen4-turbo`.
 */
export function videoDirectionFromId(modelId: string): VideoDirection | undefined {
  const id = modelId.toLowerCase();
  if (isVideoUpscaleModel(id) || id.includes("video-to-video")) return "video";
  if (isReferenceToVideoModel(id)) return "reference";
  if (isImageToVideoModel(id)) return "image";
  if (id.includes("text-to-video")) return "text";
  return undefined;
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
    const family: VideoFamily = existing ?? { key, name: key, modelSets: [] };
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
  // Named last, when every slot is filled and the whole catalog is in hand:
  // whether a family needs its tier spelled out depends on whether the other
  // tier is on offer at all.
  const catalogIds = new Set(catalog.models.map((model) => model.id));
  for (const family of families.values()) {
    family.name = familyDisplayName(family, catalogIds);
  }
  return [...families.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The models a family stands for, in slot order. */
function slotModels(family: VideoFamily): MediaModel[] {
  return [family.textModel, family.imageModel, family.referenceModel, family.videoModel].filter(
    (model): model is MediaModel => Boolean(model),
  );
}

/**
 * What to call a family in a picker.
 *
 * Venice's display name when any variant has one. When none does - which is how
 * the full (non-`-basic`) tier arrives, because Venice's public catalog lists
 * only the public tier - the id is made readable instead of being shown raw.
 * `seedance-2-0` next to `Seedance 2.0` reads as a leftover rather than as the
 * more capable of the two, which is the wrong way round: the full tier is the
 * one that takes reference clips and does not refuse people.
 *
 * The tier is spelled out only when both tiers are actually in the catalog.
 * Tagging a family that has no sibling would invent a distinction, and every
 * upscaler and one-off would carry a label that means nothing.
 */
function familyDisplayName(family: VideoFamily, catalogIds: ReadonlySet<string>): string {
  const models = slotModels(family);
  const named = models.find((model) => model.name.trim() && model.name.trim() !== model.id);
  if (named) {
    const stripped = stripDirectionWords(named.name.trim());
    if (stripped) return stripped;
  }
  const isBasic = family.key.endsWith(BASIC_TIER_SUFFIX);
  const base = humanizeModelId(
    isBasic ? family.key.slice(0, -BASIC_TIER_SUFFIX.length) : family.key,
  );
  const hasSibling = models.some((model) =>
    isBasic
      ? catalogIds.has(model.id.slice(0, -BASIC_TIER_SUFFIX.length))
      : catalogIds.has(`${model.id}${BASIC_TIER_SUFFIX}`),
  );
  if (!hasSibling) return base;
  return isBasic ? `${base} (basic)` : `${base} (full)`;
}

/**
 * A hyphenated model id, made readable: `seedance-2-0-fast` reads as
 * "Seedance 2.0 Fast".
 *
 * Deliberately conservative - it only changes case and separators, and rejoins
 * the digit runs that spell a version. Anything cleverer would be guessing at
 * names the catalogs never gave us.
 */
export function humanizeModelId(id: string): string {
  const words: string[] = [];
  for (const token of id.split("-").filter(Boolean)) {
    const previous = words.at(-1);
    // "2" then "0" is a version, not two words.
    if (/^\d+$/.test(token) && previous && /\d$/.test(previous)) {
      words[words.length - 1] = `${previous}.${token}`;
      continue;
    }
    words.push(/^[a-z]/.test(token) ? token[0].toUpperCase() + token.slice(1) : token);
  }
  return words.join(" ");
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

/** How a resolved variant reads next to the family name - the English
 * spelling people type into a search box. What is shown goes through
 * `directionLabel`. */
export function variantLabel(modelId: string): string {
  if (isReferenceToVideoModel(modelId)) return "reference to video";
  if (modelId.includes("image-to-video")) return "image to video";
  if (modelId.includes("video-to-video")) return "video to video";
  return "text to video";
}

/** A direction, in the reader's language. */
export function directionLabel(direction: VideoDirection): string {
  switch (direction) {
    case "reference":
      return t("Reference to video");
    case "image":
      return t("Image to video");
    case "video":
      return t("Video to video");
    default:
      return t("Text to video");
  }
}

/** The directions a family offers, in the order its slots are read. */
export function familyDirections(family: VideoFamily): VideoDirection[] {
  const directions: VideoDirection[] = [];
  if (family.textModel) directions.push("text");
  if (family.imageModel) directions.push("image");
  if (family.referenceModel) directions.push("reference");
  if (family.videoModel) directions.push("video");
  return directions;
}

/**
 * The nearest family that renders from references alone, for a family whose
 * reference variant insists on an opening frame (`requiresOpeningFrame`).
 *
 * Same vendor - the first token of the key - and the candidate sharing the
 * most of the remaining tokens wins, so "kling v3 4k" is offered "kling o3
 * 4k" rather than "kling o3 standard". Undefined when nothing fits, or when
 * the family's own reference variant already runs without a frame.
 */
export function frameFreeReferenceSibling(
  families: readonly VideoFamily[],
  family: VideoFamily,
): VideoFamily | undefined {
  if (!family.referenceModel || !requiresOpeningFrame(family.referenceModel.id)) return undefined;
  const tokens = (key: string) =>
    key
      .toLowerCase()
      .split(/[\s_-]+/)
      .filter(Boolean);
  const own = tokens(family.key);
  const vendor = own[0];
  if (!vendor) return undefined;
  let best: { family: VideoFamily; shared: number } | undefined;
  for (const candidate of families) {
    if (candidate.key === family.key || !candidate.referenceModel) continue;
    if (requiresOpeningFrame(candidate.referenceModel.id)) continue;
    const theirs = tokens(candidate.key);
    if (theirs[0] !== vendor) continue;
    const shared = own.slice(1).filter((token) => theirs.includes(token)).length;
    if (!best || shared > best.shared) best = { family: candidate, shared };
  }
  return best?.family;
}

/**
 * What to say about the variant the inputs resolved to, or undefined when it is
 * the family's plain text-to-video and there is nothing to add.
 *
 * The variant is not a setting the user picked: it follows from which inputs are
 * filled in, and it changes both the contract and the price. So it is named
 * rather than left to be inferred. The backend's own name for the variant is
 * appended whenever it differs from the family name, because that is the string
 * the user goes looking for ("Seedance 2.5 R2V") and it appears nowhere else.
 */
export function variantHint(
  family: VideoFamily | undefined,
  model: MediaModel | undefined,
): string | undefined {
  if (!model) return undefined;
  if (model.id === family?.textModel?.id) return undefined;
  const label = directionLabel(videoDirectionFromId(model.id) ?? "text");
  const name = model.name.trim();
  return name && name !== model.id && name !== family?.name ? `${label} · ${name}` : label;
}

/** Direction shorthands people type into a search box, per family slot. The
 * long forms come from `variantLabel`; these are the spellings it does not
 * produce, including the ones only ever seen in a model's own display name. */
const DIRECTION_ALIASES = {
  textModel: ["t2v"],
  imageModel: ["i2v"],
  // "rtv" is not a real spelling anywhere upstream, and is exactly what people
  // type: the direction is read aloud as "reference to video".
  referenceModel: ["r2v", "rtv", "reference"],
  videoModel: ["v2v", "restyle"],
} as const;

/**
 * Everything a family should be findable by.
 *
 * A video family is one picker row standing in for up to four backend models,
 * and the row shows only the family name. Searching the visible text therefore
 * cannot find a variant: "Seedance 2.5 R2V" is a real model with a real name,
 * but the list says "Seedance 2.5" and its key is `seedance 2.5`, so neither
 * `r2v` nor `seedance-2-5` matches anything. These terms put every variant's id
 * and name back into the search, with the shorthands, and compose the family
 * name with each shorthand so "seedance 2.5 r2v" matches families whose backend
 * name carries no shorthand of its own.
 */
export function videoFamilySearchTerms(family: VideoFamily): string[] {
  const terms = new Set<string>([family.name, family.key]);
  for (const [slot, aliases] of Object.entries(DIRECTION_ALIASES)) {
    const model = family[slot as keyof typeof DIRECTION_ALIASES];
    if (!model) continue;
    terms.add(model.id);
    terms.add(model.name);
    const spoken = directionLabel(videoDirectionFromId(model.id) ?? "text");
    for (const alias of [...aliases, variantLabel(model.id), spoken]) {
      terms.add(alias);
      terms.add(`${family.name} ${alias}`);
    }
  }
  return [...terms].filter((term) => term.trim().length > 0);
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

/** Which surface an audio model belongs to (ADR-0076). The catalog type says
 * which endpoint serves a model, not what it does: the music queue also
 * carries sound effects and speech. The role is read from what the model
 * publishes, and only falls back to its id where nothing is published. */
export type AudioRole = "speech" | "music" | "effects";

/** How a speaking model is reached: `/audio/speech` answers in one call, the
 * music queue answers later and is a durable job (ADR-0018). */
export type SpeechRail = "speech" | "queue";

function audioConstraints(model: MediaModel | undefined): AudioConstraints | undefined {
  return model?.constraints as AudioConstraints | undefined;
}

/** Voices a model speaks in: top-level for `/audio/speech` models, inside the
 * constraints for the speaking models of the music queue. */
export function modelVoices(model: MediaModel | undefined): string[] {
  if (!model) return [];
  if (model.voices && model.voices.length > 0) return model.voices;
  const voices = audioConstraints(model)?.voices;
  return Array.isArray(voices) ? voices.filter((voice) => typeof voice === "string") : [];
}

/** The voice a model uses when none is sent, when it says so. */
export function defaultVoice(model: MediaModel | undefined): string | undefined {
  const named = audioConstraints(model)?.default_voice;
  const voices = modelVoices(model);
  return typeof named === "string" && voices.includes(named) ? named : voices[0];
}

/** Sound-effect generators are told apart by what they offer (a seamless
 * loop) or, failing that, by id: no catalog flags them. */
export function isSoundEffectsModel(model: MediaModel | string): boolean {
  const id = (typeof model === "string" ? model : model.id).toLowerCase();
  if (typeof model !== "string" && audioConstraints(model)?.supports_loop === true) return true;
  return id.includes("sound-effect") || id.includes("mmaudio");
}

/** A queue model that reads its prompt aloud: it publishes voices, and takes
 * neither lyrics nor a length (ElevenLabs TTS v3/v4, Seed Audio). */
function speaksOnQueue(model: MediaModel): boolean {
  if (model.mediaType !== "music" || modelVoices(model).length === 0) return false;
  const c = audioConstraints(model);
  const takesLength =
    (c?.duration_options?.length ?? 0) > 0 ||
    c?.min_duration !== undefined ||
    c?.max_duration !== undefined;
  return !takesLength && c?.supports_lyrics !== true;
}

export function audioRole(model: MediaModel): AudioRole | undefined {
  if (model.mediaType === "tts") return "speech";
  if (model.mediaType !== "music") return undefined;
  if (speaksOnQueue(model)) return "speech";
  return isSoundEffectsModel(model) ? "effects" : "music";
}

export function speechRail(model: MediaModel): SpeechRail {
  return model.mediaType === "music" ? "queue" : "speech";
}

function modelsWithRole(catalog: MediaCatalog, role: AudioRole): MediaModel[] {
  return catalog.models
    .filter((model) => !model.offline && audioRole(model) === role)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every model that speaks a text, on either rail. */
export function speechModels(catalog: MediaCatalog): MediaModel[] {
  return modelsWithRole(catalog, "speech");
}

/** Music models for the music surface. */
export function musicModels(catalog: MediaCatalog): MediaModel[] {
  return modelsWithRole(catalog, "music");
}

export function soundEffectsModels(catalog: MediaCatalog): MediaModel[] {
  return modelsWithRole(catalog, "effects");
}

/** What a queue model accepts, shared by Studio, workflow, film and native
 * assistant proposals. Read from the published constraints first (ADR-0076);
 * the measured table in `model-input-rules.json` only answers for a model
 * that publishes nothing, matched by id substring, most specific first. */
export interface MusicCapabilities {
  /** Whether the model accepts a dedicated lyrics prompt. */
  lyrics: "required" | "optional" | "none";
  /** Whether `force_instrumental` may be sent at all. */
  instrumental: boolean;
  /** `options` is the exact list when the model publishes one. */
  durationSeconds?: {
    min: number;
    max: number;
    step: number;
    default?: number;
    options?: number[];
  };
  /** The model can write the lyrics itself from the prompt. */
  lyricsOptimizer?: boolean;
  /** The clip can be rendered to splice back into its own start. */
  loop?: boolean;
  promptLimit?: number;
  lyricsLimit?: number;
  /** False when these come from the fallback table, not the model. */
  published: boolean;
}

const MUSIC_CAPABILITIES = inputRules.music as Array<{
  match: string;
  caps: Omit<MusicCapabilities, "published">;
}>;

/** Keys whose presence proves the catalog described this model's parameters.
 * Only then is a missing duration a statement ("takes none"), as the operator
 * reads it too. */
const DESCRIBED_BY: Array<keyof AudioConstraints> = [
  "supports_lyrics",
  "lyrics_required",
  "supports_force_instrumental",
  "supports_speed",
  "supported_formats",
  "prompt_character_limit",
  "min_prompt_length",
];

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function publishedDuration(c: AudioConstraints): MusicCapabilities["durationSeconds"] {
  const options = (c.duration_options ?? [])
    .filter((value) => finite(value) !== undefined && value > 0)
    .sort((a, b) => a - b);
  const fallbackDefault = finite(c.default_duration);
  if (options.length > 0) {
    const gaps = options.slice(1).map((value, index) => value - options[index]);
    const even = gaps.length > 0 && gaps.every((gap) => gap === gaps[0]);
    return {
      min: options[0],
      max: options[options.length - 1],
      step: even ? gaps[0] : 1,
      default:
        fallbackDefault !== undefined && options.includes(fallbackDefault)
          ? fallbackDefault
          : options[0],
      options,
    };
  }
  const min = finite(c.min_duration);
  const max = finite(c.max_duration);
  if (min === undefined && max === undefined) {
    // A bare default still means the model takes a length; it is the only
    // one that can be named.
    return fallbackDefault !== undefined
      ? { min: fallbackDefault, max: fallbackDefault, step: 1, default: fallbackDefault }
      : undefined;
  }
  const low = min ?? 1;
  const high = Math.max(low, max ?? fallbackDefault ?? low);
  const dflt = fallbackDefault !== undefined ? Math.min(Math.max(fallbackDefault, low), high) : low;
  return { min: low, max: high, step: 1, default: dflt };
}

function publishedMusicCapabilities(
  c: AudioConstraints | undefined,
): MusicCapabilities | undefined {
  if (!c || !DESCRIBED_BY.some((key) => c[key] !== undefined)) return undefined;
  return {
    lyrics:
      c.supports_lyrics === false ? "none" : c.lyrics_required === true ? "required" : "optional",
    instrumental: c.supports_force_instrumental === true,
    durationSeconds: publishedDuration(c),
    lyricsOptimizer: c.supports_lyrics_optimizer === true,
    loop: c.supports_loop === true,
    promptLimit: finite(c.prompt_character_limit),
    lyricsLimit: finite(c.lyrics_character_limit),
    published: true,
  };
}

/** Pass the model when you have it; an id is resolved against the cached
 * catalog so a caller holding only an id still reads what was published. */
export function musicCapabilities(model: MediaModel | string | undefined): MusicCapabilities {
  const entry =
    typeof model === "string"
      ? cached?.catalog.models.find((candidate) => candidate.id === model)
      : model;
  const published = publishedMusicCapabilities(audioConstraints(entry));
  if (published) return published;
  const id = (typeof model === "string" ? model : (model?.id ?? "")).toLowerCase();
  for (const row of MUSIC_CAPABILITIES) {
    if (id.includes(row.match)) return { ...row.caps, published: false };
  }
  return { lyrics: "optional", instrumental: false, published: false };
}

/** A length the model will take: snapped to its published list or step and
 * clamped to its range. Undefined when the model takes no length at all. */
export function acceptedDuration(
  caps: MusicCapabilities,
  seconds: number | undefined,
): number | undefined {
  const range = caps.durationSeconds;
  if (!range) return undefined;
  const wanted = seconds ?? range.default ?? range.min;
  if (range.options && range.options.length > 0) {
    return range.options.reduce((best, option) =>
      Math.abs(option - wanted) < Math.abs(best - wanted) ? option : best,
    );
  }
  const clamped = Math.min(Math.max(wanted, range.min), range.max);
  const steps = Math.round((clamped - range.min) / range.step);
  return Math.min(range.max, range.min + steps * range.step);
}

export interface MusicRequest {
  model: string;
  prompt: string;
  lyrics?: string;
  instrumental?: boolean;
  /** Let the model write the lyrics (only where it can). */
  writeLyrics?: boolean;
  durationSeconds?: number;
  /** Leave the length to the model (sound effects): no length is sent. */
  autoDuration?: boolean;
  loop?: boolean;
}

/** The queue body, built in one place for every caller. A key goes out only
 * when the model accepts it: Venice refuses an unknown key even when its
 * value is a no-op (`force_instrumental: false` was a 400). */
export function musicQueueBody(
  caps: MusicCapabilities,
  request: MusicRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = { model: request.model, prompt: request.prompt.trim() };
  const instrumental = caps.instrumental && request.instrumental === true;
  const writeLyrics =
    caps.lyricsOptimizer === true && request.writeLyrics === true && !instrumental;
  const lyrics = request.lyrics?.trim();
  if (caps.lyrics !== "none" && !instrumental && !writeLyrics && lyrics)
    body.lyrics_prompt = lyrics;
  if (instrumental) body.force_instrumental = true;
  if (writeLyrics) body.lyrics_optimizer = true;
  const duration = request.autoDuration
    ? undefined
    : acceptedDuration(caps, request.durationSeconds);
  if (duration !== undefined) body.duration_seconds = duration;
  if (caps.loop === true && request.loop === true) body.loop = true;
  return body;
}

/** Why a music request cannot go out yet, or undefined when it can. */
export function musicRequestMissing(
  caps: MusicCapabilities,
  request: Pick<MusicRequest, "lyrics" | "instrumental" | "writeLyrics">,
): "lyrics" | undefined {
  const instrumental = caps.instrumental && request.instrumental === true;
  const writeLyrics = caps.lyricsOptimizer === true && request.writeLyrics === true;
  return caps.lyrics === "required" && !instrumental && !writeLyrics && !request.lyrics?.trim()
    ? "lyrics"
    : undefined;
}

/** Estimated cost of a generation, in credits, when the catalog knows it.
 * Music models price by duration brackets; flat-priced media use costCredits. */
export function estimateCostCredits(
  model: MediaModel,
  options: { durationSeconds?: number; characters?: number; multiplier?: number } = {},
): number | undefined {
  const multiplier = options.multiplier ?? 1;
  const brackets = durationBrackets(model);
  if (brackets && options.durationSeconds !== undefined) {
    const bracket = brackets.find(
      (entry) =>
        options.durationSeconds !== undefined &&
        options.durationSeconds >= entry.minSeconds &&
        options.durationSeconds <= entry.maxSeconds,
    );
    if (bracket) return round2(bracket.usd * 100 * multiplier);
  }
  // Speech and some effects are billed by what they read or how long they
  // play, not per generation: price the request in hand.
  const perThousand = pricedUsd(model.pricing?.per_thousand_characters);
  if (perThousand !== undefined && options.characters !== undefined) {
    return round2(((perThousand * options.characters) / 1000) * 100 * multiplier);
  }
  const perSecond = pricedUsd(model.pricing?.per_second);
  if (perSecond !== undefined && options.durationSeconds !== undefined) {
    return round2(perSecond * options.durationSeconds * 100 * multiplier);
  }
  // `/audio/speech` models publish an `input` rate per million characters.
  const perMillion = model.mediaType === "tts" ? pricedUsd(model.pricing?.input) : undefined;
  if (perMillion !== undefined && options.characters !== undefined) {
    return round2(((perMillion * options.characters) / 1_000_000) * 100 * multiplier);
  }
  if (model.costCredits !== undefined) return round2(model.costCredits);
  return undefined;
}

function pricedUsd(block: unknown): number | undefined {
  if (!block || typeof block !== "object") return undefined;
  const usd = (block as Record<string, unknown>).usd;
  return typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? usd : undefined;
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
  const fractionDigits = credits >= 100 ? 0 : credits < 1 ? 2 : 1;
  const count = credits.toLocaleString(intlLocale(), {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
  return credits === 1 ? t("{count} credit", { count }) : t("{count} credits", { count });
}
