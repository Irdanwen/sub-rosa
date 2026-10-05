/**
 * How each video family is written to: its word budget, whether it reads the
 * bible's block labels, how it takes time, whether it renders sound and in
 * which languages it speaks a line.
 *
 * The figures live in `direction/profiles.json`, which Rust reads too, so the
 * deterministic prompt and the AI rewrite never disagree about a family.
 */

import profiles from "../direction/profiles.json";
import type { MediaModel } from "../types";

export type TimecodeStyle = "brackets" | "label" | "words";
export type DialogueSyntax = "h3" | "kling" | "seedance" | "wan" | "veo" | "plain";

export interface FamilyProfile {
  family: string;
  match: string[];
  budgetWords: number;
  /** False for a starting value still to be measured on real renders. */
  budgetMeasured: boolean;
  /** Writes `[OVERALL]`... `[NEGATIVE]`; otherwise the same order, in prose. */
  labels: boolean;
  /**
   * `brackets`: reads `[00:00-00:03]` segments inside one take.
   * `label`: takes a range on the shot label only.
   * `words`: no number anywhere. Kling's own notation cuts to a new shot.
   */
  timecodes: TimecodeStyle;
  /** A line the family wants first, before anything else. */
  firstLine?: string;
  /** Whether it renders sound, when the catalog publishes no flag. */
  rendersAudio: boolean;
  /** Languages it speaks a line in. Empty: every line is dubbed. */
  dialogueLangs: string[];
  dialogueSyntax: DialogueSyntax;
}

interface ProfilesFile {
  profiles: FamilyProfile[];
  default: FamilyProfile;
}

const FILE = profiles as unknown as ProfilesFile;

export const DEFAULT_PROFILE: FamilyProfile = FILE.default;

export function familyProfile(model: Pick<MediaModel, "id"> | undefined): FamilyProfile {
  const id = model?.id.toLowerCase() ?? "";
  return (
    FILE.profiles.find((profile) => profile.match.some((stem) => id.includes(stem))) ??
    DEFAULT_PROFILE
  );
}

/**
 * Whether this model renders sound with its picture. The operator's own flag
 * wins in both directions; the profile only answers when it says nothing.
 */
export function rendersAudio(model: Pick<MediaModel, "id" | "constraints"> | undefined): boolean {
  const published = model?.constraints?.audio;
  if (typeof published === "boolean") return published;
  return familyProfile(model).rendersAudio;
}

/** Whether the request can switch that sound off (`audio: false`). */
export function canSilence(model: Pick<MediaModel, "constraints"> | undefined): boolean {
  return model?.constraints?.audio_configurable === true;
}
