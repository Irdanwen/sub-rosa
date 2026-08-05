import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closestAspectRatio,
  continuationPrompt,
  extractFrameAt,
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

/**
 * A `<video>`/`<canvas>` pair standing in for a decoder, wired to the one rule
 * that matters here: the canvas only receives pixels when the element actually
 * holds a picture. Below `HAVE_CURRENT_DATA`, `drawImage` is a no-op per spec -
 * it does not throw, so the canvas simply stays transparent.
 */
function stubDecoder({
  duration = 10,
  /** Which positions the decoder can hand a picture back for. */
  decodes = (_time: number) => true,
  /** Positions where `seeked` fires before the frame is there. */
  readyAfterSeek = (_time: number) => 2,
}: {
  duration?: number;
  decodes?: (time: number) => boolean;
  readyAfterSeek?: (time: number) => number;
} = {}) {
  const video = new EventTarget() as EventTarget & {
    readyState: number;
    currentTime: number;
    src: string;
  };
  let position = 0;
  Object.assign(video, {
    videoWidth: 1920,
    videoHeight: 1080,
    duration,
    readyState: 1,
    crossOrigin: "",
    preload: "",
    muted: false,
    playsInline: false,
  });
  Object.defineProperty(video, "currentTime", {
    get: () => position,
    set: (value: number) => {
      position = value;
      setTimeout(() => {
        video.readyState = readyAfterSeek(value);
        video.dispatchEvent(new Event("seeked"));
        // A decoder that reports the frame late still gets there: this is the
        // wait the read has to survive rather than draw through.
        if (video.readyState < 2) {
          setTimeout(() => {
            video.readyState = 2;
            video.dispatchEvent(new Event("canplay"));
          }, 40);
        }
      }, 0);
    },
  });
  Object.defineProperty(video, "src", {
    get: () => "clip.mp4",
    set: () => setTimeout(() => video.dispatchEvent(new Event("loadedmetadata")), 0),
  });

  const draws: { at: number; width: number }[] = [];
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    if (tag === "video") return video as unknown as HTMLElement;
    let painted = false;
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toDataURL: () => `data:image/png;base64,${painted ? "picture" : "blank"}`,
    };
    const context = {
      // Copying an already-drawn canvas carries its pixels; drawing the video
      // is where the decoder gets a say, and where it can quietly no-op.
      drawImage: (source: { width: number; height: number } | typeof video) => {
        if (source !== video) {
          painted = (source as { painted?: boolean }).painted === true;
          return;
        }
        if (video.readyState < 2 || !decodes(position)) return;
        draws.push({ at: position, width: canvas.width });
        painted = true;
      },
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4).fill(painted ? 255 : 0),
        width,
        height,
        colorSpace: "srgb",
      }),
    };
    Object.defineProperty(canvas, "painted", { get: () => painted });
    return canvas as unknown as HTMLElement;
  });
  return { video, draws };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reading a frame back", () => {
  it("waits for the decoder rather than drawing on a premature seeked", async () => {
    // WebKit fires `seeked` on a fresh element before the frame is decoded.
    // Drawing there paints nothing at all, silently.
    const { draws } = stubDecoder({ readyAfterSeek: () => 1 });

    const frame = await extractFrameAt("clip.mp4", 7.8, { encoding: "capture" });

    expect(frame.dataUrl).toBe("data:image/png;base64,picture");
    expect(draws.length).toBeGreaterThan(0);
  });

  it("moves on a frame when a position decodes nothing", async () => {
    const { draws } = stubDecoder({ decodes: (time) => time > 7.8 });

    const frame = await extractFrameAt("clip.mp4", 7.8, { encoding: "capture" });

    expect(frame.dataUrl).toBe("data:image/png;base64,picture");
    // Reported where it landed, not where it was asked to: a still's recorded
    // position has to match the picture it holds.
    expect(frame.timeSeconds).toBeGreaterThan(7.8);
    expect(draws.every((draw) => draw.at > 7.8)).toBe(true);
  });

  it("retries backwards at the end stop, where forward has nowhere to go", async () => {
    // The end stop is both the position a decoder is likeliest to refuse and
    // the one a retry cannot step past. Nudging forward there re-reads the
    // same failing position and calls it three attempts.
    const { draws } = stubDecoder({ duration: 10, decodes: (time) => time < 9.9 });

    const frame = await extractFrameAt("clip.mp4", 10, { encoding: "capture" });

    expect(frame.dataUrl).toBe("data:image/png;base64,picture");
    expect(frame.timeSeconds).toBeLessThan(9.9);
    expect(draws.length).toBeGreaterThan(0);
  });

  it("encodes the canvas it checked, at the clip's own resolution", async () => {
    // Checking a small draw and encoding a separate full-size one leaves the
    // encoded canvas unexamined - the same bug, one step along.
    const { draws } = stubDecoder();

    const frame = await extractFrameAt("clip.mp4", 4, { encoding: "capture" });

    expect(frame.dataUrl).toBe("data:image/png;base64,picture");
    expect(draws.map((draw) => draw.width)).toEqual([1920]);
  });

  it("fails rather than hand back an empty picture", async () => {
    // The bug this guards: an empty read encodes to a full-size, fully
    // transparent PNG, saves without an error, and shows up as a gallery tile
    // that is simply not there.
    stubDecoder({ decodes: () => false });

    await expect(extractFrameAt("clip.mp4", 7.8, { encoding: "capture" })).rejects.toThrow();
  });

  it("gives up on a clip that answers nothing at all", async () => {
    // Neither `loadedmetadata` nor `error`: a stalled asset request, which
    // used to leave the capture dialog spinning on a promise that never
    // settled. Bounded like every other wait in the read.
    vi.useFakeTimers();
    vi.spyOn(document, "createElement").mockImplementation(
      () => new EventTarget() as unknown as HTMLElement,
    );
    const read = extractFrameAt("clip.mp4", 4, { encoding: "capture" });
    const settled = expect(read).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(20_000);
    await settled;
    vi.useRealTimers();
  });
});

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
