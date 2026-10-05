import { t } from "../i18n";
import { entry } from "./direction/vocabulary";
import { createEditorClip, type EditorDocument, fps } from "./editor/document";

/** A selected take, measured, with what its shot says about joining and sound. */
export interface TakeToPlace {
  title: string;
  artifactId: string;
  seconds: number;
  parentId?: string;
  parentHandoffSeconds?: number;
  /** How this shot joins the one before (a vocabulary id). */
  transition?: string;
  /** The model spoke the shot's line: the music dips under it. */
  speaks?: boolean;
  /** The take carries a voice a dubbed line would double. */
  mute?: boolean;
}

/**
 * Appends the selected takes to the picture track, back to back.
 *
 * A chained take is cut at its handoff so the seam lands on movement
 * (ADR-0019). A shot's transition is the montage's job, never the prompt's
 * (ADR-0074): a fade to black is a fade out and in around the cut, and a
 * dissolve, on one picture track, is the same dip made short.
 */
export function appendTakes(
  timeline: EditorDocument,
  selected: readonly TakeToPlace[],
): EditorDocument {
  const next = structuredClone(timeline);
  const picture = next.tracks.find((track) => track.id === "picture");
  if (!picture || picture.locked || picture.hidden)
    throw new Error(t("Unlock and show the picture track before appending takes."));
  const rate = fps(next);
  let start = Math.max(
    0,
    ...next.clips
      .filter((clip) => clip.trackId === "picture")
      .map((clip) => clip.start + clip.duration),
  );
  let previous: ReturnType<typeof createEditorClip> | undefined;
  for (const [index, item] of selected.entries()) {
    const following = selected[index + 1];
    const handoff = following?.parentHandoffSeconds;
    const outSeconds =
      following?.parentId === item.artifactId &&
      typeof handoff === "number" &&
      Number.isFinite(handoff) &&
      handoff > 0
        ? Math.min(item.seconds, handoff)
        : item.seconds;
    const sourceDuration = Math.max(1, Math.round(item.seconds * rate));
    const duration = Math.max(1, Math.min(sourceDuration, Math.round(outSeconds * rate)));
    const clip = createEditorClip({
      name: item.title,
      artifactId: item.artifactId,
      trackId: "picture",
      start,
      duration,
      sourceDuration,
      ...(item.speaks ? { speaks: true } : {}),
    });
    if (item.mute) clip.properties.volume = [{ frame: 0, value: 0 }];
    const fade = entry("transitions", item.transition)?.fadeSeconds;
    if (fade && previous) {
      const frames = Math.round(fade * rate * (item.transition === "dissolve" ? 0.5 : 1));
      previous.fadeOut = Math.min(frames, previous.duration);
      clip.fadeIn = Math.min(frames, clip.duration);
    }
    next.clips.push(clip);
    previous = clip;
    start += duration;
  }
  return next;
}
