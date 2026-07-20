import { describe, expect, it } from "vitest";
import { clipWindow, pickRecorderMime, timelineSeconds } from "../lib/studio/assemble";

describe("clipWindow", () => {
  it("clamps trims to the clip's real duration", () => {
    expect(clipWindow({ inSeconds: 0 }, 8)).toEqual({ start: 0, end: 8 });
    expect(clipWindow({ inSeconds: 2, outSeconds: 5 }, 8)).toEqual({ start: 2, end: 5 });
    expect(clipWindow({ inSeconds: 2, outSeconds: 99 }, 8)).toEqual({ start: 2, end: 8 });
    // An inverted trim collapses to zero length instead of going negative.
    expect(clipWindow({ inSeconds: 6, outSeconds: 3 }, 8)).toEqual({ start: 6, end: 6 });
    expect(clipWindow({ inSeconds: 99 }, 8)).toEqual({ start: 8, end: 8 });
  });
});

describe("timelineSeconds", () => {
  it("sums the effective windows of the cut list", () => {
    expect(
      timelineSeconds([
        { inSeconds: 0, durationSeconds: 5 },
        { inSeconds: 1, outSeconds: 4, durationSeconds: 10 },
        { inSeconds: 6, outSeconds: 3, durationSeconds: 8 },
      ]),
    ).toBe(8);
  });
});

describe("pickRecorderMime", () => {
  it("prefers mp4, falls back to webm, and reports unsupported systems", () => {
    expect(pickRecorderMime((mime) => mime === "video/mp4")).toEqual({
      mimeType: "video/mp4",
      extension: "mp4",
    });
    expect(pickRecorderMime((mime) => mime.startsWith("video/webm"))).toEqual({
      mimeType: "video/webm;codecs=vp9,opus",
      extension: "webm",
    });
    expect(pickRecorderMime(() => false)).toBeUndefined();
  });
});
