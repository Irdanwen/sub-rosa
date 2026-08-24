/**
 * Timeline export: the cut as a file another editor can open.
 *
 * See `./fcpxml` for why this exists at all - in short, it is the finishing
 * path that lets the app keep refusing to ship ffmpeg.
 */

export { toFcpxml } from "./fcpxml";
export { toSrt } from "./srt";
export { toXmeml } from "./xmeml";
export {
  DEFAULT_FRAME_RATE,
  FRAME_RATES,
  type FrameRate,
  framesPerSecond,
  srtTimecode,
  toFrames,
  toSeconds,
} from "./timebase";
export {
  AUDIO_LANES,
  type AudioLane,
  TIMELINE_FORMAT_EXTENSIONS,
  TIMELINE_FORMAT_LABELS,
  type TimelineAudioClip,
  type TimelineClip,
  type TimelineCut,
  type TimelineFormat,
  type TimelineSubtitle,
} from "./types";
export { assertWritable, timelineProblems } from "./validate";

import { toFcpxml } from "./fcpxml";
import type { TimelineCut, TimelineFormat } from "./types";
import { toXmeml } from "./xmeml";

/** Writes the cut in whichever dialect was asked for. */
export function toTimeline(cut: TimelineCut, format: TimelineFormat): string {
  return format === "xmeml" ? toXmeml(cut) : toFcpxml(cut);
}
