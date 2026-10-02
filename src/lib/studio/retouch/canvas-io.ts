// The only part of the retouch engine that needs a canvas: cutting a crop out
// of a version, and drawing a zone's strokes into a mask. Everything decided
// about those pixels lives in `zone.ts`.

import { t } from "../../i18n";
import { downscaleDataUrl, prepareEditReference } from "../downscale";
import { featherFor, featherMask, type Rect, type ZoneStroke } from "./zone";

/** The mask is drawn at most this large; Rust resamples it to the crop. */
const MASK_MAX_EDGE = 1024;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(t("The image could not be decoded.")));
    image.src = src;
  });
}

export async function naturalSize(src: string): Promise<{ width: number; height: number }> {
  const image = await loadImage(src);
  return { width: image.naturalWidth, height: image.naturalHeight };
}

function canvas(
  width: number,
  height: number,
): {
  element: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
} {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  const context = element.getContext("2d");
  if (!context) throw new Error(t("The image could not be prepared."));
  return { element, context };
}

/** A version, ready to send: under the operator's 5 MB per image. */
export function prepareSource(dataUrl: string): Promise<string> {
  return prepareEditReference(dataUrl);
}

/** A version bound for the upscaler: its full size kept, its weight under
 * the operator's 5 MB per image. */
export function prepareForUpscale(
  dataUrl: string,
  size: { width: number; height: number },
): Promise<string> {
  return downscaleDataUrl(dataUrl, {
    maxEdge: Math.max(size.width, size.height),
    maxBytes: 4_500_000,
    quality: 0.95,
  });
}

/** Cut `crop` out of an image at full resolution, then size it for sending. */
export async function cropForSending(src: string, crop: Rect): Promise<string> {
  const image = await loadImage(src);
  const { element, context } = canvas(crop.width, crop.height);
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return prepareEditReference(element.toDataURL("image/png"));
}

/**
 * Draw strokes (already in the crop's coordinates) into a feathered grayscale
 * mask, white where the result shows. Returned as raw PNG base64, the shape
 * the native merge reads.
 */
export function rasterizeZone(
  strokes: ZoneStroke[],
  crop: { width: number; height: number },
): string {
  const scale = Math.min(1, MASK_MAX_EDGE / Math.max(crop.width, crop.height));
  const width = Math.max(1, Math.round(crop.width * scale));
  const height = Math.max(1, Math.round(crop.height * scale));
  const { element, context } = canvas(width, height);
  context.scale(scale, scale);
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const stroke of strokes) {
    context.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
    context.fillStyle = "#fff";
    context.strokeStyle = "#fff";
    if (stroke.kind === "lasso") {
      if (stroke.points.length < 3) continue;
      context.beginPath();
      context.moveTo(...stroke.points[0]);
      for (const point of stroke.points.slice(1)) context.lineTo(...point);
      context.closePath();
      context.fill();
      continue;
    }
    if (stroke.points.length === 0) continue;
    context.lineWidth = stroke.radius * 2;
    context.beginPath();
    context.moveTo(...stroke.points[0]);
    for (const point of stroke.points.slice(1)) context.lineTo(...point);
    // A single tap is a dot: a path of one point draws nothing.
    if (stroke.points.length === 1) context.lineTo(stroke.points[0][0] + 0.01, stroke.points[0][1]);
    context.stroke();
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  const pixels = context.getImageData(0, 0, width, height);
  const alpha = new Uint8ClampedArray(width * height);
  for (let index = 0; index < alpha.length; index += 1) alpha[index] = pixels.data[index * 4 + 3];
  const feathered = featherMask(
    alpha,
    width,
    height,
    Math.max(2, Math.round(featherFor(crop) * scale)),
  );
  for (let index = 0; index < feathered.length; index += 1) {
    const value = feathered[index];
    pixels.data[index * 4] = value;
    pixels.data[index * 4 + 1] = value;
    pixels.data[index * 4 + 2] = value;
    pixels.data[index * 4 + 3] = 255;
  }
  context.globalCompositeOperation = "copy";
  context.putImageData(pixels, 0, 0);
  return element.toDataURL("image/png").replace(/^data:[^,]*,/, "");
}
