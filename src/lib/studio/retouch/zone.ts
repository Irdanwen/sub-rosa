// A zone limits a retouch to what the person drew. Only the rectangle around
// it is sent, at a ratio the model accepts, and the result is merged back
// through a feathered mask (natively, see `carpe_diem/zone.rs`). Everything
// here is geometry and pixel arithmetic on plain arrays, so it is testable
// without a canvas; drawing the strokes is `canvas-io.ts`'s job.

export type Point = [number, number];

/** One brush stroke, in the image's pixels. */
export interface BrushStroke {
  kind: "brush";
  points: Point[];
  radius: number;
  /** An eraser stroke removes from the zone instead of adding to it. */
  erase?: boolean;
}

/** One lasso, a closed polygon in the image's pixels. */
export interface LassoStroke {
  kind: "lasso";
  points: Point[];
  erase?: boolean;
}

export type ZoneStroke = BrushStroke | LassoStroke;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Whether anything is left to retouch: at least one additive stroke with
 * some extent. */
export function hasZone(strokes: ZoneStroke[]): boolean {
  return strokes.some((stroke) => !stroke.erase && strokeBounds(stroke) !== undefined);
}

function strokeBounds(stroke: ZoneStroke): Rect | undefined {
  if (stroke.points.length === 0) return undefined;
  if (stroke.kind === "lasso" && stroke.points.length < 3) return undefined;
  const pad = stroke.kind === "brush" ? stroke.radius : 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of stroke.points) {
    minX = Math.min(minX, x - pad);
    minY = Math.min(minY, y - pad);
    maxX = Math.max(maxX, x + pad);
    maxY = Math.max(maxY, y + pad);
  }
  if (maxX - minX < 1 || maxY - minY < 1) return undefined;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The box around every additive stroke, clipped to the image. */
export function zoneBounds(
  strokes: ZoneStroke[],
  image: { width: number; height: number },
): Rect | undefined {
  let union: Rect | undefined;
  for (const stroke of strokes) {
    if (stroke.erase) continue;
    const box = strokeBounds(stroke);
    if (!box) continue;
    union = union
      ? (() => {
          const x = Math.min(union.x, box.x);
          const y = Math.min(union.y, box.y);
          return {
            x,
            y,
            width: Math.max(union.x + union.width, box.x + box.width) - x,
            height: Math.max(union.y + union.height, box.y + box.height) - y,
          };
        })()
      : box;
  }
  if (!union) return undefined;
  const x = Math.max(0, Math.floor(union.x));
  const y = Math.max(0, Math.floor(union.y));
  const right = Math.min(image.width, Math.ceil(union.x + union.width));
  const bottom = Math.min(image.height, Math.ceil(union.y + union.height));
  if (right - x < 1 || bottom - y < 1) return undefined;
  return { x, y, width: right - x, height: bottom - y };
}

/** "16:9" to 16/9; undefined for anything else. */
export function ratioValue(ratio: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio.trim());
  if (!match) return undefined;
  const value = Number(match[1]) / Number(match[2]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export interface ZoneCrop extends Rect {
  /** The ratio the crop was shaped to, to send as `aspect_ratio`. */
  ratio: string;
}

export interface CropOptions {
  /** Ratios the model accepts ("3:2"...). */
  ratios: string[];
  /** Context kept around the zone, as a share of its larger side. */
  margin?: number;
  /** Smallest side sent, in pixels, so the model sees enough around the zone. */
  minSide?: number;
}

/**
 * The rectangle to send for a zone: the zone plus some context, grown to the
 * accepted ratio that costs the least extra area, and kept inside the image.
 * When the image is too small for the ideal shape, the crop is the largest
 * rectangle of that ratio the image holds around the zone.
 */
export function zoneCrop(
  zone: Rect,
  image: { width: number; height: number },
  { ratios, margin = 0.25, minSide = 384 }: CropOptions,
): ZoneCrop | undefined {
  const candidates = ratios
    .map((ratio) => ({ ratio, value: ratioValue(ratio) }))
    .filter((entry): entry is { ratio: string; value: number } => entry.value !== undefined);
  if (candidates.length === 0) return undefined;
  const pad = Math.max(zone.width, zone.height) * margin;
  const wantW = Math.max(zone.width + 2 * pad, minSide);
  const wantH = Math.max(zone.height + 2 * pad, minSide);
  let best: ZoneCrop | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const { ratio, value } of candidates) {
    // Grow one side so the box takes this ratio, then fit it in the image.
    let width = Math.max(wantW, wantH * value);
    let height = width / value;
    const fit = Math.min(1, image.width / width, image.height / height);
    width = Math.floor(width * fit);
    height = Math.floor(height * fit);
    if (width < 1 || height < 1) continue;
    const centerX = zone.x + zone.width / 2;
    const centerY = zone.y + zone.height / 2;
    const x = clamp(Math.round(centerX - width / 2), 0, image.width - width);
    const y = clamp(Math.round(centerY - height / 2), 0, image.height - height);
    // Losing part of the zone is worse than any amount of extra context.
    const covered =
      zone.x >= x &&
      zone.y >= y &&
      zone.x + zone.width <= x + width &&
      zone.y + zone.height <= y + height;
    const score = (covered ? 0 : 1e12) + width * height;
    if (score < bestScore) {
      bestScore = score;
      best = { x, y, width, height, ratio };
    }
  }
  return best;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Feather width for a crop: wide enough to hide the seam, narrow enough to
 * keep the edit where it was drawn. */
export function featherFor(crop: { width: number; height: number }): number {
  return Math.max(4, Math.round(Math.min(crop.width, crop.height) * 0.025));
}

/**
 * Soften a hard mask so the merge has no seam: grow it by `radius` first, so
 * what was drawn stays fully replaced, then blur across the new edge. `alpha`
 * is one byte per pixel, 255 inside the zone.
 */
export function featherMask(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  if (radius <= 0) return alpha.slice();
  const grown = dilate(alpha, width, height, radius);
  // Two box passes approximate a gaussian closely enough for an edge.
  const half = Math.max(1, Math.round(radius / 2));
  return boxBlur(boxBlur(grown, width, height, half), width, height, half);
}

function dilate(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  // Separable max filter: rows, then columns.
  const rows = new Uint8ClampedArray(alpha.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let max = 0;
      for (let dx = Math.max(0, x - radius); dx <= Math.min(width - 1, x + radius); dx += 1) {
        const value = alpha[y * width + dx];
        if (value > max) max = value;
        if (max === 255) break;
      }
      rows[y * width + x] = max;
    }
  }
  const out = new Uint8ClampedArray(alpha.length);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      let max = 0;
      for (let dy = Math.max(0, y - radius); dy <= Math.min(height - 1, y + radius); dy += 1) {
        const value = rows[dy * width + x];
        if (value > max) max = value;
        if (max === 255) break;
      }
      out[y * width + x] = max;
    }
  }
  return out;
}

function boxBlur(
  alpha: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  const rows = new Float32Array(alpha.length);
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    let count = 0;
    for (let x = -radius; x < width + radius; x += 1) {
      const add = x + radius;
      if (add >= 0 && add < width) {
        sum += alpha[y * width + add];
        count += 1;
      }
      const drop = x - radius - 1;
      if (drop >= 0 && drop < width) {
        sum -= alpha[y * width + drop];
        count -= 1;
      }
      if (x >= 0 && x < width) rows[y * width + x] = sum / count;
    }
  }
  const out = new Uint8ClampedArray(alpha.length);
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    let count = 0;
    for (let y = -radius; y < height + radius; y += 1) {
      const add = y + radius;
      if (add >= 0 && add < height) {
        sum += rows[add * width + x];
        count += 1;
      }
      const drop = y - radius - 1;
      if (drop >= 0 && drop < height) {
        sum -= rows[drop * width + x];
        count -= 1;
      }
      if (y >= 0 && y < height) out[y * width + x] = Math.round(sum / count);
    }
  }
  return out;
}

/** Strokes moved into a crop's coordinates. */
export function strokesInCrop(strokes: ZoneStroke[], crop: Rect): ZoneStroke[] {
  return strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map(([x, y]) => [x - crop.x, y - crop.y] as Point),
  }));
}
