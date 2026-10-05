/**
 * The prompt bible's [REFERENCES] block: every image is given its role.
 *
 * A reference with no role is read however the model likes, and the bible
 * names that as the first cause of drift. So each image the request carries is
 * named the way its family reads it and told what to take: a face, an outfit,
 * a layout, a shape, a palette. Images that share a mention (a kling element's
 * angles) get one sentence, their roles merged, rather than two sentences
 * that contradict each other about the same `@Element1`.
 */

import { type StackedReference, referenceRoleOf } from "../bible/prompt";
import { referenceMentions } from "../seedance";
import { isSeedanceModel } from "../catalog";
import type { MediaModel } from "../types";

interface MentionGroup {
  mention: string;
  name: string;
  kind: StackedReference["kind"];
  roles: Set<string>;
  lead: boolean;
}

function grouped(
  stack: readonly StackedReference[],
  model: Pick<MediaModel, "id"> | undefined,
): MentionGroup[] {
  const mentions = referenceMentions(model, stack.length, stack.map(referenceRoleOf));
  const groups: MentionGroup[] = [];
  stack.forEach((reference, index) => {
    const mention = mentions[index];
    if (!mention) return;
    const existing = groups.find((group) => group.mention === mention);
    if (existing) {
      if (reference.role) existing.roles.add(reference.role);
      return;
    }
    groups.push({
      mention,
      name: reference.entryName,
      kind: reference.kind,
      roles: new Set(reference.role ? [reference.role] : []),
      lead: groups.length === 0,
    });
  });
  return groups;
}

function list(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What a character's images hold, merged across the images of one mention. */
function characterParts(roles: Set<string>): string[] {
  const parts: string[] = [];
  if (roles.has("portrait") || roles.has("profile") || roles.size === 0) parts.push("face", "hair");
  if (roles.has("outfit")) parts.push("outfit");
  if (roles.has("detail")) parts.push("details");
  return parts;
}

/** `Image 1 is Léa: face and hair.` in the bible's own words. */
function roleSentence(group: MentionGroup): string {
  const { mention, name, kind, roles } = group;
  switch (kind) {
    case "character": {
      if (roles.size === 1 && roles.has("outfit")) return `${mention} is ${name}'s outfit only.`;
      return `${mention} is ${name}: ${list(characterParts(roles))}.`;
    }
    case "location":
      return `${mention} is ${name}: keep the layout.`;
    case "prop":
      return `${mention} is ${name}: keep its shape and color.`;
    case "look":
      return `Only reference the color and lighting of ${mention}, not its characters.`;
    case "blocking":
      return `Use ${mention} only as shot guidance; do not generate it as a single image.`;
    default:
      return name ? `${mention} is ${name}.` : "";
  }
}

/** The same roles as one "Refer to" clause, for the seedance opening. */
function referClause(group: MentionGroup): string {
  const { mention, name, kind, roles } = group;
  switch (kind) {
    case "character":
      if (roles.size === 1 && roles.has("outfit")) return `${mention} for ${name}'s outfit only`;
      return `${mention} for ${name}'s ${list(characterParts(roles))}`;
    case "location":
      return `${mention} for the layout of ${name}`;
    case "prop":
      return `${mention} for the shape and color of ${name}`;
    case "look":
      return `${mention} for color and lighting only, not its characters`;
    case "blocking":
      return `${mention} only as shot guidance`;
    default:
      return name ? `${mention} for ${name}` : mention;
  }
}

export interface ReferenceBlock {
  /** One sentence per mention, the lead's first. */
  sentences: Array<{ text: string; lead: boolean }>;
  /**
   * For seedance: the whole block as the one sentence its prompt must open
   * with, because the opening phrase is what routes the request.
   */
  opening?: string;
}

export function referenceBlock(
  stack: readonly StackedReference[],
  model: Pick<MediaModel, "id"> | undefined,
): ReferenceBlock {
  const groups = grouped(stack, model);
  if (groups.length === 0) return { sentences: [] };
  if (model && isSeedanceModel(model.id)) {
    return { sentences: [], opening: `Refer to ${list(groups.map(referClause))}.` };
  }
  return {
    sentences: groups
      .map((group) => ({ text: roleSentence(group), lead: group.lead }))
      .filter((sentence) => sentence.text),
  };
}
