import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { musicCapabilities } from "./catalog";
import type { ProjectDocument, ProjectShot } from "./projects";
import type { MediaModel } from "./types";

/**
 * A film's music (ADR-0067): one piece under the whole film, or a cue sheet
 * with music where the story needs it. Either way the unit is the cue, and a
 * cue is anchored on shots, never on seconds: its length is the sum of the
 * shots it plays under, resolved by the app from the model each shot renders
 * with, so reordering or retiming a shot moves the music with it.
 */

export type ScoreMode = "single" | "cues";
export type CueIntensity = "low" | "medium" | "high";

export interface ProjectCue {
  id: string;
  title: string;
  /** The first and last shot it plays under, by id, inclusive. */
  fromShotId: string;
  toShotId: string;
  /** A few words, in the writer's language. */
  mood: string;
  intensity: CueIntensity;
  /** What the music model receives after the identity, in English. */
  prompt: string;
  /** Words to sing, for a model that requires them. */
  lyrics?: string;
  /** The music model the prompt was last written for with AI. A label. */
  promptOptimizedFor?: string;
  takeIds: string[];
  activeTakeId?: string;
}

export interface ProjectScore {
  mode: ScoreMode;
  /** What every cue shares: genre, instruments, tempo range, colour. */
  identity: string;
  cues: ProjectCue[];
}

/** A beat of music after the last shot, so a cue ends on a release, not a cut. */
export const CUE_TAIL_SECONDS = 2;

/** The node id a cue compiles to; `nodeTarget` reads it back. */
export const cueNodeId = (cue: Pick<ProjectCue, "id">) => `score-${cue.id}`;

export function newCue(fromShotId: string, toShotId: string, title = t("New cue")): ProjectCue {
  return {
    id: crypto.randomUUID(),
    title,
    fromShotId,
    toShotId,
    mood: "",
    intensity: "medium",
    prompt: "",
    takeIds: [],
  };
}

export function emptyScore(mode: ScoreMode = "cues"): ProjectScore {
  return { mode, identity: "", cues: [] };
}

/**
 * The shots a cue plays under, in the film's current order. Empty when an
 * anchor was removed: the cue then asks to be placed again rather than
 * silently covering something else.
 */
export function cueShots(shots: readonly ProjectShot[], cue: ProjectCue): ProjectShot[] {
  const from = shots.findIndex((shot) => shot.id === cue.fromShotId);
  const to = shots.findIndex((shot) => shot.id === cue.toShotId);
  if (from === -1 || to === -1) return [];
  return shots.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** The shot numbers a cue covers, one-based, for "shots 4 to 7". */
export function cueSpan(
  shots: readonly ProjectShot[],
  cue: ProjectCue,
): { first: number; last: number } | undefined {
  const covered = cueShots(shots, cue);
  if (!covered.length) return undefined;
  return {
    first: shots.indexOf(covered[0]) + 1,
    last: shots.indexOf(covered[covered.length - 1]) + 1,
  };
}

/** How long the music must run to cover its shots and let go after them. */
export function cueSeconds(
  shots: readonly ProjectShot[],
  cue: ProjectCue,
  secondsOf: (shot: ProjectShot) => number,
): number {
  const covered = cueShots(shots, cue);
  if (!covered.length) return 0;
  return covered.reduce((sum, shot) => sum + secondsOf(shot), 0) + CUE_TAIL_SECONDS;
}

/**
 * The length to ask a music model for. A model that takes a duration gets the
 * cue's, snapped up to its step and clamped to its range; the montage trims
 * what runs over. A model that takes none gets nothing, and writes the length
 * it writes.
 */
export function musicLength(
  model: MediaModel | undefined,
  wanted: number,
): { seconds?: number; longer: boolean; shorter: boolean } {
  const range = model ? musicCapabilities(model.id).durationSeconds : undefined;
  if (!range || !(wanted > 0)) return { longer: false, shorter: false };
  const steps = Math.ceil((wanted - range.min) / range.step);
  const seconds = Math.min(range.max, Math.max(range.min, range.min + steps * range.step));
  return { seconds, longer: seconds > wanted, shorter: seconds < wanted };
}

/** What the music model reads: the shared identity, then this cue. */
export function cuePrompt(score: ProjectScore, cue: ProjectCue): string {
  return [score.identity.trim(), cue.prompt.trim() || cue.mood.trim() || cue.title.trim()]
    .filter(Boolean)
    .join(" ");
}

/**
 * The score as the project holds it, repaired: a single score has one cue
 * covering the whole film whatever was stored, and a legacy project that only
 * ticked "generate a musical score" becomes a single score.
 */
export function projectScore(document: ProjectDocument): ProjectScore | undefined {
  const score = document.score ?? (document.settings.withScore ? emptyScore("single") : undefined);
  if (!score) return undefined;
  if (score.mode !== "single") return score;
  const first = document.shots[0]?.id;
  const last = document.shots[document.shots.length - 1]?.id;
  if (!first || !last) return { ...score, cues: score.cues.slice(0, 1) };
  // A stable id, so the piece a take was made for is still this one after
  // the repaired score is saved.
  const cue = score.cues[0] ?? { ...newCue(first, last, t("Score")), id: "whole-film" };
  return { ...score, cues: [{ ...cue, fromShotId: first, toShotId: last }] };
}

export interface ProposedCue {
  title: string;
  from: number;
  to: number;
  mood: string;
  intensity: string;
  prompt: string;
}

export interface ScoreProposal {
  identity: string;
  cues: ProposedCue[];
  promptVersion: string;
}

export function proposeScore(request: {
  script: string;
  shots: Array<{ title: string; action: string; seconds: number; dialogue: boolean }>;
  single: boolean;
  lyrics: boolean;
  modelId?: string;
}): Promise<ScoreProposal> {
  return invoke<ScoreProposal>("score_propose", { request });
}

/**
 * A proposal as cues of this project. The indices were clamped against the
 * shot list the proposal was made from; one that no longer lands on a shot is
 * dropped rather than moved.
 */
export function acceptProposal(
  proposal: ScoreProposal,
  shots: ReadonlyArray<Pick<ProjectShot, "id"> | undefined>,
  mode: ScoreMode,
  previous?: ProjectScore,
): ProjectScore {
  const cues = proposal.cues.flatMap((cue) => {
    const from = shots[cue.from];
    const to = shots[cue.to];
    if (!from || !to) return [];
    const intensity: CueIntensity =
      cue.intensity === "low" || cue.intensity === "high" ? cue.intensity : "medium";
    return [
      {
        ...newCue(from.id, to.id, cue.title || t("Cue")),
        mood: cue.mood,
        intensity,
        prompt: cue.prompt,
      },
    ];
  });
  // Takes already made stay with the cue they were made for when its span did
  // not move, so accepting a new reading never throws away paid music.
  const kept = cues.map((cue) => {
    const same = previous?.cues.find(
      (old) => old.fromShotId === cue.fromShotId && old.toShotId === cue.toShotId,
    );
    return same ? { ...cue, takeIds: same.takeIds, activeTakeId: same.activeTakeId } : cue;
  });
  return { mode, identity: proposal.identity, cues: kept };
}
