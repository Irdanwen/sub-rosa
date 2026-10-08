// The price of a minute of voice conversation, said before the first one:
// half a minute heard (by the second), half a minute spoken (by the
// character), from the catalog's own prices.

import { describe, expect, it } from "vitest";
import type { MediaModel } from "../lib/studio/types";
import { frameSize } from "../lib/voice/voice-camera";
import { voiceCostPerMinute } from "../lib/voice/voice-cost";

const tts = {
  id: "tts-kokoro",
  name: "Kokoro",
  mediaType: "tts",
  pricing: { input: { usd: 3.5 } },
} as unknown as MediaModel;
const asr = {
  id: "nvidia/parakeet-tdt-0.6b-v3",
  name: "Parakeet",
  mediaType: "asr",
  pricing: { per_second: { usd: 0.0001 } },
} as unknown as MediaModel;

describe("voice cost", () => {
  it("adds listening and speaking when both are priced", () => {
    // 450 characters at 3.5 USD a million is 0.1575 credit; 30 s at
    // 0.0001 USD is 0.3 credit.
    expect(voiceCostPerMinute({ speechEngine: tts, transcriptionModel: asr })).toEqual({
      creditsPerMinute: 0.46,
    });
  });

  it("says nothing it cannot price", () => {
    expect(voiceCostPerMinute({ speechEngine: tts })).toEqual({});
    expect(
      voiceCostPerMinute({ speechEngine: tts, transcriptionModel: { ...asr, pricing: {} } }),
    ).toEqual({});
  });
});

describe("camera frames", () => {
  it("are shrunk to the long edge and never grown", () => {
    expect(frameSize(4032, 3024)).toEqual({ width: 1280, height: 960 });
    expect(frameSize(720, 1280)).toEqual({ width: 720, height: 1280 });
    expect(frameSize(640, 480)).toEqual({ width: 640, height: 480 });
  });
});
