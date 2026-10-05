/**
 * The prompt bible's [NEGATIVE] block: forbid only what is likely to happen
 * on this shot.
 *
 * A long list dilutes the model's attention, and a negative that contradicts
 * the positive ("handheld" and "No camera shake") is worse than none. So the
 * list is derived from the shot itself, a short base first, and each risk is
 * added only where the bible says it bites.
 */

import { entry, write } from "../direction/vocabulary";
import type { FilmDirection } from "../direction/types";

export interface NegativeLine {
  id: string;
  text: string;
  /** Kept when the budget is tight: the base the bible puts almost everywhere. */
  essential: boolean;
}

export interface NegativeInput {
  direction?: FilmDirection;
  characterCount: number;
  moveKind?: string;
  shotSize?: string;
  /** The shot carries a line nobody on screen should mouth. */
  lipsClosed: boolean;
  /** The clip's own sound is kept, so unwanted music would be heard. */
  soundOn: boolean;
}

const CLOSE_SIZES = new Set(["close-up", "extreme-close-up", "medium-close-up"]);

function animated(direction: FilmDirection | undefined): boolean {
  return Boolean(
    entry("looks", direction?.look)?.animated || entry("genres", direction?.genre)?.animated,
  );
}

/**
 * In the order a tight budget keeps them: the base, then the risks that ruin
 * a take (a stranger in frame, a coat that changes), then the ones that only
 * blemish it. A budget drops optional lines from the end.
 */
export function negativeLines(input: NegativeInput): NegativeLine[] {
  const ids: Array<[string, boolean]> = [
    ["subtitles", true],
    ["watermark", true],
    ["cuts", true],
  ];
  if (input.lipsClosed) ids.push(["lips", true]);
  if (input.characterCount >= 1 && input.characterCount <= 2) ids.push(["extra-characters", false]);
  if (input.characterCount >= 1) ids.push(["costume", false]);
  if (input.characterCount >= 1 && input.shotSize && CLOSE_SIZES.has(input.shotSize))
    ids.push(["face", false]);
  const move = entry("movements", input.moveKind);
  if (move && !move.shaky) ids.push(["shake", false]);
  if (input.soundOn && (entry("music", input.direction?.music)?.silent ?? true))
    ids.push(["music", false]);
  if (input.direction?.era?.trim()) ids.push(["anachronism", false]);
  if (animated(input.direction)) ids.push(["live-action", false]);
  for (const extra of input.direction?.negatives ?? []) ids.push([extra, false]);
  ids.push(["logo", false]);

  const seen = new Set<string>();
  const lines: NegativeLine[] = [];
  for (const [id, essential] of ids) {
    if (seen.has(id)) continue;
    // The person asked for handheld: never forbid the shake they chose.
    if (id === "shake" && move?.shaky) continue;
    // An animated film is not told off for looking like a cartoon.
    if (id === "cartoon" && animated(input.direction)) continue;
    const text = write("negatives", id);
    if (!text) continue;
    seen.add(id);
    lines.push({ id, text, essential });
  }
  return lines;
}
