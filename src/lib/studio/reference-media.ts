/**
 * Reference *clips* and reference *audio*: measuring them, and deciding whether
 * one more still fits.
 *
 * Shared for the same reason `video-request` is: every one of these limits is
 * reported by the provider only *after* a render has been queued and billed, so
 * each shell that checks them differently is a shell that spends differently.
 * The rules themselves come from the seedance guide and from the request-size
 * cap in `./seedance`.
 *
 * Nothing here previews media. That is deliberate: the iOS webview will not
 * load a `data:` URI into a `<video>` or `<audio>` element at all, so anything
 * that needs one goes through an object URL, and a preview would need a lifetime
 * to manage. Measuring does need an element, so that one place creates an object
 * URL and revokes it (see `dataUriSeconds`).
 */

import { MAX_REQUEST_BYTES, maxReferenceVideoSeconds, requestSizeProblem } from "./seedance";
import type { MediaModel } from "./types";

/** Longest a single reference clip may run (seedance 2.0 and 2.5 alike). */
export const MAX_CLIP_SECONDS = 15;
/** Shortest one worth sending: below this the model has nothing to work from. */
export const MIN_CLIP_SECONDS = 2;

/** Biggest file worth reading in at all. Base64 inflates bytes by about a
 * third, so anything past this cannot fit a request even on its own - and
 * reading it first would mean holding tens of megabytes of string in a webview
 * that is about to be told it was pointless. */
export const MAX_REFERENCE_FILE_BYTES = Math.floor((MAX_REQUEST_BYTES * 3) / 4);

/**
 * Why a file is too big to be worth encoding, checked from its byte count
 * before anything is read. `noun` names it the way the surface does ("clip",
 * "track"), because the number alone does not say what was refused.
 */
export function referenceFileTooBig(bytes: number, noun: string): string | undefined {
  if (bytes <= MAX_REFERENCE_FILE_BYTES) return undefined;
  return `That ${noun} is about ${Math.round(bytes / 1e6)} MB. A whole request carries around ${Math.round(
    MAX_REFERENCE_FILE_BYTES / 1e6,
  )} MB of media, so use a shorter or smaller one.`;
}

/** How long to wait for an element to report metadata before giving up. An
 * unmeasurable source must not hang the form; 0 means "could not tell". */
const MEASURE_TIMEOUT_MS = 4_000;

/** One picked reference clip or audio track, ready to travel inline. */
export interface ReferenceMedia {
  /** Gallery artifact id, or a synthetic one for a file picked off the device.
   * Doubles as the de-duplication key. */
  id: string;
  /** What to call it on screen. */
  label: string;
  /** The bytes, as the data URI the request body carries. */
  dataUri: string;
  /** Length in seconds, or 0 when it could not be measured. */
  seconds: number;
}

/**
 * A media element's duration, or 0 when it cannot be told.
 *
 * Bounded by a timeout because a source the webview refuses to decode fires
 * neither `loadedmetadata` nor `error` on every platform, and an input the user
 * is waiting on must not hang on that.
 */
export function mediaSeconds(src: string, kind: "video" | "audio"): Promise<number> {
  return new Promise((resolve) => {
    const element = document.createElement(kind);
    let settled = false;
    const finish = (seconds: number) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      // Detach the source so the element is collectable even if it never loaded.
      element.src = "";
      resolve(seconds);
    };
    const timer = window.setTimeout(() => finish(0), MEASURE_TIMEOUT_MS);
    element.preload = "metadata";
    element.addEventListener(
      "loadedmetadata",
      () => finish(Number.isFinite(element.duration) ? element.duration : 0),
      { once: true },
    );
    element.addEventListener("error", () => finish(0), { once: true });
    element.src = src;
  });
}

/**
 * The same, for media held as a data URI.
 *
 * The iOS webview will not load a `data:` URI into a media element, so the
 * bytes go through an object URL that is revoked either way. Desktop does not
 * need the detour but takes it anyway, so both shells measure identically.
 */
export async function dataUriSeconds(dataUri: string, kind: "video" | "audio"): Promise<number> {
  let objectUrl: string | undefined;
  try {
    const response = await fetch(dataUri);
    objectUrl = URL.createObjectURL(await response.blob());
    return await mediaSeconds(objectUrl, kind);
  } catch {
    return 0;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Why this clip cannot join the ones already picked, or undefined when it can.
 *
 * Three limits, all of them silent until the provider bills for the attempt:
 * a per-clip length, a combined length that is per-version, and the request-size
 * cap every inline input shares. A clip that could not be measured (`seconds`
 * of 0) is let through on length: refusing what we could not read would be a
 * guess, and the provider still has the last word.
 */
export function referenceClipProblem(
  model: Pick<MediaModel, "id"> | undefined,
  existing: readonly ReferenceMedia[],
  candidate: ReferenceMedia,
): string | undefined {
  if (existing.some((clip) => clip.id === candidate.id)) {
    return "That clip is already in the list.";
  }
  const { seconds } = candidate;
  if (seconds > 0 && (seconds < MIN_CLIP_SECONDS || seconds > MAX_CLIP_SECONDS)) {
    return `That clip is ${Math.round(seconds)}s. Reference clips run ${MIN_CLIP_SECONDS} to ${MAX_CLIP_SECONDS}s.`;
  }
  const next = [...existing, candidate];
  const combined = next.reduce((total, clip) => total + clip.seconds, 0);
  const combinedCap = maxReferenceVideoSeconds(model);
  if (combined > combinedCap) {
    return `Together these clips run ${Math.round(combined)}s, over the ${combinedCap}s a request allows.`;
  }
  return requestSizeProblem(next.map((clip) => clip.dataUri));
}

/**
 * Why this audio track cannot join the ones already picked.
 *
 * No length limit is published for reference audio, so only the shared
 * request-size cap applies - which is exactly the limit an audio file is most
 * likely to hit on its own.
 */
export function referenceAudioProblem(
  existing: readonly ReferenceMedia[],
  candidate: ReferenceMedia,
): string | undefined {
  if (existing.some((entry) => entry.id === candidate.id)) {
    return "That track is already in the list.";
  }
  return requestSizeProblem([...existing, candidate].map((entry) => entry.dataUri));
}
