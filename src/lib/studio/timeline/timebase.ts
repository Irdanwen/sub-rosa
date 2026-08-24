/**
 * The timebase: seconds in, exact frames out.
 *
 * Every NLE interchange format counts in frames, not in seconds, and every one
 * of them rejects a file whose times do not land on a frame boundary. Our
 * inputs are the opposite: `HTMLMediaElement.duration` and the trim handles are
 * floating-point seconds. So one place converts, once, and everything
 * downstream works in integers.
 *
 * NTSC rates are the reason this is not a multiplication. 29.97 is not 29.97,
 * it is 30000/1001, and writing `29.97` into a frame duration produces a
 * timeline that drifts by about a second an hour - visible on anything longer
 * than a trailer, and impossible to explain to whoever inherits the project.
 * A rate is therefore a whole base plus a flag, never a decimal.
 */

/**
 * A frame rate as the formats want it: a whole base, and whether the 1000/1001
 * pulldown applies. `{ base: 30, ntsc: true }` is 29.97.
 */
export interface FrameRate {
  base: number;
  ntsc: boolean;
}

export const FRAME_RATES: Record<string, FrameRate> = {
  "23.976": { base: 24, ntsc: true },
  "24": { base: 24, ntsc: false },
  "25": { base: 25, ntsc: false },
  "29.97": { base: 30, ntsc: true },
  "30": { base: 30, ntsc: false },
  "50": { base: 50, ntsc: false },
  "59.94": { base: 60, ntsc: true },
  "60": { base: 60, ntsc: false },
};

/** What most generated clips are, and a safe default for a mixed cut. */
export const DEFAULT_FRAME_RATE: FrameRate = FRAME_RATES["30"];

/** Frames per second as a real number. Only for arithmetic, never for output. */
export function framesPerSecond(rate: FrameRate): number {
  return rate.ntsc ? (rate.base * 1000) / 1001 : rate.base;
}

/** The denominator every FCPXML time in this timeline shares. */
export function timescale(rate: FrameRate): number {
  return rate.ntsc ? rate.base * 1000 : rate.base;
}

/** The numerator of one frame at this rate. */
export function frameTicks(rate: FrameRate): number {
  return rate.ntsc ? 1001 : 1;
}

/** Seconds to whole frames, rounded to the nearest. Never negative. */
export function toFrames(seconds: number, rate: FrameRate): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.max(0, Math.round(seconds * framesPerSecond(rate)));
}

/** Whole frames back to seconds, for anything that has to display a duration. */
export function toSeconds(frames: number, rate: FrameRate): number {
  return frames / framesPerSecond(rate);
}

/**
 * An FCPXML time value: a rational with the timeline's own denominator.
 *
 * Always rational, even for whole seconds. `"3s"` is legal and `"90/30s"` is
 * legal, but mixing the two in one document is how a sequence ends up with a
 * clip one frame out - so this only ever emits the second form.
 */
export function fcpTime(frames: number, rate: FrameRate): string {
  return `${frames * frameTicks(rate)}/${timescale(rate)}s`;
}

/** `frameDuration` for a `<format>`: one frame, as a rational. */
export function fcpFrameDuration(rate: FrameRate): string {
  return `${frameTicks(rate)}/${timescale(rate)}s`;
}

/** The `<timebase>` Premiere wants: the whole base, with NTSC as a sibling flag. */
export function xmemlTimebase(rate: FrameRate): { timebase: number; ntsc: "TRUE" | "FALSE" } {
  return { timebase: rate.base, ntsc: rate.ntsc ? "TRUE" : "FALSE" };
}

/** `HH:MM:SS,mmm`, the only timecode SubRip understands. */
export function srtTimecode(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const whole = Math.floor(clamped);
  const millis = Math.round((clamped - whole) * 1000);
  // Rounding up to 1000 ms must carry into the seconds, not print ",1000".
  const carried = millis === 1000 ? whole + 1 : whole;
  const ms = millis === 1000 ? 0 : millis;
  const hours = Math.floor(carried / 3600);
  const minutes = Math.floor((carried % 3600) / 60);
  const secs = carried % 60;
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(ms, 3)}`;
}
