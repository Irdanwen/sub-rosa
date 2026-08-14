/**
 * Whether one more reference clip or track still fits.
 *
 * Each of these limits is reported by the provider only after a render has been
 * queued and billed, and on the durable path that means a row, a poll, and a
 * failure read minutes later. They are cheap to check in the webview, so they
 * are checked there - in one place, so the phone refuses what the desktop
 * refuses.
 */

import { describe, expect, it, vi } from "vitest";
import {
  MAX_CLIP_SECONDS,
  MAX_REFERENCE_FILE_BYTES,
  MIN_CLIP_SECONDS,
  mediaSeconds,
  type ReferenceMedia,
  referenceAudioProblem,
  referenceClipProblem,
  referenceFileTooBig,
} from "../lib/studio/reference-media";
import { MAX_REQUEST_BYTES } from "../lib/studio/seedance";

const SEEDANCE_2_0 = { id: "seedance-2-0-reference-to-video" };
const SEEDANCE_2_5 = { id: "seedance-2-5-reference-to-video" };

function clip(
  id: string,
  seconds: number,
  dataUri = `data:video/mp4;base64,${id}`,
): ReferenceMedia {
  return { id, label: id, dataUri, seconds };
}

describe("adding a reference clip", () => {
  it("refuses one already in the list", () => {
    const first = clip("alley", 5);
    expect(referenceClipProblem(SEEDANCE_2_0, [first], clip("alley", 5))).toContain("already");
  });

  it("refuses a clip outside the per-clip length window", () => {
    expect(referenceClipProblem(SEEDANCE_2_0, [], clip("blink", 1))).toContain(
      `run ${MIN_CLIP_SECONDS} to ${MAX_CLIP_SECONDS}s`,
    );
    expect(referenceClipProblem(SEEDANCE_2_0, [], clip("epic", 40))).toContain("That clip is 40s");
    expect(referenceClipProblem(SEEDANCE_2_0, [], clip("fine", 5))).toBeUndefined();
  });

  it("lets an unmeasurable clip through on length", () => {
    // A source the webview could not decode reports 0. Refusing what we could
    // not read would be a guess, and the provider still has the last word.
    expect(referenceClipProblem(SEEDANCE_2_0, [], clip("unknown", 0))).toBeUndefined();
  });

  it("holds the combined length to what the version documents", () => {
    const picked = [clip("a", 8), clip("b", 6)];
    // 2.0 allows 15s combined, 2.5 allows 30s. Same clips, different verdict.
    expect(referenceClipProblem(SEEDANCE_2_0, picked, clip("c", 5))).toContain("over the 15s");
    expect(referenceClipProblem(SEEDANCE_2_5, picked, clip("c", 5))).toBeUndefined();
  });

  it("holds the whole request under the size cap", () => {
    // Every media input travels inline, so three reasonable clips really can
    // exceed it - and a 413 after queueing is the worst way to find out.
    const heavy = "x".repeat(Math.ceil(MAX_REQUEST_BYTES / 2) + 1);
    const problem = referenceClipProblem(
      SEEDANCE_2_5,
      [clip("a", 4, `data:video/mp4;base64,${heavy}`)],
      clip("b", 4, `data:video/mp4;base64,${heavy}`),
    );
    expect(problem).toContain("MB");
  });
});

describe("adding reference audio", () => {
  it("refuses a duplicate and keeps a fresh track", () => {
    const track = clip("voice", 12, "data:audio/mpeg;base64,VOICE");
    expect(referenceAudioProblem([track], track)).toContain("already");
    expect(referenceAudioProblem([track], clip("other", 9))).toBeUndefined();
  });

  it("applies no length limit, only the request-size cap", () => {
    // Nothing published constrains a reference track's length, and inventing
    // one would refuse input the provider would have accepted.
    expect(referenceAudioProblem([], clip("long", 600))).toBeUndefined();
  });
});

describe("refusing a file before reading it", () => {
  it("goes by byte count, so a phone never encodes what cannot travel", () => {
    // Reading first would mean holding tens of megabytes of string in a webview
    // that is about to be told it was pointless.
    expect(referenceFileTooBig(MAX_REFERENCE_FILE_BYTES, "clip")).toBeUndefined();
    const problem = referenceFileTooBig(MAX_REFERENCE_FILE_BYTES + 1, "clip");
    expect(problem).toContain("That clip is about");
    expect(referenceFileTooBig(1e9, "track")).toContain("That track is about");
  });

  it("leaves room for what base64 adds", () => {
    // The cap is on the encoded body, and encoding inflates by about a third,
    // so the ceiling on raw bytes has to be lower than the request cap.
    expect(MAX_REFERENCE_FILE_BYTES).toBeLessThan(MAX_REQUEST_BYTES);
  });
});

describe("measuring a source", () => {
  it("gives up rather than hanging on something it cannot decode", async () => {
    // jsdom loads no media, and neither does a real webview handed a codec it
    // does not know: no `loadedmetadata`, no `error`. The form must not wait.
    vi.useFakeTimers();
    try {
      const pending = mediaSeconds("blob:nothing-here", "video");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
