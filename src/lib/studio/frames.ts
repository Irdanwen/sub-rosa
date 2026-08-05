/**
 * Frame extraction for shot continuity: pull a still out of a generated clip
 * so the next shot can start where the last one ended.
 *
 * Four things make this more than "seek to the end and grab a pixel buffer":
 *
 *  - Seeking to `duration` exactly lands past the last decoded frame on most
 *    decoders: the canvas comes back black, and some never fire `seeked` at
 *    all. Every sample is taken at least one frame short of the end.
 *  - `seeked` does not promise a decoded picture. Drawing an element that is
 *    still below `HAVE_CURRENT_DATA` is a silent no-op per spec, so the frame
 *    that gets encoded is the one that was checked (see `captureAt`), and a
 *    read that proves empty fails loudly rather than saving a blank file.
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

/**
 * The `readyState` from which `drawImage` actually paints.
 *
 * Below it the draw is a no-op *per spec* - not an error, not an exception:
 * the canvas keeps its transparent pixels, `toDataURL` happily encodes them,
 * and what lands in the gallery is a correctly sized, completely blank PNG.
 * Nothing anywhere reports a failure, which is why this has to be checked.
 */
const HAVE_CURRENT_DATA = 2;

/** How long a seek, and the decode behind it, is given before the read moves
 * on and lets the blank check have the last word. Generous: the clip may be
 * tens of megabytes and the seek lands far from what is buffered. */
const SEEK_TIMEOUT_MS = 5_000;

/** Poll interval while waiting for the decoder. WebKit can reach
 * `HAVE_CURRENT_DATA` after a premature `seeked` without firing anything
 * else, so the wait cannot be purely event-driven. */
const DECODE_POLL_MS = 25;

/** How long a clip is given to hand over its metadata. Past this the read
 * fails with a message rather than leaving a dialog spinning on a promise
 * that will never settle - the same reason every wait below is bounded. */
const LOAD_TIMEOUT_MS = 15_000;

/** Positions tried before a clip is declared unreadable at that point. Each
 * retry moves one frame away: when a seek lands between two decodable frames,
 * nudging is what actually unsticks it. */
const FRAME_SETTLE_ATTEMPTS = 3;

/** Seeks nearer than this are treated as already there. */
const SEEK_EPSILON = 0.01;

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
    const settle = (outcome: () => void) => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
      window.clearTimeout(timer);
      outcome();
    };
    const onLoaded = () => settle(() => resolve(video));
    const onError = () => settle(() => reject(new Error("A clip failed to load.")));
    // A source that answers neither `loadedmetadata` nor `error` is not a
    // hypothetical: that is what a stalled asset request looks like from here.
    const timer = window.setTimeout(onError, LOAD_TIMEOUT_MS);
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("error", onError);
    video.src = src;
  });
}

/** `requestVideoFrameCallback` is the one first-hand answer to "is there a
 * picture to draw": it fires when a frame has actually been presented. Safari
 * and WKWebView have it, the DOM lib types it as always present - and it is
 * still absent from plenty of runtimes this code is asked to survive. */
type FrameCallbacks = Partial<
  Pick<HTMLVideoElement, "requestVideoFrameCallback" | "cancelVideoFrameCallback">
>;

/**
 * Resolves once the element holds a decoded picture, or once the wait runs
 * out - never rejects, because the caller verifies the readback anyway and a
 * decoder that is merely slow should not cost us the frame.
 *
 * Three signals, because none of them is sufficient alone. The frame callback
 * is the authoritative one but never fires when the frame on screen is already
 * the wanted one; the media events do not always repeat after a premature
 * `seeked`; `readyState` is a proxy that can be reached without an event. So:
 * whichever answers first.
 */
function decodedFrame(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HAVE_CURRENT_DATA) return Promise.resolve();
  return new Promise((resolve) => {
    const frames: FrameCallbacks = video;
    const finish = () => {
      video.removeEventListener("loadeddata", check);
      video.removeEventListener("canplay", check);
      if (handle !== undefined) frames.cancelVideoFrameCallback?.(handle);
      window.clearInterval(poll);
      window.clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (video.readyState >= HAVE_CURRENT_DATA) finish();
    };
    const poll = window.setInterval(check, DECODE_POLL_MS);
    const timer = window.setTimeout(finish, SEEK_TIMEOUT_MS);
    video.addEventListener("loadeddata", check);
    video.addEventListener("canplay", check);
    const handle = frames.requestVideoFrameCallback?.(finish);
  });
}

/**
 * Seek and wait for the decoder to actually land on the frame.
 *
 * Two waits, not one. `seeked` says the playback position moved; it does not
 * say a picture exists there, and WebKit fires it early on a fresh element
 * seeking into a large clip. Waiting for `HAVE_CURRENT_DATA` after it is what
 * makes the following `drawImage` paint something. Both waits are bounded: a
 * `seeked` that never comes used to hang the read forever, which showed up as
 * a capture dialog spinning on "Reading the frame" with no way out.
 */
export async function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) >= SEEK_EPSILON) {
    await new Promise<void>((resolve) => {
      const finish = () => {
        video.removeEventListener("seeked", finish);
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(finish, SEEK_TIMEOUT_MS);
      video.addEventListener("seeked", finish);
      video.currentTime = time;
    });
  }
  await decodedFrame(video);
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

/** The analysis buffer's shape for a given clip. */
function sampleSize(width: number, height: number): { width: number; height: number } {
  const sampleWidth = Math.min(SHARPNESS_WIDTH, Math.max(3, width));
  const ratio = height / Math.max(1, width);
  return { width: sampleWidth, height: Math.max(3, Math.round(sampleWidth * ratio)) };
}

/**
 * A small readback of pixels already drawn - `undefined` when the readback is
 * refused (a tainted canvas, a decoder that will not hand pixels over). That
 * costs us the ranking and the blank check, not the extraction: "cannot tell"
 * is treated as "fine" everywhere below.
 */
function sampleOf(source: CanvasImageSource, width: number, height: number): ImageData | undefined {
  const size = sampleSize(width, height);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return undefined;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return undefined;
  }
}

/**
 * True when nothing was painted at all: every pixel fully transparent.
 *
 * This is the signature of a draw that no-opped, not of any frame a clip can
 * hold - the generated formats carry no alpha channel, so a decoded picture is
 * opaque everywhere. A black frame is not blank; it has alpha 255, and a fade
 * to black is a frame the user may well want.
 */
function isBlank(image: ImageData): boolean {
  const { data } = image;
  for (let alpha = 3; alpha < data.length; alpha += 4) {
    if (data[alpha] !== 0) return false;
  }
  return true;
}

/** A drawn frame, with what could be told about it from its own pixels. */
interface Capture {
  canvas: HTMLCanvasElement;
  /** Nothing was painted: this canvas must not become a file. */
  blank: boolean;
  sharpness: number;
}

/**
 * Draw the current frame at the clip's own resolution and judge *that* canvas.
 *
 * One draw, one verdict, one thing encoded. Checking a separate small draw and
 * then encoding a full-size one would leave the encoded canvas unexamined -
 * which is the exact shape of the bug this file now guards against, just moved
 * one step along.
 */
function captureFrame(video: HTMLVideoElement): Capture {
  const canvas = drawTo(video, video.videoWidth, video.videoHeight);
  const sample = sampleOf(canvas, canvas.width, canvas.height);
  return {
    canvas,
    blank: sample ? isBlank(sample) : false,
    sharpness: sample ? laplacianVariance(sample) : 0,
  };
}

/** A candidate's sharpness, read straight off the video: the ranking pass runs
 * once per sample and has no use for a full-size draw. `undefined` means the
 * position decoded nothing, which is not the same as a flat frame. */
function scoreCandidate(video: HTMLVideoElement): number | undefined {
  const sample = sampleOf(video, video.videoWidth, video.videoHeight);
  if (!sample) return 0;
  return isBlank(sample) ? undefined : laplacianVariance(sample);
}

/**
 * Where attempt `n` looks. A frame forward normally; a frame *back* when the
 * ask already sits at the end stop - which is both where a decoder is most
 * likely to hand back nothing and where forward has nowhere left to go. Retry
 * positions that cannot move are retries in name only.
 */
function retryPosition(time: number, attempt: number, last: number): number {
  const step = attempt * FRAME_SECONDS;
  const forward = time + step;
  return forward <= last ? Math.max(0, forward) : Math.max(0, time - step);
}

/** A beat for the decoder to catch up before the position is written off. */
function decodeBeat(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, DECODE_POLL_MS));
}

/**
 * Land on a position that actually decodes, and prove it before anything is
 * encoded. Answers the drawn canvas and where it came from, which is not
 * always where it was asked from.
 *
 * The proof is the point. Without it a draw that no-opped is indistinguishable
 * from a successful one all the way to disk, and what the user gets is a
 * gallery tile that is simply not there - a full-size, fully transparent PNG,
 * saved without a single error along the way.
 */
async function captureAt(
  video: HTMLVideoElement,
  time: number,
): Promise<{ capture: Capture; timeSeconds: number }> {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const last = lastReadableTime(duration);
  for (let attempt = 0; attempt < FRAME_SETTLE_ATTEMPTS; attempt += 1) {
    await seekVideo(video, retryPosition(time, attempt, last));
    const capture = captureFrame(video);
    if (!capture.blank) return { capture, timeSeconds: video.currentTime };
    await decodeBeat();
  }
  throw new Error("That clip decoded no picture at that position.");
}

/** A drawn frame, encoded for its destination. */
async function encodeCapture(capture: Capture, encoding: FrameEncoding): Promise<string> {
  if (encoding === "capture") return capture.canvas.toDataURL("image/png");
  const raw = capture.canvas.toDataURL("image/jpeg", 0.94);
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
    // Report where the decoder actually landed, not what was asked for: a
    // still's recorded provenance should match the picture it holds.
    const { capture, timeSeconds: at } = await captureAt(video, time);
    return {
      dataUrl: await encodeCapture(capture, encoding),
      timeSeconds: at,
      durationSeconds: duration,
      sharpness: capture.sharpness,
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
      // A candidate that decoded nothing is not a flat frame, it is no frame.
      // Scoring it as 0 would let it win a clip whose real frames are flatter.
      const sharpness = scoreCandidate(video);
      if (sharpness === undefined) continue;
      if (!best || sharpness > best.sharpness) best = { time, sharpness };
    }
    const pick = best ?? { time: times[0] ?? 0 };
    const { capture, timeSeconds: at } = await captureAt(video, pick.time);
    return {
      dataUrl: await encodeCapture(capture, "payload"),
      timeSeconds: at,
      // The score of the frame actually encoded: the retry may have landed a
      // frame away from the candidate that won the ranking.
      sharpness: capture.sharpness,
      durationSeconds: duration,
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
