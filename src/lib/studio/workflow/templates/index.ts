// Prebuilt starter workflows, one file per kind of work. This module is the
// catalog: the order the library shows them in, the kind each one belongs
// to, and the copy a person edits.

import type { Workflow } from "../schema";
import { appWithIds } from "../app";
import type { TemplateCategory } from "./categories";
import { animatedLogo, reformatForEveryFormat, videoThumbnail } from "./brand";
import {
  albumCover,
  coversFromList,
  pickTheBestOfFour,
  postWithCaption,
  storyScene,
} from "./pictures";
import {
  adInTheStyleOf,
  explodedView,
  productInHand,
  productPlacement,
  productStudioShot,
  productToVideo,
} from "./products";
import {
  beforeAndAfter,
  characterSheet,
  coverageFromOneShot,
  outfitShoot,
  relightAPortrait,
  removeAnObject,
  tryItOn,
  upscaleForPrint,
} from "./retouch";
import {
  musicFromMood,
  podcastIntro,
  readInAnotherLanguage,
  songFromAStory,
  soundEffectsPack,
  twoVoiceDialogue,
} from "./sound";
import {
  editorialToMotion,
  extendAClip,
  recastAClip,
  restyleAClip,
  shortFilm,
  shortVideoAd,
  storyboardToVideo,
  storyInThreeShots,
  talkingPhoto,
  twoShotSequence,
} from "./video";

export {
  CHAT_MODEL,
  MUSIC_MODEL,
  TTS_MODEL,
  VIDEO_FROM_IMAGE_MODEL,
  VIDEO_MODEL,
} from "./build";

export {
  TEMPLATE_CATEGORIES,
  type TemplateCategory,
  templateCategoryLabel,
} from "./categories";

/** Every shipped template, in the order the library shows them, with the
 * kind of work it is sorted under. The first one seeds a new library. */
const CATALOG: ReadonlyArray<readonly [() => Workflow, TemplateCategory]> = [
  [albumCover, "pictures"],
  [storyScene, "pictures"],
  [musicFromMood, "sound"],
  [shortVideoAd, "video"],
  [twoShotSequence, "video"],
  [shortFilm, "video"],
  [tryItOn, "retouch"],
  [coversFromList, "pictures"],
  [characterSheet, "retouch"],
  [podcastIntro, "sound"],
  [beforeAndAfter, "retouch"],
  [storyInThreeShots, "video"],
  [upscaleForPrint, "retouch"],
  [postWithCaption, "pictures"],
  [readInAnotherLanguage, "sound"],
  [productStudioShot, "products"],
  [productToVideo, "products"],
  [productInHand, "products"],
  [adInTheStyleOf, "products"],
  [explodedView, "products"],
  [productPlacement, "products"],
  [reformatForEveryFormat, "brand"],
  [videoThumbnail, "brand"],
  [animatedLogo, "brand"],
  [pickTheBestOfFour, "pictures"],
  [storyboardToVideo, "video"],
  [editorialToMotion, "video"],
  [extendAClip, "video"],
  [relightAPortrait, "retouch"],
  [coverageFromOneShot, "retouch"],
  [outfitShoot, "retouch"],
  [removeAnObject, "retouch"],
  [soundEffectsPack, "sound"],
  [songFromAStory, "sound"],
  [twoVoiceDialogue, "sound"],
  [talkingPhoto, "video"],
  [restyleAClip, "video"],
  [recastAClip, "video"],
];

let categories: Map<string, TemplateCategory> | undefined;

export function templateCategory(id: string): TemplateCategory {
  categories ??= new Map(CATALOG.map(([build, kind]) => [build().id, kind]));
  return categories.get(id) ?? "pictures";
}

/** Fresh copies each call so callers can mutate their clone safely. */
export function templateWorkflows(): Workflow[] {
  return CATALOG.map(([build]) => build());
}

/** A template copied into a workflow of its own: fresh ids for every step
 * and wire, and its app pointing at them. */
export function copyTemplate(template: Workflow, into: Workflow): Workflow {
  const ids = new Map(template.nodes.map((node) => [node.id, crypto.randomUUID()]));
  const app = appWithIds(template.app, ids);
  return {
    ...into,
    ...(template.description ? { description: template.description } : {}),
    nodes: template.nodes.map((node) => ({
      ...node,
      id: ids.get(node.id) ?? node.id,
      params: { ...node.params },
    })),
    edges: template.edges.map((edge) => ({
      ...edge,
      id: crypto.randomUUID(),
      source: ids.get(edge.source) ?? edge.source,
      target: ids.get(edge.target) ?? edge.target,
    })),
    ...(app ? { app } : {}),
  };
}
