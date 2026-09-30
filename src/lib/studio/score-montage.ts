import { t } from "../i18n";
import { createEditorClip, type EditorClip, type EditorDocument, fps } from "./editor/document";
import type { ProjectShot } from "./projects";
import { CUE_TAIL_SECONDS, cueShots, type ProjectScore } from "./score";

/** How a cue comes in, and how it lets go. */
export const CUE_FADE_IN_SECONDS = 0.5;
export const CUE_FADE_OUT_SECONDS = 1.5;

/**
 * Lay each cue's chosen take on the music track under the shots it scores
 * (ADR-0067). A cue starts where the clip of its first shot starts in the
 * montage, whichever take of that shot the editor used, and stops at the end
 * of its last shot's clip plus its release, or where its music runs out. A
 * longer piece is trimmed, not stretched. Placing again replaces what an
 * earlier placement put there, so a new take of a cue swaps in cleanly, and
 * music the person placed by hand is never touched.
 */
export function placeScore(
  timeline: EditorDocument,
  shots: readonly ProjectShot[],
  score: ProjectScore,
  secondsOf: (artifactId: string) => number | undefined,
): { timeline: EditorDocument; placed: number; unplaced: string[] } {
  const music = timeline.tracks.find((track) => track.id === "music");
  if (!music || music.locked || music.hidden)
    throw new Error(t("Unlock and show the music track before placing the music."));
  const rate = fps(timeline);
  /** Where a shot sits in the cut: the first picture clip made from one of its takes. */
  const clipOf = (shot: ProjectShot): EditorClip | undefined =>
    timeline.clips
      .filter(
        (clip) =>
          clip.trackId === "picture" && clip.artifactId && shot.takeIds.includes(clip.artifactId),
      )
      .sort((left, right) => left.start - right.start)[0];
  const cueTakes = new Set(score.cues.flatMap((cue) => cue.takeIds));
  const clips = timeline.clips.filter(
    (clip) => !(clip.trackId === music.id && clip.artifactId && cueTakes.has(clip.artifactId)),
  );
  const unplaced: string[] = [];
  let placed = 0;
  for (const cue of score.cues) {
    if (!cue.activeTakeId) continue;
    const covered = cueShots(shots, cue);
    const first = covered[0] ? clipOf(covered[0]) : undefined;
    const seconds = secondsOf(cue.activeTakeId);
    if (!first || !seconds) {
      unplaced.push(cue.title);
      continue;
    }
    const last = clipOf(covered[covered.length - 1]);
    const available = Math.max(1, Math.round(seconds * rate));
    const wanted = last
      ? last.start + last.duration + Math.round(CUE_TAIL_SECONDS * rate) - first.start
      : available;
    const duration = Math.max(1, Math.min(available, wanted));
    const half = Math.floor(duration / 2);
    clips.push(
      createEditorClip({
        name: cue.title,
        artifactId: cue.activeTakeId,
        trackId: music.id,
        start: first.start,
        duration,
        sourceDuration: available,
        fadeIn: Math.min(half, Math.round(CUE_FADE_IN_SECONDS * rate)),
        fadeOut: Math.min(half, Math.round(CUE_FADE_OUT_SECONDS * rate)),
      }),
    );
    placed += 1;
  }
  return { timeline: { ...timeline, clips }, placed, unplaced };
}
