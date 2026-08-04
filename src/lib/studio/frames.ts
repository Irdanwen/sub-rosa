/**
 * Frame extraction for shot continuity: pull a still out of a generated clip
 * so the next shot can start where the last one ended.
 *
 * Three things make this more than "seek to the end and grab a pixel buffer":
 *
 *  - Seeking to `duration` exactly lands past the last decoded frame on most
 *    decoders: the canvas comes back black, and some never fire `seeked` at
 *    all. Every sample is taken at least one frame short of the end.
 *  - The very last frames of a generated clip are the worst ones (motion blur,
 *    the most encode drift). We sample a few candidates and keep the sharpest.
 *  - Restarting the next shot from the exact final frame freezes the motion at
 *    the seam. Taking the handoff slightly early (and trimming the tail at
 *    assembly time) cuts on movement instead, which is what a human editor
 *    does.
 *
 * No ffmpeg: the webview decodes, a canvas reads back. Same reason
 * `./assemble` records in real time.
 */

import { downscaleDataUrl } from "./downscale";

/**
 * How far before the end the handoff frame is taken, in seconds.
 *
 * Half a second is what an editor would leave: it escapes the final blurred
 * frame and lets the cut land on movement rather than on a stalled pose. The
 * tail it skips is not lost - `chainCuts` trims the previous shot to exactly
 * this point when the chain is assembled, so nothing is replayed at the seam.
 */
export const HANDOFF_LEAD_SECONDS = 0.5;

/** Candidates scored per extraction. Each one costs a seek plus a readback
 * (tens of ms); six is enough to skip a blurred tail without a visible wait. */
export const HANDOFF_SAMPLES = 6;

/** Width of the window the candidates are spread over, centered on the lead
 * point, in seconds. */
export const HANDOFF_SPREAD_SECONDS = 0.4;

/** One frame at 25 fps: the floor for "not the very last frame". */
const FRAME_SECONDS = 0.04;

/**
 * How an extracted frame is encoded, which is not one question but two.
 *
 * `payload` is what every generation path needs: a JPEG downscaled under the
 * proxy's body cap, because the frame is about to ride inside a request.
 *
 * `capture` is what a frame kept for rework needs: the clip's native
 * resolution, PNG, no downscale. The file is going to the gallery, to disk,
 * and possibly into another editor - handing back a quietly downscaled JPEG
 * would be a lossy surprise the user cannot undo, and the size ceilings that
 * justify it do not apply to a file that is never sent anywhere.
 */
export type FrameEncoding = "payload" | "capture";

/**
 * The last position in a clip that reliably decodes to a picture.
 *
 * Seeking to `duration` itself lands past the final decoded frame on most
 * decoders: the canvas reads back black, and some never fire `seeked` at all.
 * So "the last frame" always means one frame short of the end - exported
 * because the capture UI has to be able to say so rather than let the slider
 * promise a position that would come back empty.
 */
export function lastReadableTime(durationSeconds: number): number {
  return Math.max(0, durationSeconds - FRAME_SECONDS);
}

/** Longest side of an extracted frame. Above this the payload starts tripping
 * the backend's request-size ceilings for no visible gain (the video models
 * top out at 1080p anyway). */
const FRAME_MAX_EDGE = 1920;

/** Byte ceiling for the encoded frame, well under the proxy's body cap. */
const FRAME_MAX_BYTES = 3_000_000;

/** Analysis buffer width: sharpness is a relative score between candidates of
 * the same clip, so a small buffer is both enough and much faster. */
const SHARPNESS_WIDTH = 320;

export interface ExtractedFrame {
  /** The frame as a JPEG data URL, ready to send as a start frame. */
  dataUrl: string;
  /** Where in the clip it was taken, in seconds. */
  timeSeconds: number;
  /** The clip's full duration, in seconds. */
  durationSeconds: number;
  /** Relative sharpness score; only comparable within one clip. */
  sharpness: number;
  /** The source clip's pixel dimensions, for matching the next shot's ratio. */
  width: number;
  height: number;
}

export interface HandoffOptions {
  /** Seconds before the end to aim for. Defaults to `HANDOFF_LEAD_SECONDS`. */
  leadSeconds?: number;
  /** How many candidates to score. Defaults to `HANDOFF_SAMPLES`. */
  samples?: number;
  /** Width of the candidate window. Defaults to `HANDOFF_SPREAD_SECONDS`. */
  spreadSeconds?: number;
}

/**
 * The timestamps to score for a handoff, oldest first.
 *
 * Pure so the edge cases are testable without a decoder: a clip shorter than
 * the lead, a clip shorter than a single frame, a spread that would run past
 * the end. Every returned time is inside `[0, duration - one frame]`.
 */
export function frameSampleTimes(
  durationSeconds: number,
  {
    leadSeconds = HANDOFF_LEAD_SECONDS,
    samples = HANDOFF_SAMPLES,
    spreadSeconds = HANDOFF_SPREAD_SECONDS,
  }: HandoffOptions = {},
): number[] {
  const last = Math.max(0, durationSeconds - FRAME_SECONDS);
  if (!Number.isFinite(durationSeconds) || last <= 0) return [0];
  const target = Math.max(0, Math.min(last, durationSeconds - Math.max(0, leadSeconds)));
  const count = Math.max(1, Math.floor(samples));
  if (count === 1) return [target];
  const half = Math.max(0, spreadSeconds) / 2;
  const from = Math.max(0, target - half);
  const to = Math.min(last, target + half);
  if (to <= from) return [from];
  const step = (to - from) / (count - 1);
  const times: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const time = Number((from + step * index).toFixed(3));
    if (!times.includes(time)) times.push(time);
  }
  return times;
}

/**
 * Variance of the Laplacian over the buffer's luminance: the standard
 * "is this frame in focus" score. A flat or blurred frame answers near zero,
 * an edgy one answers high. Only meaningful compared against other frames of
 * the same clip (content changes the scale).
 */
export function laplacianVariance(image: ImageData): number {
  const { data, width, height } = image;
  if (width < 3 || height < 3) return 0;
  const luma = new Float32Array(width * height);
  for (let index = 0; index < luma.length; index += 1) {
    const offset = index * 4;
    luma[index] = 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
  }
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const response =
        luma[index - width] +
        luma[index + width] +
        luma[index - 1] +
        luma[index + 1] -
        4 * luma[index];
      sum += response;
      sumSquares += response * response;
      count += 1;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}

/** A `<video>` holding the clip, decoded far enough to seek and read back. */
export function loadVideoElement(src: string, { muted = true } = {}): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.muted = muted;
    video.playsInline = true;
    video.src = src;
    video.addEventListener("loadedmetadata", () => resolve(video), { once: true });
    video.addEventListener("error", () => reject(new Error("A clip failed to load.")), {
      once: true,
    });
  });
}

/** Seek and wait for the decoder to actually land on the frame. */
export function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - time) < 0.01) {
      resolve();
      return;
    }
    video.addEventListener("seeked", () => resolve(), { once: true });
    video.currentTime = time;
  });
}

function drawTo(video: HTMLVideoElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This system cannot read video frames.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Sharpness of the frame currently displayed, read back small. */
function scoreCurrentFrame(video: HTMLVideoElement): number {
  const width = Math.min(SHARPNESS_WIDTH, Math.max(3, video.videoWidth));
  const ratio = video.videoHeight / Math.max(1, video.videoWidth);
  const height = Math.max(3, Math.round(width * ratio));
  try {
    const canvas = drawTo(video, width, height);
    const context = canvas.getContext("2d");
    if (!context) return 0;
    return laplacianVariance(context.getImageData(0, 0, canvas.width, canvas.height));
  } catch {
    // A tainted canvas (or a decoder that refuses the readback) costs us the
    // ranking, not the extraction: every candidate scores 0 and the first wins.
    return 0;
  }
}

/** The frame currently displayed, encoded for its destination. */
async function encodeCurrentFrame(
  video: HTMLVideoElement,
  encoding: FrameEncoding,
): Promise<string> {
  const canvas = drawTo(video, video.videoWidth, video.videoHeight);
  if (encoding === "capture") return canvas.toDataURL("image/png");
  const raw = canvas.toDataURL("image/jpeg", 0.94);
  return downscaleDataUrl(raw, { maxEdge: FRAME_MAX_EDGE, maxBytes: FRAME_MAX_BYTES });
}

/** Grab one specific frame, for when the automatic pick is not the wanted one. */
export async function extractFrameAt(
  src: string,
  timeSeconds: number,
  { encoding = "payload" }: { encoding?: FrameEncoding } = {},
): Promise<ExtractedFrame> {
  const video = await loadVideoElement(src);
  try {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const time = Math.max(0, Math.min(timeSeconds, lastReadableTime(duration)));
    await seekVideo(video, time);
    return {
      dataUrl: await encodeCurrentFrame(video, encoding),
      timeSeconds: time,
      durationSeconds: duration,
      sharpness: scoreCurrentFrame(video),
      width: video.videoWidth,
      height: video.videoHeight,
    };
  } finally {
    video.src = "";
  }
}

/**
 * The frame to hand off to the next shot: the sharpest of a few candidates
 * taken shortly before the end.
 */
export async function extractHandoffFrame(
  src: string,
  options: HandoffOptions = {},
): Promise<ExtractedFrame> {
  const video = await loadVideoElement(src);
  try {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const times = frameSampleTimes(duration, options);
    let best: { time: number; sharpness: number } | undefined;
    for (const time of times) {
      await seekVideo(video, time);
      const sharpness = scoreCurrentFrame(video);
      if (!best || sharpness > best.sharpness) best = { time, sharpness };
    }
    const pick = best ?? { time: times[0] ?? 0, sharpness: 0 };
    await seekVideo(video, pick.time);
    return {
      dataUrl: await encodeCurrentFrame(video, "payload"),
      timeSeconds: pick.time,
      durationSeconds: duration,
      sharpness: pick.sharpness,
      width: video.videoWidth,
      height: video.videoHeight,
    };
  } finally {
    // Drop the decoder's buffers rather than waiting for the GC; a 15 MB clip
    // held per extraction adds up fast on a phone.
    video.src = "";
  }
}

/** How far back the handoff point can be dragged, in seconds. Past this the
 * next shot is not continuing the last one, it is restarting it. */
export const HANDOFF_ADJUST_WINDOW_SECONDS = 3;

/** `"16:9"` as a number, or undefined when it is not a ratio. */
export function parseAspectRatio(ratio: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/i.exec(ratio);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return undefined;
  return width / height;
}

/**
 * The offered ratio closest to the frame's own shape, so a handoff from a 9:16
 * clip does not silently render the next shot in 16:9 (the backend letterboxes
 * or crops it without a word). Ties keep the earlier option, which is the
 * catalog's own default order.
 */
export function closestAspectRatio(
  frameRatio: number,
  options: readonly string[],
): string | undefined {
  if (!Number.isFinite(frameRatio) || frameRatio <= 0) return undefined;
  let best: { option: string; distance: number } | undefined;
  for (const option of options) {
    const value = parseAspectRatio(option);
    if (value === undefined) continue;
    // Compare in log space: 16:9 vs 4:3 should read as the same kind of
    // mismatch as 9:16 vs 3:4, which a plain difference gets wrong.
    const distance = Math.abs(Math.log(value / frameRatio));
    if (!best || distance < best.distance) best = { option, distance };
  }
  return best?.option;
}

/** Prefix that tells the model to carry the previous shot on rather than
 * restage it. Kept out of the prompt body so a chain never stacks it twice. */
export const CONTINUATION_PREFIX = "Continue the shot, no cut: ";

/**
 * The next shot's starting prompt. The previous prompt is the best available
 * description of the scene, so it is kept verbatim under a continuity
 * instruction; chaining a chained prompt must not stack the instruction again.
 */
export function continuationPrompt(previousPrompt: string): string {
  const previous = previousPrompt.trim();
  if (!previous) return CONTINUATION_PREFIX.trim();
  const withoutPrefix = stripContinuationPrefix(previous);
  return `${CONTINUATION_PREFIX}${withoutPrefix}`;
}

/** The prompt without any continuity instruction previously added. */
export function stripContinuationPrefix(prompt: string): string {
  let out = prompt.trim();
  const needle = CONTINUATION_PREFIX.trim().toLowerCase();
  // A chain of chains can carry several, and the trailing colon may have been
  // typed over; strip whatever is there until the real prompt starts.
  while (out.toLowerCase().startsWith(needle)) {
    out = out.slice(needle.length).replace(/^[\s:,-]+/, "");
  }
  return out;
}
