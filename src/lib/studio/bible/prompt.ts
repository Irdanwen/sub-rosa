/**
 * Turning bible entries into the prompt a shot is actually rendered from.
 *
 * The rules here are not ours: they are what the reference-to-video families
 * document and what the people who use them daily converged on. Four of them
 * matter enough to be code rather than a note in a doc nobody opens.
 *
 * **Under sixty words.** Past roughly that, these models start dropping
 * clauses, and which clause they drop is not something you get to choose. So
 * the prompt is built to a budget, and when it does not fit, *the app* decides
 * what goes - in a stated order, from the least load bearing.
 *
 * **The reference stack has an order, and the first image is the identity.**
 * Not a bag of pictures: the primary character's anchor first, then the
 * blocking plate, then the place, then everybody else. Getting this wrong
 * silently swaps whose face the shot keeps.
 *
 * **Invariant traits are restated every single shot.** Nothing carries over
 * between separately generated clips, so "green coat, scar over the left brow"
 * has to be in shot 12 exactly as it was in shot 1. This is the difference
 * between a character and a resemblance.
 *
 * **Adjacent beats in one environment go in one generation**, separated by
 * "Lens switch." One render keeps the lighting and the space locked in a way
 * two renders cannot.
 */

import { referenceMention } from "../seedance";
import type { MediaModel } from "../types";
import type { BibleEntry, BibleRef } from "./types";

/** Where these families start dropping clauses of their own accord. */
export const SEEDANCE_WORD_LIMIT = 60;

/** The separator that makes several beats one generation. */
export const LENS_SWITCH = "Lens switch.";

/** How many images a reference-to-video request can carry. */
export const MAX_REFERENCE_IMAGES = 9;

/** A reference chosen for a shot, in the order it will be sent. */
export interface StackedReference {
  artifactId: string;
  /** The entry it came from, for the label a surface shows. */
  entryName: string;
  role: BibleRef["role"];
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
    stack.push({ artifactId: reference.artifactId, entryName: entry.name, role: reference.role });
  };

  const [lead, ...others] = input.characters ?? [];
  if (lead)
    for (const reference of refsInRoleOrder(lead, ["portrait", "profile"])) push(lead, reference);

  if (input.blockingPlateArtifactId && stack.length < max) {
    stack.push({
      artifactId: input.blockingPlateArtifactId,
      entryName: "the blocking",
      role: "medium",
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

/** `Nera: green coat, scar over the left brow.` Empty when there is nothing to hold. */
export function invariantLine(entry: BibleEntry): string {
  const traits = entry.traits.trim().replace(/\.$/, "");
  if (!traits) return "";
  return `${entry.name}: ${traits}.`;
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

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export interface ShotPromptInput {
  /** Who and what the shot is of. */
  subject: string;
  action: string;
  camera?: string;
  style?: string;
  constraints?: string;
  /** Restated every shot, in importance order. */
  invariants?: readonly string[];
  /** The stack, so the prompt can name each image the way the model reads it. */
  stack?: readonly StackedReference[];
  model?: Pick<MediaModel, "id">;
  wordLimit?: number;
}

export interface ShotPrompt {
  prompt: string;
  wordCount: number;
  /** What the budget forced out, so a surface can say so rather than hide it. */
  dropped: string[];
}

/**
 * A shot prompt, built to the word budget.
 *
 * The parts are dropped in a stated order when it does not fit: constraints
 * first (they are a preference), then style (the look is mostly carried by the
 * references anyway), then the invariants of the *secondary* subjects, then
 * the camera. Subject, action and the lead's invariants are never dropped:
 * without them the render is not a worse version of the shot, it is a
 * different shot.
 */
export function shotPrompt(input: ShotPromptInput): ShotPrompt {
  const limit = input.wordLimit ?? SEEDANCE_WORD_LIMIT;
  const mentions = (input.stack ?? []).map((reference, index) => ({
    reference,
    mention: referenceMention(input.model, "image", index + 1),
  }));
  const lead = mentions[0];
  const opening = lead ? `Refer to ${lead.mention} for ${lead.reference.entryName}.` : "";

  const invariants = [...(input.invariants ?? [])].filter(Boolean);
  const parts: Array<{ text: string; droppable: number }> = [
    { text: opening, droppable: 0 },
    { text: input.subject.trim(), droppable: 0 },
    { text: input.action.trim(), droppable: 0 },
    { text: invariants[0] ?? "", droppable: 0 },
    { text: input.camera?.trim() ?? "", droppable: 4 },
    ...invariants.slice(1).map((line) => ({ text: line, droppable: 3 })),
    { text: input.style?.trim() ?? "", droppable: 2 },
    { text: input.constraints?.trim() ?? "", droppable: 1 },
  ].filter((part) => part.text.length > 0);

  const dropped: string[] = [];
  // Drop in the stated order until it fits, or until only what cannot go is
  // left - a prompt over budget is still better than a prompt missing its
  // subject.
  for (const tier of [1, 2, 3, 4]) {
    const text = parts.map((part) => part.text).join(" ");
    if (words(text) <= limit) break;
    for (const part of parts.filter((candidate) => candidate.droppable === tier)) {
      dropped.push(part.text);
    }
    parts.splice(0, parts.length, ...parts.filter((part) => part.droppable !== tier));
  }

  const prompt = parts
    .map((part) => part.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return { prompt, wordCount: words(prompt), dropped };
}

/**
 * Several beats as one generation.
 *
 * One render holds the lighting and the geography across the beats in a way
 * two renders cannot, however carefully the second one is prompted.
 */
export function joinBeats(beats: readonly string[]): string {
  return beats
    .map((beat) => beat.trim())
    .filter(Boolean)
    .join(` ${LENS_SWITCH} `);
}
