/** The editable cut is independent of generated takes. All positions are integer
 * project frames; media paths are resolved from the gallery only at playback. */
import { t } from "../../i18n";
import { DEFAULT_FRAME_RATE, type FrameRate, framesPerSecond } from "../timeline";
import type { ArtifactKind } from "../types";

export interface Keyframe {
  frame: number;
  value: number;
}
export type AnimatedProperty = "x" | "y" | "scale" | "rotation" | "opacity" | "volume" | "speed";
export interface CubeLut {
  name: string;
  size: number;
  values: number[];
  domainMin: number[];
  domainMax: number[];
}
export interface ClipGrade {
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  blur: number;
  /** Five equally spaced input samples, linear interpolation between them. */
  curves: { master: number[]; red: number[]; green: number[]; blue: number[] };
  lut?: CubeLut;
}
export interface EditorClip {
  id: string;
  trackId: string;
  artifactId?: string;
  name: string;
  start: number;
  duration: number;
  sourceStart: number;
  sourceDuration: number;
  title?: string;
  properties: Record<AnimatedProperty, Keyframe[]>;
  grade: ClipGrade;
  crop: { left: number; right: number; top: number; bottom: number };
  fadeIn: number;
  fadeOut: number;
  /** Frames of the original fade already consumed by a head/tail trim. */
  fadeInOffset?: number;
  fadeOutOffset?: number;
}
export interface EditorTrack {
  id: string;
  name: string;
  kind: "video" | "audio";
  locked: boolean;
  muted: boolean;
  hidden: boolean;
}
export interface EditorDocument {
  version: 1;
  frameRate: FrameRate;
  width: number;
  height: number;
  tracks: EditorTrack[];
  clips: EditorClip[];
}
/** Keep gallery audio on the lane matching its kind. A locked or hidden
 * matching lane must be made usable before that media can be added. */
export function insertionTrack(doc: EditorDocument, kind: ArtifactKind): EditorTrack | undefined {
  if (kind === "video" || kind === "image")
    return doc.tracks.find((track) => track.kind === "video" && !track.locked && !track.hidden);
  const preferredId = kind === "music" ? "music" : kind === "sfx" ? "effects" : "dialogue";
  const preferred = doc.tracks.find((track) => track.id === preferredId && track.kind === "audio");
  if (preferred) return !preferred.locked && !preferred.hidden ? preferred : undefined;
  return doc.tracks.find((track) => track.kind === "audio" && !track.locked && !track.hidden);
}
export function titleTrack(doc: EditorDocument): EditorTrack | undefined {
  return doc.tracks.find(
    (track) => track.kind === "video" && track.id !== "picture" && !track.locked && !track.hidden,
  );
}
const defaults: Record<AnimatedProperty, number> = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  opacity: 1,
  volume: 1,
  speed: 1,
};
export const PROPERTY_DEFAULTS = defaults;
export function createEditorDocument(): EditorDocument {
  return {
    version: 1,
    frameRate: { ...DEFAULT_FRAME_RATE },
    width: 1920,
    height: 1080,
    tracks: [
      {
        id: "picture",
        name: t("Picture"),
        kind: "video",
        locked: false,
        muted: false,
        hidden: false,
      },
      {
        id: "dialogue",
        name: t("Dialogue"),
        kind: "audio",
        locked: false,
        muted: false,
        hidden: false,
      },
      {
        id: "effects",
        name: t("Sound effects"),
        kind: "audio",
        locked: false,
        muted: false,
        hidden: false,
      },
      { id: "music", name: t("Music"), kind: "audio", locked: false, muted: false, hidden: false },
    ],
    clips: [],
  };
}
export function createEditorClip(
  input: Pick<EditorClip, "trackId" | "name" | "duration"> & Partial<EditorClip>,
): EditorClip {
  return {
    id: crypto.randomUUID(),
    start: 0,
    sourceStart: 0,
    sourceDuration: input.duration,
    properties: Object.fromEntries(
      Object.entries(defaults).map(([key, value]) => [key, [{ frame: 0, value }]]),
    ) as EditorClip["properties"],
    grade: {
      exposure: 0,
      contrast: 1,
      saturation: 1,
      temperature: 0,
      blur: 0,
      curves: {
        master: [0, 0.25, 0.5, 0.75, 1],
        red: [0, 0.25, 0.5, 0.75, 1],
        green: [0, 0.25, 0.5, 0.75, 1],
        blue: [0, 0.25, 0.5, 0.75, 1],
      },
    },
    crop: { left: 0, right: 0, top: 0, bottom: 0 },
    fadeIn: 0,
    fadeOut: 0,
    ...input,
  };
}
export function durationFrames(doc: EditorDocument): number {
  return Math.max(0, ...doc.clips.map((c) => c.start + c.duration));
}
export function fps(doc: EditorDocument): number {
  return framesPerSecond(doc.frameRate);
}
export function valueAt(points: Keyframe[], frame: number, fallback = 0): number {
  if (!points.length) return fallback;
  const first = points[0];
  if (frame <= first.frame) return first.value;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    if (frame <= b.frame)
      return a.value + ((b.value - a.value) * (frame - a.frame)) / (b.frame - a.frame);
  }
  return points[points.length - 1].value;
}
/** Exact integral of a piecewise-linear speed curve, in source frames. */
export function sourceOffset(clip: EditorClip, localFrame: number): number {
  if (localFrame < 0) {
    const boundaries = [
      localFrame,
      ...clip.properties.speed
        .filter((p) => p.frame > localFrame && p.frame < 0)
        .map((p) => p.frame),
      0,
    ];
    return -boundaries.slice(1).reduce((total, right, i) => {
      const left = boundaries[i];
      return (
        total +
        ((right - left) *
          (valueAt(clip.properties.speed, left, 1) + valueAt(clip.properties.speed, right, 1))) /
          2
      );
    }, 0);
  }
  const end = Math.max(0, localFrame);
  const boundaries = [
    0,
    ...clip.properties.speed.filter((p) => p.frame > 0 && p.frame < end).map((p) => p.frame),
    end,
  ];
  return boundaries.slice(1).reduce((total, right, i) => {
    const left = boundaries[i];
    return (
      total +
      ((right - left) *
        (valueAt(clip.properties.speed, left, 1) + valueAt(clip.properties.speed, right, 1))) /
        2
    );
  }, 0);
}
export function sourceFrame(clip: EditorClip, localFrame: number): number {
  return clip.sourceStart + sourceOffset(clip, localFrame);
}
export function setKeyframe(
  clip: EditorClip,
  property: AnimatedProperty,
  frame: number,
  value: number,
): EditorClip {
  if (!Number.isFinite(value)) return clip;
  if (property === "speed") value = Math.max(0.0625, Math.min(16, value));
  if (property === "scale") value = Math.max(0.01, value);
  if (property === "opacity") value = Math.max(0, Math.min(1, value));
  if (property === "volume") value = Math.max(0, Math.min(4, value));
  const point = { frame: Math.max(0, Math.min(clip.duration - 1, Math.round(frame))), value };
  return {
    ...clip,
    properties: {
      ...clip.properties,
      [property]: [...clip.properties[property].filter((p) => p.frame !== point.frame), point].sort(
        (a, b) => a.frame - b.frame,
      ),
    },
  };
}
function slicedProperties(clip: EditorClip, from: number, until: number): EditorClip["properties"] {
  return Object.fromEntries(
    Object.entries(clip.properties).map(([key, points]) => [
      key,
      [
        ...points.filter((p) => p.frame < from).map((p) => ({ ...p, frame: p.frame - from })),
        { frame: 0, value: valueAt(points, from, defaults[key as AnimatedProperty]) },
        ...points
          .filter((p) => p.frame > from && p.frame < until)
          .map((p) => ({ ...p, frame: p.frame - from })),
        { frame: until - from, value: valueAt(points, until, defaults[key as AnimatedProperty]) },
        // Keep hidden future keys so extending the right edge can reveal the
        // original animation and speed ramp without changing the visible cut.
        ...points.filter((p) => p.frame > until).map((p) => ({ ...p, frame: p.frame - from })),
      ],
    ]),
  ) as EditorClip["properties"];
}
export function isLocked(doc: EditorDocument, clip: EditorClip): boolean {
  return doc.tracks.find((t) => t.id === clip.trackId)?.locked ?? true;
}
export function replaceClip(doc: EditorDocument, clip: EditorClip): EditorDocument {
  const previous = doc.clips.find((c) => c.id === clip.id);
  if (!previous || isLocked(doc, previous)) return doc;
  return { ...doc, clips: doc.clips.map((c) => (c.id === clip.id ? clip : c)) };
}
export function splitClip(doc: EditorDocument, id: string, at: number): EditorDocument {
  const clip = doc.clips.find((c) => c.id === id);
  if (!clip || isLocked(doc, clip)) return doc;
  const cut = Math.round(at) - clip.start;
  if (cut <= 0 || cut >= clip.duration) return doc;
  const left = {
    ...clip,
    duration: cut,
    fadeOutOffset: (clip.fadeOutOffset ?? 0) + clip.duration - cut,
    properties: slicedProperties(clip, 0, cut),
  };
  const right = {
    ...clip,
    id: crypto.randomUUID(),
    start: clip.start + cut,
    duration: clip.duration - cut,
    sourceStart: sourceFrame(clip, cut),
    fadeInOffset: (clip.fadeInOffset ?? 0) + cut,
    properties: slicedProperties(clip, cut, clip.duration),
  };
  return { ...doc, clips: doc.clips.flatMap((c) => (c.id === id ? [left, right] : [c])) };
}
/** Trimming consumes the same speed integral as playback, preserving sync. */
export function trimClip(
  doc: EditorDocument,
  id: string,
  from: number,
  until: number,
): EditorDocument {
  const clip = doc.clips.find((c) => c.id === id);
  if (!clip || isLocked(doc, clip)) return doc;
  from = Math.max(0, Math.round(from));
  until = Math.min(clip.duration, Math.round(until));
  if (until <= from) return doc;
  return replaceClip(doc, {
    ...clip,
    start: clip.start + from,
    sourceStart: sourceFrame(clip, from),
    duration: until - from,
    properties: slicedProperties(clip, from, until),
    fadeInOffset: (clip.fadeInOffset ?? 0) + from,
    fadeOutOffset: (clip.fadeOutOffset ?? 0) + clip.duration - until,
  });
}
/** Numeric duration edits use the same right-edge trim as dragging. Extending
 * reveals source frames and consumes any fade-out offset from a prior trim. */
export function resizeClip(doc: EditorDocument, id: string, duration: number): EditorDocument {
  const clip = doc.clips.find((candidate) => candidate.id === id);
  if (!clip || isLocked(doc, clip)) return doc;
  let next = Math.max(1, Math.round(duration));
  if (next === clip.duration) return doc;
  if (next < clip.duration) return trimClip(doc, id, 0, next);
  if (clip.artifactId) {
    let low = clip.duration;
    let high = next;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (sourceFrame(clip, mid) <= clip.sourceDuration + 0.01) low = mid;
      else high = mid - 1;
    }
    next = low;
    if (next === clip.duration) return doc;
  }
  return replaceClip(doc, {
    ...clip,
    duration: next,
    fadeOutOffset: Math.max(0, (clip.fadeOutOffset ?? 0) - (next - clip.duration)),
  });
}
/** Move the left edge in either direction without losing hidden source keys. */
export function resizeClipLeft(doc: EditorDocument, id: string, delta: number): EditorDocument {
  const clip = doc.clips.find((candidate) => candidate.id === id);
  if (!clip || isLocked(doc, clip)) return doc;
  const frames = Math.round(delta);
  if (!frames) return doc;
  if (frames >= 0) return trimClip(doc, id, frames, clip.duration);
  let low = 0;
  let high = Math.min(-frames, clip.start);
  if (clip.artifactId) {
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (sourceFrame(clip, -mid) >= -0.01) low = mid;
      else high = mid - 1;
    }
  } else low = high;
  if (!low) return doc;
  const properties = Object.fromEntries(
    Object.entries(clip.properties).map(([key, points]) => [
      key,
      [
        { frame: 0, value: valueAt(points, -low, defaults[key as AnimatedProperty]) },
        ...points
          .map((point) => ({ ...point, frame: point.frame + low }))
          .filter((point) => point.frame !== 0),
      ].sort((a, b) => a.frame - b.frame),
    ]),
  ) as EditorClip["properties"];
  return replaceClip(doc, {
    ...clip,
    start: clip.start - low,
    sourceStart: sourceFrame(clip, -low),
    duration: clip.duration + low,
    fadeInOffset: Math.max(0, (clip.fadeInOffset ?? 0) - low),
    properties,
  });
}
export function removeClip(doc: EditorDocument, id: string, ripple = false): EditorDocument {
  const clip = doc.clips.find((c) => c.id === id);
  if (!clip || isLocked(doc, clip)) return doc;
  // Ripple closes only this track; unrelated dialogue/music does not move silently.
  return {
    ...doc,
    clips: doc.clips
      .filter((c) => c.id !== id)
      .map((c) =>
        ripple && c.trackId === clip.trackId && c.start >= clip.start + clip.duration
          ? { ...c, start: c.start - clip.duration }
          : c,
      ),
  };
}
export function duplicateClip(doc: EditorDocument, id: string): EditorDocument {
  const clip = doc.clips.find((c) => c.id === id);
  if (!clip || isLocked(doc, clip)) return doc;
  return {
    ...doc,
    clips: [
      ...doc.clips,
      { ...structuredClone(clip), id: crypto.randomUUID(), start: clip.start + clip.duration },
    ],
  };
}
export function snapFrame(
  doc: EditorDocument,
  frame: number,
  excludeId: string,
  threshold: number,
): number {
  const anchors = [
    0,
    ...doc.clips.filter((c) => c.id !== excludeId).flatMap((c) => [c.start, c.start + c.duration]),
  ];
  let best = Math.max(0, Math.round(frame));
  let distance = threshold + 1;
  for (const point of anchors) {
    const candidate = Math.abs(frame - point);
    if (candidate <= threshold && candidate < distance) {
      best = point;
      distance = candidate;
    }
  }
  return best;
}
export function clipFade(clip: EditorClip, localFrame: number): number {
  return Math.max(
    0,
    Math.min(
      1,
      clip.fadeIn ? (localFrame + (clip.fadeInOffset ?? 0)) / clip.fadeIn : 1,
      clip.fadeOut ? (clip.duration - localFrame + (clip.fadeOutOffset ?? 0)) / clip.fadeOut : 1,
    ),
  );
}
export function clipOpacity(clip: EditorClip, localFrame: number): number {
  return valueAt(clip.properties.opacity, localFrame, 1) * clipFade(clip, localFrame);
}
export function validateEditorDocument(doc: EditorDocument): string[] {
  const errors: string[] = [];
  if (doc.version !== 1 || !Number.isFinite(fps(doc)) || fps(doc) <= 0)
    errors.push(t("The montage frame rate is invalid."));
  if (
    !Number.isInteger(doc.width) ||
    !Number.isInteger(doc.height) ||
    doc.width < 2 ||
    doc.height < 2 ||
    doc.width > 7680 ||
    doc.height > 4320
  )
    errors.push(t("Choose a valid montage resolution."));
  const trackIds = new Set(doc.tracks.map((track) => track.id));
  for (const clip of doc.clips) {
    if (
      !trackIds.has(clip.trackId) ||
      !Number.isInteger(clip.start) ||
      clip.start < 0 ||
      !Number.isInteger(clip.duration) ||
      clip.duration < 1
    )
      errors.push(t("The placement of {name} is invalid.", { name: clip.name }));
    if (clip.properties.speed.some((p) => !Number.isFinite(p.value) || p.value <= 0))
      errors.push(t("Choose a positive speed for {name}.", { name: clip.name }));
    if (clip.artifactId && sourceFrame(clip, clip.duration) > clip.sourceDuration + 0.01)
      errors.push(
        t("{name} runs past the end of its source. Shorten it or reduce its speed.", {
          name: clip.name,
        }),
      );
  }
  return errors;
}
