import { describe, expect, it } from "vitest";
import {
  closestAspectRatio,
  continuationPrompt,
  frameSampleTimes,
  HANDOFF_LEAD_SECONDS,
  laplacianVariance,
  lastReadableTime,
  parseAspectRatio,
  stripContinuationPrefix,
} from "../lib/studio/frames";

/** An ImageData-shaped buffer painted by a per-pixel function. */
function buffer(width: number, height: number, shade: (x: number, y: number) => number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = shade(x, y);
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

describe("handoff sample times", () => {
  it("brackets the lead point and stops short of the end", () => {
    const times = frameSampleTimes(10);
    expect(times.length).toBeGreaterThan(1);
    // Never the very last frame: seeking to `duration` reads back black.
    expect(Math.max(...times)).toBeLessThan(10);
    // Candidates on both sides of the lead point, so a blurred one there can
    // lose to a sharper neighbour. The window is clipped by the end of the
    // clip, so it is not symmetric around the lead - only straddling it.
    expect(Math.min(...times)).toBeLessThan(10 - HANDOFF_LEAD_SECONDS);
    expect(Math.max(...times)).toBeGreaterThan(10 - HANDOFF_LEAD_SECONDS);
  });

  it("samples the tail, not the middle of the clip", () => {
    const times = frameSampleTimes(10);
    // Everything within the last second: this is a handoff, not a thumbnail.
    expect(Math.min(...times)).toBeGreaterThan(9);
  });

  it("stays inside a clip shorter than the lead", () => {
    const times = frameSampleTimes(0.3);
    expect(times.length).toBeGreaterThan(0);
    for (const time of times) {
      expect(time).toBeGreaterThanOrEqual(0);
      expect(time).toBeLessThan(0.3);
    }
  });

  it("degrades to a single sample for a degenerate duration", () => {
    expect(frameSampleTimes(0)).toEqual([0]);
    expect(frameSampleTimes(Number.NaN)).toEqual([0]);
    expect(frameSampleTimes(10, { samples: 1 })).toEqual([10 - HANDOFF_LEAD_SECONDS]);
  });

  it("never returns the same timestamp twice", () => {
    const times = frameSampleTimes(10, { samples: 40, spreadSeconds: 0.05 });
    expect(new Set(times).size).toBe(times.length);
  });
});

describe("last readable position", () => {
  it("stops short of the end rather than landing on it", () => {
    // Seeking to `duration` itself decodes past the final frame: a capture UI
    // that let the slider reach it would read back black.
    expect(lastReadableTime(5)).toBeLessThan(5);
    expect(lastReadableTime(5)).toBeGreaterThan(4.9);
  });

  it("never answers a negative position for a degenerate duration", () => {
    expect(lastReadableTime(0)).toBe(0);
    expect(lastReadableTime(0.01)).toBe(0);
  });
});

describe("sharpness scoring", () => {
  it("scores a flat frame at zero and an edgy one above it", () => {
    const flat = laplacianVariance(buffer(32, 32, () => 128));
    const checker = laplacianVariance(buffer(32, 32, (x, y) => ((x + y) % 2 === 0 ? 0 : 255)));
    expect(flat).toBeCloseTo(0, 5);
    expect(checker).toBeGreaterThan(flat);
  });

  it("ranks a sharp edge above the same edge blurred", () => {
    const sharp = laplacianVariance(buffer(32, 32, (x) => (x < 16 ? 0 : 255)));
    // A ramp is the blurred version of that step: same contrast, spread out.
    const blurred = laplacianVariance(buffer(32, 32, (x) => Math.round((x / 31) * 255)));
    expect(sharp).toBeGreaterThan(blurred);
  });

  it("answers zero rather than NaN on a buffer too small to filter", () => {
    expect(laplacianVariance(buffer(2, 2, () => 200))).toBe(0);
  });
});

describe("aspect ratio matching", () => {
  const OPTIONS = ["16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16"];

  it("keeps a landscape handoff landscape and a portrait one portrait", () => {
    expect(closestAspectRatio(1920 / 1080, OPTIONS)).toBe("16:9");
    expect(closestAspectRatio(1080 / 1920, OPTIONS)).toBe("9:16");
    expect(closestAspectRatio(1024 / 1024, OPTIONS)).toBe("1:1");
  });

  it("picks the nearest offered ratio for a shape that is not offered", () => {
    // 1.85:1 cinema is between 16:9 (1.78) and nothing wider, so 16:9 wins.
    expect(closestAspectRatio(1.85, OPTIONS)).toBe("16:9");
    // A 5:4 frame (1.25) sits between 4:3 (1.33) and 1:1; 4:3 is nearer.
    expect(closestAspectRatio(1.25, OPTIONS)).toBe("4:3");
  });

  it("treats a portrait mismatch as harshly as its landscape mirror", () => {
    // Log-space distance: 16:9 vs 4:3 and 9:16 vs 3:4 must rank alike, so a
    // portrait clip never falls back to a landscape ratio.
    expect(closestAspectRatio(0.75, ["16:9", "3:4"])).toBe("3:4");
  });

  it("answers nothing rather than guessing", () => {
    expect(closestAspectRatio(1.78, [])).toBeUndefined();
    expect(closestAspectRatio(Number.NaN, OPTIONS)).toBeUndefined();
    expect(closestAspectRatio(1.78, ["auto", "square"])).toBeUndefined();
    expect(parseAspectRatio("16:0")).toBeUndefined();
    expect(parseAspectRatio("wide")).toBeUndefined();
  });
});

describe("continuation prompt", () => {
  it("keeps the previous prompt under a continuity instruction", () => {
    const next = continuationPrompt("A woman walks along a rainy platform");
    expect(next).toContain("A woman walks along a rainy platform");
    expect(next.toLowerCase()).toContain("continue the shot");
  });

  it("never stacks the instruction when a chained shot is chained again", () => {
    const once = continuationPrompt("A woman walks along a rainy platform");
    const twice = continuationPrompt(once);
    expect(twice).toBe(once);
    expect(continuationPrompt(twice)).toBe(once);
  });

  it("survives an empty previous prompt", () => {
    expect(continuationPrompt("   ")).toBeTruthy();
  });

  it("gives the original prompt back", () => {
    const once = continuationPrompt("A woman walks along a rainy platform");
    expect(stripContinuationPrefix(once)).toBe("A woman walks along a rainy platform");
  });
});
