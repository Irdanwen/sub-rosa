/**
 * The prompt bible's pitfalls, caught while the shot is being written rather
 * than after the take is paid for. Each one is a sentence the person can act
 * on; none of them blocks a render.
 */

import { t } from "../../i18n";
import type { BibleEntry } from "../bible/types";
import type { FilmDirection } from "../direction/types";
import type { Shot } from "../workflow/compile";
import { traitsWithoutName } from "./subject";

export interface Lint {
  id: string;
  message: string;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** The events an action is written as, the way the rewrite cuts its beats. */
export function actionEvents(action: string): number {
  return action
    .split(/[;,.]/)
    .flatMap((part) => part.split(" then "))
    .filter((part) => part.trim()).length;
}

const NAMED_FEELINGS =
  /\b(?:is|are|looks?|feels?|seems?)\s+(?:sad|angry|happy|afraid|scared|nervous|surprised|upset|furious|anxious|emotional|worried|excited)\b|\b(?:triste|heureuse?|en col[eè]re|effray[ée]e?|nerveuse?|surprise?)\b/i;
const FAST_REPEATS =
  /\b(?:\d+|several|many|three|four|five)\s+times\b|\brepeatedly\b|\bfois par seconde\b/i;
const EXTREME = /\b(?:fanatical|crazed|maniacal|insane|possessed|deranged|hysterical)\b/i;
const NAMED_STYLE = /\b(?:in the style of|style of|à la manière de|façon)\s+[A-Z]/;
const VAGUE =
  /\b(?:beautiful|stylish|mysterious|elegant|gorgeous|pretty|handsome|attractive|cool|amazing|stunning)\b/i;
const FEELINGS_IN_TRAITS =
  /\b(?:sad|angry|happy|nervous|melancholic|joyful|worried|anxious|proud|shy)\b/i;

export function shotLints(shot: Shot, direction?: FilmDirection): Lint[] {
  const lints: Lint[] = [];
  if (actionEvents(shot.action) > 3)
    lints.push({
      id: "actions",
      message: t(
        "This shot holds more than three actions. Keep one to three, or split it into shots.",
      ),
    });
  if (NAMED_FEELINGS.test(shot.action))
    lints.push({
      id: "feeling",
      message: t(
        "Show the feeling as physical events rather than naming it: shoulders drop, a slow breath, a look away.",
      ),
    });
  if (FAST_REPEATS.test(shot.action))
    lints.push({
      id: "repeats",
      message: t("Video models cannot count fast repeated gestures. Describe one gesture."),
    });
  if (EXTREME.test(`${shot.action} ${shot.dialogue}`))
    lints.push({
      id: "extreme",
      message: t("Extreme emotion words give strange eyes. Use a neutral word such as amazed."),
    });
  if (NAMED_STYLE.test(`${shot.action} ${shot.camera} ${direction?.era ?? ""}`))
    lints.push({
      id: "named-style",
      message: t(
        "Describe what makes a style (light, color, framing) rather than naming a director or a film.",
      ),
    });
  const line = wordCount(shot.dialogue);
  if (line > 12)
    lints.push({
      id: "line-length",
      message: t(
        "A line of four to twelve words fits one shot. Split a longer speech across shots.",
      ),
    });
  if (shot.move?.kind === "handheld" && direction?.negatives?.includes("shake"))
    lints.push({
      id: "contradiction",
      message: t("A handheld camera shakes: the film's negatives forbid what this shot asks for."),
    });
  return lints;
}

/** The frozen descriptor's own rules: its length, nothing vague, no feeling. */
export function traitLints(entry: Pick<BibleEntry, "name" | "traits" | "kind">): Lint[] {
  const traits = traitsWithoutName(entry);
  if (!traits) return [];
  const lints: Lint[] = [];
  const words = wordCount(traits);
  if (entry.kind === "character" && (words < 25 || words > 45))
    lints.push({
      id: "descriptor-length",
      message: t("A character's descriptor holds best at 25 to 45 words. This one has {count}.", {
        count: words,
      }),
    });
  if (VAGUE.test(traits))
    lints.push({
      id: "vague",
      message: t(
        "Vague words such as beautiful or stylish describe nothing visible. Name a material, a color, a mark.",
      ),
    });
  if (FEELINGS_IN_TRAITS.test(traits))
    lints.push({
      id: "trait-feeling",
      message: t(
        "Leave feelings out of the descriptor: they change from shot to shot and belong in the action.",
      ),
    });
  return lints;
}

/** The descriptor's formula for a kind, to show where it is written. */
export function descriptorFormula(kind: BibleEntry["kind"]): string {
  switch (kind) {
    case "character":
      return t(
        "In English, without the name: age and build, face and one distinctive mark, hair, clothes from top to bottom with material and color, accessories with their side.",
      );
    case "location":
      return t("In English: period, materials, layout, and one fixed light source.");
    case "prop":
      return t("In English: material, color, shape, condition, one unique detail.");
    default:
      return t("In English: the palette, the light and the texture this look gives every shot.");
  }
}
