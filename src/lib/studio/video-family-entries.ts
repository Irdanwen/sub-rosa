// A video family as a row in a model picker, for both shells. One row stands
// for up to four backend models (text, image, reference, video), so the row
// carries its directions as tags and filter groups, and the variants' own
// names as search terms.

import { t } from "../i18n";
import type { ModelPickerEntry, ModelPickerFilter, ModelPickerTag } from "../model-picker";
import {
  familyDirections,
  requiresOpeningFrame,
  type VideoDirection,
  type VideoFamily,
  videoFamilySearchTerms,
} from "./catalog";
import { modelSubtitle } from "./model-subtitle";

/** The directions a family can be narrowed to in the picker, in the order the
 * form asks for their inputs. Read when the picker opens, so the labels are in
 * the language of the moment. */
export function videoDirectionFilters(): ModelPickerFilter[] {
  const filters: { id: VideoDirection; label: string }[] = [
    { id: "text", label: t("From a prompt") },
    { id: "image", label: t("Animate an image") },
    { id: "reference", label: t("From references") },
  ];
  return filters;
}

/**
 * What a family row says about its directions. One word each, because the row
 * is scanned, not read: "Text · Image · References". A reference variant that
 * will not start without an opening frame says so here, in the one place the
 * user is still choosing - the form can only report it after the fact.
 */
export function familyTags(family: VideoFamily): ModelPickerTag[] {
  const tags: ModelPickerTag[] = [];
  if (family.textModel) tags.push({ label: t("Text") });
  if (family.imageModel) tags.push({ label: t("Image") });
  if (family.referenceModel) {
    tags.push({ label: t("References") });
    if (requiresOpeningFrame(family.referenceModel.id)) {
      tags.push({ label: t("+ opening frame"), tone: "note" });
    }
  }
  return tags;
}

/** Tier and privacy, read off the variant the family is most often run as. */
export function familySubtitle(family: VideoFamily): string {
  const model = family.textModel ?? family.referenceModel ?? family.imageModel ?? family.videoModel;
  return model ? modelSubtitle(model) : "";
}

/** The row itself. `details` are the directions in words, searchable too. */
export function videoFamilyEntry(family: VideoFamily, details: string[] = []): ModelPickerEntry {
  return {
    id: family.key,
    name: family.name,
    subtitle: familySubtitle(family),
    tags: familyTags(family),
    groups: familyDirections(family),
    // One row stands for up to four backend models, so searching what the
    // row shows cannot find a variant by its own name or id.
    keywords: [...videoFamilySearchTerms(family), ...details],
  };
}
