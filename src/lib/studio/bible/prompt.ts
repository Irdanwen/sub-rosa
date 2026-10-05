/**
 * Turning bible entries into what a shot is rendered from: the ordered
 * reference stack and the frozen descriptor restated on every shot.
 *
 * The prompt itself is written by `../prompt/compose.ts` (ADR-0074), block by
 * block, to each family's own budget. Two rules live here because they are
 * about the bible rather than the prompt:
 *
 * **The reference stack has an order, and the first image is the identity.**
 * Not a bag of pictures: the primary character's anchor first, then their
 * outfit, then the blocking plate, then the place, the props and the look,
 * then everybody else. Getting this wrong silently swaps whose face the shot
 * keeps. Four or five images are enough for most shots (the prompt bible):
 * the stack only grows to the model's cap when three or more characters
 * share the frame.
 *
 * **Invariant traits are restated every single shot.** Nothing carries over
 * between separately generated clips, so "navy wool coat, scar above the left
 * eyebrow" has to be in shot 12 exactly as it was in shot 1. This is the
 * difference between a character and a resemblance.
 */

import type { ReferenceRole } from "../kling";
import { fullDescriptor } from "../prompt/subject";
import type { BibleEntry, BibleKind, BibleRef } from "./types";

/** How many images a reference-to-video request can carry. */
export const MAX_REFERENCE_IMAGES = 9;

/** How many a shot sends by default: the prompt bible's four to five. */
export const DEFAULT_REFERENCE_IMAGES = 5;

/** A reference chosen for a shot, in the order it will be sent. */
export interface StackedReference {
  artifactId: string;
  /** The entry it came from, for the label a surface shows. */
  entryName: string;
  /** Its role in that entry; absent for an image no entry holds. */
  role?: BibleRef["role"];
  /** What kind of entry that is; `blocking` for the generated blocking plate. */
  kind?: BibleKind | "blocking";
}

/**
 * What a stacked reference shows, in the terms a request is laid out by: a
 * character or a prop is a subject, its images grouped by entry; a place, a
 * look or the blocking plate is the stage. A reference whose kind nobody
 * recorded stays undescribed, and falls to the positional rule.
 */
export function referenceRoleOf(reference: StackedReference): ReferenceRole | undefined {
  switch (reference.kind) {
    case "character":
    case "prop":
      return { subject: reference.entryName };
    case "location":
    case "look":
    case "blocking":
      return { scene: true };
    default:
      return undefined;
  }
}

/**
 * Gallery images described by the bible entry that holds them, in the order
 * given. An image no entry holds is described by nothing: it still rides, it
 * just carries no name and no kind.
 */
export function describeReferences(
  artifactIds: readonly string[],
  bible: readonly BibleEntry[],
): StackedReference[] {
  return artifactIds.map((artifactId) => {
    for (const entry of bible) {
      const reference = entry.refs.find((candidate) => candidate.artifactId === artifactId);
      if (reference) {
        return { artifactId, entryName: entry.name, role: reference.role, kind: entry.kind };
      }
    }
    return { artifactId, entryName: "" };
  });
}

function refsInRoleOrder(entry: BibleEntry, roles: readonly BibleRef["role"][]): BibleRef[] {
  const wanted = new Set(roles);
  return entry.refs
    .filter((reference) => wanted.has(reference.role))
    .sort((left, right) => {
      const byRole = roles.indexOf(left.role) - roles.indexOf(right.role);
      return byRole !== 0 ? byRole : left.ordinal - right.ordinal;
    });
}

export interface StackInput {
  /** Characters in the shot, most important first. */
  characters?: readonly BibleEntry[];
  /** Where it happens. */
  location?: BibleEntry;
  /** Props that have to look like themselves. */
  props?: readonly BibleEntry[];
  /** The film's look: color and light only, never its characters. */
  looks?: readonly BibleEntry[];
  /** A generated frame showing who stands where. Rides second, by convention. */
  blockingPlateArtifactId?: string;
  max?: number;
}

/**
 * The ordered image stack for a shot.
 *
 * The order is the contract. The first image is what the model treats as the
 * identity to hold; the blocking plate tells it who stands where; the location
 * angles tell it what the space is. Overflow is dropped from the end, which is
 * why the secondary characters are last: losing a background face is
 * recoverable, losing the lead's is not.
 */
export function referenceStack(input: StackInput): StackedReference[] {
  const max = input.max ?? MAX_REFERENCE_IMAGES;
  const stack: StackedReference[] = [];
  const push = (entry: BibleEntry, reference: BibleRef) => {
    if (stack.length >= max) return;
    if (stack.some((existing) => existing.artifactId === reference.artifactId)) return;
    stack.push({
      artifactId: reference.artifactId,
      entryName: entry.name,
      role: reference.role,
      kind: entry.kind,
    });
  };

  const [lead, ...others] = input.characters ?? [];
  if (lead) {
    // A full body outfit view does what the profile did and holds the
    // clothes too, so with one the profile gives its place to the scene.
    const hasOutfit = lead.refs.some((reference) => reference.role === "outfit");
    const roles: BibleRef["role"][] = hasOutfit ? ["portrait", "outfit"] : ["portrait", "profile"];
    for (const reference of refsInRoleOrder(lead, roles)) push(lead, reference);
  }

  if (input.blockingPlateArtifactId && stack.length < max) {
    stack.push({
      artifactId: input.blockingPlateArtifactId,
      entryName: "the blocking",
      role: "medium",
      kind: "blocking",
    });
  }

  if (input.location) {
    for (const reference of refsInRoleOrder(input.location, ["wide", "medium", "detail"])) {
      push(input.location, reference);
    }
  }
  for (const prop of input.props ?? []) {
    for (const reference of refsInRoleOrder(prop, ["detail", "portrait"])) push(prop, reference);
  }
  for (const look of input.looks ?? []) {
    for (const reference of refsInRoleOrder(look, ["wide", "medium", "detail"]).slice(0, 1)) {
      push(look, reference);
    }
  }
  for (const other of others) {
    for (const reference of refsInRoleOrder(other, ["portrait"])) push(other, reference);
  }
  return stack;
}

/** The voice donor of a character, if it has one. */
export function voiceReference(entry: BibleEntry | undefined): BibleRef | undefined {
  return entry?.refs
    .filter((reference) => reference.role === "voice")
    .sort((left, right) => left.ordinal - right.ordinal)[0];
}

/** `Nera, green coat, scar over the left brow.` Empty when there is nothing to hold. */
export function invariantLine(entry: BibleEntry): string {
  return entry.traits.trim() ? fullDescriptor(entry) : "";
}

/**
 * A prompt with an entry's invariant traits in it, added once.
 *
 * Nothing carries over between separately generated clips, so a character's
 * traits have to be on shot twelve exactly as they were on shot one. Adding
 * them again on every pick would grow the prompt without adding information,
 * so a prompt that already says it is left alone.
 */
export function withInvariant(prompt: string, entry: BibleEntry): string {
  const line = invariantLine(entry);
  if (!line) return prompt;
  if (prompt.includes(line)) return prompt;
  return `${prompt.trim()} ${line}`.trim();
}
