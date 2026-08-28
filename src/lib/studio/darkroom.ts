/**
 * The darkroom: what a generation looks like while it is being made.
 *
 * A render takes minutes, and the wait used to be one line of text next to a
 * spinner - the same wait whether one clip or four were in flight, with no
 * sign of where the result would land or how far along it was. The darkroom
 * is the placeholder that stands in for the result: a frame at the render's
 * real aspect ratio, in the exact spot the clip will occupy, holding a slow
 * field of light and film grain.
 *
 * It is deliberately abstract. Nothing in it is derived from the render, and
 * nothing is a preview of it: showing the opening frame here would promise a
 * picture we do not have, and the moment the real clip arrived the promise
 * would be visibly broken. What the darkroom does promise is honest - the
 * shape of the result, that work is happening, and roughly how much is left.
 *
 * The light is seeded from the request, so two renders queued side by side
 * read as two different renders rather than two copies of one animation, and
 * the same request always looks the same. Hue is all the seed decides:
 * lightness and chroma belong to the theme, and every light mixes back into
 * `--brand`, so the darkroom tracks the accent the user picked instead of
 * dropping a foreign palette into the app.
 */

/** The three lights and the drift of one darkroom, all derived from a string. */
export interface DarkroomSeed {
  /** Hue angles in degrees for the three drifting lights. */
  hueA: number;
  hueB: number;
  hueC: number;
  /** How long one drift takes, in ms. Long on purpose: this is a wait, not an
   * animation to watch. */
  driftMs: number;
  /** Rotation of the whole field, in degrees, so the lights do not all sweep
   * along the same axis. */
  tiltDeg: number;
  /** Scale multiplier for the lights - some darkrooms bloom wider than others. */
  bloom: number;
}

/** FNV-1a. Small, dependency-free, and stable across runs - the darkroom for a
 * given request must not change between two paints of the same wait. */
function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Derive a darkroom from anything stable about the request - the prompt, the
 * model, the job id. Feed it the same string and you get the same light.
 */
export function darkroomSeed(input: string): DarkroomSeed {
  const hash = hashString(input || "darkroom");
  const hueA = hash % 360;
  // The other two lights sit within a comfortable spread of the first: three
  // unrelated hues read as a bug, three neighbours read as one lit space.
  const hueB = (hueA + 34 + ((hash >>> 9) % 56)) % 360;
  const hueC = (hueA + 360 - 26 - ((hash >>> 17) % 48)) % 360;
  return {
    hueA,
    hueB,
    hueC,
    driftMs: 17_000 + ((hash >>> 5) % 11_000),
    tiltDeg: ((hash >>> 13) % 41) - 20,
    bloom: 0.86 + ((hash >>> 21) % 34) / 100,
  };
}

/** The custom properties a darkroom frame reads. Everything else - lightness,
 * chroma, the mix back into the brand accent - stays in the stylesheet. */
export function darkroomVars(seed: DarkroomSeed): Record<string, string> {
  return {
    "--darkroom-hue-a": `${seed.hueA}`,
    "--darkroom-hue-b": `${seed.hueB}`,
    "--darkroom-hue-c": `${seed.hueC}`,
    "--darkroom-drift": `${seed.driftMs}ms`,
    "--darkroom-tilt": `${seed.tiltDeg}deg`,
    "--darkroom-bloom": `${seed.bloom}`,
  };
}

/**
 * A CSS `aspect-ratio` for the frame, from however the request spelled it
 * ("16:9", "16/9", 1.777, or nothing at all). The frame holds the shape of
 * the result, so an unparseable ratio falls back to the widescreen default
 * rather than collapsing the box.
 */
export function darkroomAspect(ratio: string | number | undefined): string {
  if (typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0) {
    return `${ratio}`;
  }
  if (typeof ratio === "string") {
    const parts = ratio.trim().split(/[:/]/);
    if (parts.length === 2) {
      const width = Number(parts[0]);
      const height = Number(parts[1]);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        return `${width} / ${height}`;
      }
    }
    const single = Number(ratio);
    if (Number.isFinite(single) && single > 0) return `${single}`;
  }
  return "16 / 9";
}

/**
 * The same shape as a number (width / height), which is what a max-width has
 * to be multiplied by to cap a frame's height without breaking its ratio.
 * `aspect-ratio` with a `max-height` does not survive the flow: the box keeps
 * its width and is simply squashed.
 */
export function darkroomRatio(ratio: string | number | undefined): number {
  const aspect = darkroomAspect(ratio);
  const [width, height] = aspect.split("/").map((part) => Number(part.trim()));
  if (Number.isFinite(width) && Number.isFinite(height) && height > 0) return width / height;
  return Number.isFinite(width) && width > 0 ? width : 16 / 9;
}

/**
 * The bar heights of an audio darkroom, seeded the same way the light is.
 * A sound has no aspect ratio to hold, so its darkroom holds a shape instead:
 * a resting waveform that breathes. It is not the track being made - there is
 * nothing to sample until the file lands - it is this request's own silhouette,
 * stable for as long as the wait lasts.
 */
export function darkroomWave(input: string, count = 28): number[] {
  let state = hashString(input || "darkroom") || 1;
  const bars: number[] = [];
  for (let index = 0; index < count; index += 1) {
    // xorshift32: enough spread for a silhouette, no dependency, deterministic.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const unit = ((state >>> 0) % 1000) / 1000;
    // Taper the ends so the wave sits in the frame rather than being cropped
    // by it, and keep every bar visible - a zero-height bar reads as a gap.
    const taper = Math.sin((Math.PI * (index + 0.5)) / count);
    bars.push(Number((0.18 + unit * 0.82 * (0.45 + 0.55 * taper)).toFixed(3)));
  }
  return bars;
}
