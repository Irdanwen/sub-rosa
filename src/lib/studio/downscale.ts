/**
 * Canvas re-encode helpers for the mobile Studio.
 *
 * Two size problems on iOS both come down to sending / rendering full
 * resolution photos:
 *  - iPhone camera images are routinely larger than the backend's 5 MB edit
 *    cap, so `/image/edit` rejects them ("Image too large (max 5MB)"). We
 *    shrink a reference photo before it is sent.
 *  - the iOS webview downsamples large decoded base64 images under memory
 *    pressure, so full-resolution gallery tiles render blurry. We render a
 *    small thumbnail in the grid and keep the full image only for the lightbox.
 */

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The image could not be decoded."));
    img.src = dataUrl;
  });
}

/** Decoded byte count behind a `data:...;base64,...` URL (base64 is ~4/3 the
 * size of the bytes it encodes). */
function approxBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor((b64.length * 3) / 4);
}

export interface DownscaleOptions {
  /** Cap on the longest side, in pixels. */
  maxEdge: number;
  /** If set, keep dropping JPEG quality until the result is under this many
   * decoded bytes. */
  maxBytes?: number;
  /** Initial JPEG quality (0..1). */
  quality?: number;
}

/**
 * Re-encode a data URL so its longest side is at most `maxEdge` and (when
 * `maxBytes` is set) its payload is under that ceiling. Returns the original
 * URL untouched when it is already small enough, and falls back to the original
 * if the image cannot be decoded (the caller then surfaces any backend error).
 */
export async function downscaleDataUrl(
  dataUrl: string,
  { maxEdge, maxBytes, quality = 0.85 }: DownscaleOptions,
): Promise<string> {
  let img: HTMLImageElement;
  try {
    img = await loadImage(dataUrl);
  } catch {
    return dataUrl;
  }
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = longest > maxEdge ? maxEdge / longest : 1;

  // Already within both bounds: nothing to re-encode.
  if (scale === 1 && (!maxBytes || approxBytes(dataUrl) <= maxBytes)) return dataUrl;

  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, width, height);

  let q = quality;
  let out = canvas.toDataURL("image/jpeg", q);
  while (maxBytes && approxBytes(out) > maxBytes && q > 0.4) {
    q -= 0.15;
    out = canvas.toDataURL("image/jpeg", q);
  }
  return out;
}

/** A reference photo bound for `/image/edit`: capped well under the 5 MB
 * server limit while staying detailed enough to edit. */
export function prepareEditReference(dataUrl: string): Promise<string> {
  return downscaleDataUrl(dataUrl, { maxEdge: 2048, maxBytes: 4_500_000 });
}

/** A gallery grid thumbnail: small enough that the iOS webview never
 * downsamples it (which is what makes the full-res tiles look blurry). */
export function makeThumbnail(dataUrl: string): Promise<string> {
  return downscaleDataUrl(dataUrl, { maxEdge: 512, maxBytes: 400_000, quality: 0.8 });
}
