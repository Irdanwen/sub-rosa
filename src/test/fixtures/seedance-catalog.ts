/**
 * The seedance slice of the live Carpe Diem catalog. Test infrastructure — NOT
 * a test (vitest only collects `*.{test,spec}.*`).
 *
 * Why a captured fixture rather than hand-written models: every bug this family
 * has produced came from a mismatch between what the studio assumed and what the
 * operator actually publishes — a variant typed `imageToVideo` instead of
 * `referenceToVideo`, a display name carrying the direction, a `video_input`
 * flag saying no to the very input a surface was offering. Invented fixtures
 * agree with the assumption by construction, so they cannot catch that.
 *
 * Captured 2026-08-14 from the two upstreams the Rust proxy merges
 * (`carpe_diem/media.rs::merge_carpe_diem_catalog`):
 *
 *   curl -H "Authorization: Bearer $CDM_KEY" \
 *     https://carpe-diem.xyz/api/operator/v1/models        # id, type, tier, constraints
 *   curl https://api.venice.ai/api/v1/models?type=all      # model_spec.name
 *
 * All 22 seedance entries are here, because which ones exist is itself part of
 * what the surfaces get wrong. Reproduced faithfully, including the parts that
 * look like mistakes:
 *
 * - Every `-basic` reference-to-video variant is typed `imageToVideo`. Only the
 *   two full (non-`-basic`) reference ids carry the dedicated `referenceToVideo`
 *   type, so a surface reading `mediaType` alone would miss most of them.
 * - Venice names only the `-basic` ids, so the full ones fall back to their id
 *   as a display name (the proxy's `unwrap_or_else(|| id.clone())`) and end up
 *   in their own family, spelled in raw id.
 * - `-basic` entries publish complete media flags, including `video_input: false`
 *   on every reference variant: they take reference *photos* and *audio*, never
 *   reference *clips*. The full entries publish only the three option lists,
 *   leaving both flags absent, which means "nobody said", not "no".
 * - Only seedance 2.0 and 2.0 Fast ship a full tier. 2.0 Mini and 2.5 are
 *   `-basic` only, which is why 2.5 refuses recognisable people whatever the
 *   caller attests.
 *
 * Fields the wire carries but `VideoConstraints` does not model
 * (`prompt_character_limit`, `reference_image_min_short_side_pixels` and the
 * two reference aspect bounds) are left out rather than smuggled in untyped;
 * `lib/studio/seedance.ts` holds those figures as constants.
 */

import type { MediaCatalog, MediaModel, MediaType, VideoConstraints } from "../../lib/studio/types";

/** The direction suffixes the operator appends to a family prefix. */
type Direction = "text-to-video" | "image-to-video" | "reference-to-video";

/** The duration menus arrive as an inclusive second-by-second list of strings. */
function seconds(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, index) => `${from + index}s`);
}

const RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
/** The full reference variants add the two shapes the edit/extend/stitch
 * examples use. The `-basic` ones do not offer them. */
const RATIOS_WITH_ADAPTIVE = [...RATIOS, "adaptive", "auto"];

/** An empty list is the catalogs' way of saying "this field does not apply to
 * this model" — image-to-video takes its shape from the photo. Distinct from an
 * absent list, which means nobody said. */
const NO_RATIOS: string[] = [];

interface FamilySpec {
  /** Id prefix, e.g. `seedance-2-0-fast`. */
  prefix: string;
  /** Venice's display name for the `-basic` tier. */
  name: string;
  /** Inclusive duration range, in seconds. */
  durations: [number, number];
  resolutions: string[];
  /** Directions shipped as public `-basic` ids. */
  basic: Direction[];
  /** Directions also shipped as full ids, which Venice does not name. */
  full: Direction[];
}

/** Exactly what the operator publishes, family by family. */
const FAMILIES: FamilySpec[] = [
  {
    prefix: "seedance-1-5-pro",
    name: "Seedance 1.5 Pro",
    durations: [4, 12],
    resolutions: ["1080p", "720p", "480p"],
    // The only seedance generation with no reference variant at all.
    basic: ["text-to-video", "image-to-video"],
    full: ["text-to-video", "image-to-video"],
  },
  {
    prefix: "seedance-2-0",
    name: "Seedance 2.0",
    durations: [4, 15],
    resolutions: ["4k", "1080p", "720p", "480p"],
    basic: ["text-to-video", "image-to-video", "reference-to-video"],
    full: ["text-to-video", "image-to-video", "reference-to-video"],
  },
  {
    prefix: "seedance-2-0-fast",
    name: "Seedance 2.0 Fast",
    durations: [4, 15],
    resolutions: ["720p", "480p"],
    basic: ["text-to-video", "image-to-video", "reference-to-video"],
    full: ["text-to-video", "image-to-video", "reference-to-video"],
  },
  {
    prefix: "seedance-2-0-mini",
    name: "Seedance 2.0 Mini",
    durations: [4, 15],
    resolutions: ["720p", "480p"],
    basic: ["text-to-video", "image-to-video", "reference-to-video"],
    full: [],
  },
  {
    prefix: "seedance-2-5",
    name: "Seedance 2.5",
    durations: [4, 30],
    resolutions: ["720p", "480p"],
    basic: ["text-to-video", "image-to-video", "reference-to-video"],
    full: [],
  },
];

function ratiosFor(direction: Direction, tier: "basic" | "full"): string[] {
  if (direction === "image-to-video") return NO_RATIOS;
  if (direction === "reference-to-video" && tier === "full") return RATIOS_WITH_ADAPTIVE;
  return RATIOS;
}

/** The operator moved most reference variants into their own type, but only for
 * the full tier — every `-basic` reference id is still typed image-to-video. */
function mediaTypeFor(direction: Direction, tier: "basic" | "full"): MediaType {
  if (direction === "text-to-video") return "video";
  if (direction === "reference-to-video" && tier === "full") return "referenceToVideo";
  return "imageToVideo";
}

/** Venice appends the direction shorthand to the reference variant's name, and
 * names the two other directions identically. */
function nameFor(spec: FamilySpec, direction: Direction, id: string, tier: "basic" | "full") {
  if (tier === "full") return id;
  return direction === "reference-to-video" ? `${spec.name} R2V` : spec.name;
}

function constraintsFor(
  spec: FamilySpec,
  direction: Direction,
  tier: "basic" | "full",
): VideoConstraints {
  const menus = {
    durations: seconds(spec.durations[0], spec.durations[1]),
    aspect_ratios: ratiosFor(direction, tier),
    resolutions: spec.resolutions,
  };
  // The full tier publishes the option lists only: no media flags either way.
  if (tier === "full") return menus;
  return {
    ...menus,
    audio: true,
    audio_configurable: true,
    // Reference audio on the reference variants; reference clips on none of them.
    audio_input: direction === "reference-to-video",
    video_input: false,
  };
}

function expand(spec: FamilySpec): MediaModel[] {
  const tiers: Array<["basic" | "full", Direction[]]> = [
    ["basic", spec.basic],
    ["full", spec.full],
  ];
  return tiers.flatMap(([tier, directions]) =>
    directions.map((direction) => {
      const id =
        tier === "basic" ? `${spec.prefix}-${direction}-basic` : `${spec.prefix}-${direction}`;
      return {
        id,
        name: nameFor(spec, direction, id, tier),
        mediaType: mediaTypeFor(direction, tier),
        tier: "premium",
        offline: false,
        constraints: constraintsFor(spec, direction, tier),
      } satisfies MediaModel;
    }),
  );
}

export const SEEDANCE_MODELS: MediaModel[] = FAMILIES.flatMap(expand);

/** Non-seedance contrast: the one family that really does take a source clip,
 * and a reference family from another vendor with no published figures. */
export const OTHER_VIDEO_MODELS: MediaModel[] = [
  {
    id: "wan-2-7-video-to-video",
    name: "Wan 2.7 Edit",
    mediaType: "video",
    tier: "premium",
    offline: false,
    constraints: {
      durations: ["Auto"],
      aspect_ratios: NO_RATIOS,
      resolutions: ["1080p", "720p"],
      audio: false,
      audio_configurable: false,
      audio_input: false,
      video_input: true,
    },
  },
  {
    id: "kling-o3-4k-reference-to-video",
    name: "Kling O3 4K R2V",
    mediaType: "referenceToVideo",
    tier: "premium",
    offline: false,
    constraints: {
      durations: seconds(3, 15),
      aspect_ratios: ["16:9", "9:16", "1:1"],
      resolutions: [],
      audio: true,
      audio_configurable: true,
      audio_input: false,
      video_input: false,
    },
  },
];

/** The catalog as the studio receives it from `carpe_diem_media_catalog`. */
export function seedanceCatalog(): MediaCatalog {
  return {
    backend: "carpe-diem",
    priceMultiplier: 0.5,
    models: [...SEEDANCE_MODELS, ...OTHER_VIDEO_MODELS],
  };
}
