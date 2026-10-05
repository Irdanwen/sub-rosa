import { duckStops, type GainStop } from "../mix";
import {
  type EditorClip,
  type EditorDocument,
  type EditorTrack,
  durationFrames,
  fps,
} from "./document";

/**
 * Music gets out of the way of the dialogue in the montage, the way it does in
 * the offline mix (ADR-0033): the same deterministic dip, drawn from where the
 * lines are rather than from what a detector hears. The monitor and the
 * recorder play through one graph, so what is previewed is what is exported.
 */

/** A track that dips under the dialogue. The music track does unless told not to. */
export function ducksUnderDialogue(track: EditorTrack | undefined): boolean {
  return track?.kind === "audio" && (track.duckUnderDialogue ?? track.id === "music");
}

/** The level at a moment, between the stops either side of it. */
export function gainAt(stops: readonly GainStop[], seconds: number): number {
  if (!stops.length) return 1;
  if (seconds <= stops[0].atSeconds) return stops[0].gain;
  for (let index = 1; index < stops.length; index++) {
    const left = stops[index - 1];
    const right = stops[index];
    if (seconds <= right.atSeconds) {
      const span = right.atSeconds - left.atSeconds;
      return span > 0
        ? left.gain + ((right.gain - left.gain) * (seconds - left.atSeconds)) / span
        : right.gain;
    }
  }
  return stops[stops.length - 1].gain;
}

/**
 * The dip each clip gets at a timeline frame: 1 for anything that does not
 * duck, the music level under the dialogue windows for what does. The lines
 * are the audible clips on the dialogue track, and the takes marked as
 * speaking their own line.
 */
export function dialogueDuck(doc: EditorDocument): (clip: EditorClip, frame: number) => number {
  const rate = fps(doc);
  const dialogue = doc.tracks.find((track) => track.id === "dialogue");
  const audible = new Set(doc.tracks.filter((track) => !track.muted).map((track) => track.id));
  const windows = doc.clips
    .filter(
      (clip) =>
        clip.artifactId &&
        // The lines on the dialogue track, and the takes whose model spoke
        // its own line (ADR-0074): a voice is a voice wherever it sits.
        ((dialogue && !dialogue.muted && !dialogue.hidden && clip.trackId === dialogue.id) ||
          (clip.speaks && audible.has(clip.trackId))),
    )
    .map((clip) => ({ start: clip.start / rate, end: (clip.start + clip.duration) / rate }));
  const stops = duckStops(windows, { durationSeconds: durationFrames(doc) / rate });
  const ducking = new Set(doc.tracks.filter(ducksUnderDialogue).map((track) => track.id));
  return (clip, frame) => (ducking.has(clip.trackId) ? gainAt(stops, frame / rate) : 1);
}
