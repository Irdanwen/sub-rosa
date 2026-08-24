/**
 * What a timeline export is handed.
 *
 * Deliberately platform-free: no artifact, no Tauri path, no gallery. Callers
 * resolve media into an `href` themselves, because the right href differs by
 * shell and getting that wrong is not a formatting bug but a broken project.
 * On desktop it is an absolute `file://` URL. On iOS it is a relative name
 * next to the XML in an exported folder, because the app's data container
 * moves on every reinstall and an absolute path written today points nowhere
 * tomorrow.
 */

import type { FrameRate } from "./timebase";

/** A shot on the picture track. */
export interface TimelineClip {
  /** What the NLE shows on the clip. */
  name: string;
  /** Where the media is, already URL-encoded if it is a URL. */
  href: string;
  /** Trim in, seconds from the start of the source file. */
  inSeconds: number;
  /** Trim out, seconds from the start of the source file. */
  outSeconds: number;
  /** Full length of the source file. Needed: an NLE validates against it. */
  sourceDurationSeconds: number;
  /** Whether the file carries an audio track of its own. */
  hasAudio: boolean;
}

/** The three audio lanes, in the order they stack under the picture. */
export const AUDIO_LANES = ["dialogue", "sfx", "music"] as const;
export type AudioLane = (typeof AUDIO_LANES)[number];

/** A sound placed at an absolute point on the timeline. */
export interface TimelineAudioClip {
  name: string;
  href: string;
  inSeconds: number;
  outSeconds: number;
  sourceDurationSeconds: number;
  /** Where it starts on the timeline, seconds from the top. */
  atSeconds: number;
  /** Linear gain, 1 being unity. Written as the clip's level. */
  gain?: number;
}

/** One subtitle, for the `.srt` companion. */
export interface TimelineSubtitle {
  atSeconds: number;
  untilSeconds: number;
  text: string;
}

/** A whole cut, ready to be written out in any of the supported formats. */
export interface TimelineCut {
  name: string;
  frameRate: FrameRate;
  width: number;
  height: number;
  /** The picture track, in order. Each clip butts against the previous one. */
  clips: TimelineClip[];
  /** Sound under the picture. A missing lane is simply absent. */
  audio?: Partial<Record<AudioLane, TimelineAudioClip[]>>;
  subtitles?: TimelineSubtitle[];
}

/**
 * Which dialect to write.
 *
 * There is deliberately no separate "Resolve-tuned" FCPXML, although the
 * reference design this borrows from ships one. Resolve reads FCPXML, and the
 * differences people tune for are folklore that changes with each Resolve
 * release. A single conservative document - only constructs that have been in
 * the format since 1.8, written as 1.10 - is something we can reason about and
 * test. Two documents where one is a guess would mean shipping a file we could
 * not defend, and the user finding out which is which.
 */
export type TimelineFormat = "fcpxml" | "xmeml";

export const TIMELINE_FORMAT_LABELS: Record<TimelineFormat, string> = {
  fcpxml: "Final Cut Pro and Resolve",
  xmeml: "Premiere Pro",
};

export const TIMELINE_FORMAT_EXTENSIONS: Record<TimelineFormat, string> = {
  fcpxml: "fcpxml",
  xmeml: "xml",
};
