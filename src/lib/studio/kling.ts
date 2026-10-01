/**
 * What the kling family expects of its reference inputs.
 *
 * Kling's reference-to-video contract does not read the flat
 * `reference_image_urls` that seedance and grok take. It reads two structured
 * inputs instead, each with its own cap and its own prompt mention:
 *
 * - `elements[]` (at most 4): a character or object to keep stable, each a
 *   `frontal_image_url` plus up to three other angles, named `@Element1`...
 * - `scene_image_urls[]` (at most 4): the stage, light and style, named
 *   `@Image1`...
 *
 * A render needs at least one visual input - an opening frame (`image_url`),
 * an element or a scene image. Sent the flat field, kling sees none of them and
 * refuses with "At least one visual input is required: image_url, elements, or
 * scene_image_urls" (measured 2026-10-01). That refusal is what was once read
 * as "kling needs an opening frame": the frame was the only one of the three
 * the request carried, so the renders that had one went through - and ignored
 * their references.
 *
 * Verified against Venice's "Reference to Video" guide (docs.venice.ai, read
 * 2026-10-01) and against the live API through Carpe Diem, which forwards
 * `elements` as is (a fifth element is refused upstream by name).
 */

import { isKlingReferenceModel } from "./catalog";
import type { MediaModel } from "./types";

/** Elements a kling reference render accepts. */
export const KLING_MAX_ELEMENTS = 4;
/** Scene images a kling reference render accepts, capped apart from elements. */
export const KLING_MAX_SCENE_IMAGES = 4;

/** Whether this model takes its references as kling elements and scenes. */
export function takesKlingReferences(model: Pick<MediaModel, "id"> | undefined): boolean {
  return Boolean(model && isKlingReferenceModel(model.id));
}

/** What a reference shows, when the surface sending it knows. */
export interface ReferenceRole {
  /**
   * The character or object it shows. Images sharing a subject are angles of
   * one element rather than separate elements: two elements of one face are an
   * invitation to film twins.
   */
  subject?: string;
  /** A place or a look: the stage the clip happens on, never an identity. */
  scene?: boolean;
}

/** Where one reference lands in a kling request, 0-based within its field. */
export type KlingSlot =
  | { field: "element"; element: number }
  | { field: "angle"; element: number }
  | { field: "scene"; scene: number }
  | { field: "dropped" };

/** The angles an element carries besides its frontal image. */
const KLING_MAX_ANGLES = 3;

/**
 * Where each reference goes, in the order they were given.
 *
 * A subject's first image is the frontal of a new element, its next ones are
 * that element's angles. A scene is a scene image. A reference nobody
 * described is a subject of its own - so a plain list, which is what the
 * free studio holds, fills the four elements first and spills into the four
 * scene images, the positional rule. A subject that finds the elements full
 * spills into the scenes the same way rather than vanish; only an angle past
 * an element's three, or anything past both caps, is dropped.
 */
export function klingLayout(
  count: number,
  roles?: readonly (ReferenceRole | undefined)[],
): KlingSlot[] {
  const elements = new Map<string, { element: number; angles: number }>();
  let scenes = 0;
  const scene = (): KlingSlot =>
    scenes < KLING_MAX_SCENE_IMAGES ? { field: "scene", scene: scenes++ } : { field: "dropped" };
  return Array.from({ length: count }, (_, index): KlingSlot => {
    const role = roles?.[index];
    if (role?.scene) return scene();
    const key = role?.subject?.trim().toLowerCase() || `#${index}`;
    const existing = elements.get(key);
    if (existing) {
      if (existing.angles >= KLING_MAX_ANGLES) return { field: "dropped" };
      existing.angles += 1;
      return { field: "angle", element: existing.element };
    }
    if (elements.size >= KLING_MAX_ELEMENTS) return scene();
    const element = elements.size;
    elements.set(key, { element, angles: 0 });
    return { field: "element", element };
  });
}

export interface KlingReferenceFields {
  elements?: { frontal_image_url: string; reference_image_urls?: string[] }[];
  scene_image_urls?: string[];
}

/** The request fields for these references, laid out by `klingLayout`. */
export function klingReferenceFields(
  references: readonly string[],
  roles?: readonly (ReferenceRole | undefined)[],
): KlingReferenceFields {
  const elements: NonNullable<KlingReferenceFields["elements"]> = [];
  const scenes: string[] = [];
  klingLayout(references.length, roles).forEach((slot, index) => {
    const image = references[index];
    if (slot.field === "element") elements[slot.element] = { frontal_image_url: image };
    else if (slot.field === "angle") {
      const element = elements[slot.element];
      element.reference_image_urls = [...(element.reference_image_urls ?? []), image];
    } else if (slot.field === "scene") scenes[slot.scene] = image;
  });
  const fields: KlingReferenceFields = {};
  if (elements.length > 0) fields.elements = elements;
  if (scenes.length > 0) fields.scene_image_urls = scenes;
  return fields;
}

/**
 * How each reference is named in a kling prompt, by the same layout: an
 * element's angles share its mention, and a dropped reference has none.
 */
export function klingMentions(
  count: number,
  roles?: readonly (ReferenceRole | undefined)[],
): (string | undefined)[] {
  return klingLayout(count, roles).map((slot) =>
    slot.field === "scene"
      ? `@Image${slot.scene + 1}`
      : slot.field === "dropped"
        ? undefined
        : `@Element${slot.element + 1}`,
  );
}

/**
 * How the reference at this 1-based position is named when nothing is known
 * about any of them - the positional rule `klingLayout` falls back to.
 */
export function klingMention(index: number): string {
  const position = Math.max(1, Math.trunc(index));
  return position <= KLING_MAX_ELEMENTS
    ? `@Element${position}`
    : `@Image${position - KLING_MAX_ELEMENTS}`;
}
