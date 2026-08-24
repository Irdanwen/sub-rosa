/**
 * Invariants an NLE will not tell you about.
 *
 * A malformed interchange file does not fail loudly. Final Cut says "the file
 * could not be imported", Resolve imports a timeline with no clips on it, and
 * Premiere silently drops the items it did not understand. None of those name
 * the problem, and all of them look like our bug from the outside. So the
 * problems we can see, we say - before writing anything.
 */

import type { TimelineCut } from "./types";
import { toFrames } from "./timebase";

/** Everything wrong with a cut, in the user's words. Empty means writable. */
export function timelineProblems(cut: TimelineCut): string[] {
  const problems: string[] = [];

  if (cut.clips.length === 0) {
    problems.push("This timeline has no shots in it.");
  }
  if (
    !Number.isFinite(cut.width) ||
    !Number.isFinite(cut.height) ||
    cut.width <= 0 ||
    cut.height <= 0
  ) {
    problems.push("This timeline has no frame size.");
  }

  cut.clips.forEach((clip, index) => {
    const position = clip.name || `Shot ${index + 1}`;
    if (!clip.href) {
      problems.push(`${position} has no file behind it.`);
    }
    if (!Number.isFinite(clip.sourceDurationSeconds) || clip.sourceDurationSeconds <= 0) {
      // The single most common cause of a rejected file: a clip whose duration
      // was never measured, so every time on it is zero or NaN.
      problems.push(`${position} has no measured duration yet.`);
      return;
    }
    if (clip.outSeconds <= clip.inSeconds) {
      problems.push(`${position} is trimmed to nothing.`);
    }
    if (toFrames(clip.outSeconds - clip.inSeconds, cut.frameRate) < 1) {
      problems.push(`${position} is shorter than one frame.`);
    }
    if (clip.outSeconds > clip.sourceDurationSeconds + 1 / 1000) {
      problems.push(`${position} is trimmed past the end of its file.`);
    }
  });

  for (const [lane, clips] of Object.entries(cut.audio ?? {})) {
    for (const [index, clip] of (clips ?? []).entries()) {
      const position = clip.name || `${lane} ${index + 1}`;
      if (!clip.href) problems.push(`${position} has no file behind it.`);
      if (!Number.isFinite(clip.sourceDurationSeconds) || clip.sourceDurationSeconds <= 0) {
        problems.push(`${position} has no measured duration yet.`);
      } else if (clip.outSeconds <= clip.inSeconds) {
        problems.push(`${position} is trimmed to nothing.`);
      }
    }
  }

  return problems;
}

/** Throws with every problem at once, rather than one round trip per fix. */
export function assertWritable(cut: TimelineCut): void {
  const problems = timelineProblems(cut);
  if (problems.length > 0) {
    throw new Error(`This timeline cannot be exported yet. ${problems.join(" ")}`);
  }
}
