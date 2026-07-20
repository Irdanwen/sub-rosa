import { beforeEach, describe, expect, it, vi } from "vitest";

// No network, no Tauri: generateSpeech only talks through the media client.
vi.mock("../lib/studio/client", () => ({
  mediaBinary: vi.fn(),
}));

import { mediaBinary } from "../lib/studio/client";
import { generateSpeech, SPEECH_SPEED } from "../lib/studio/speech";

const mediaBinaryMock = vi.mocked(mediaBinary);

beforeEach(() => {
  mediaBinaryMock.mockReset();
  mediaBinaryMock.mockResolvedValue({ base64: "abc", contentType: "audio/mpeg" });
});

describe("generateSpeech", () => {
  it("sends the OpenAI-style speech body with defaults filled in", async () => {
    const result = await generateSpeech({ model: "tts-kokoro", input: "Hello there" });

    expect(result.base64).toBe("abc");
    expect(mediaBinaryMock).toHaveBeenCalledWith(
      "/audio/speech",
      {
        model: "tts-kokoro",
        input: "Hello there",
        speed: SPEECH_SPEED.default,
        response_format: "mp3",
      },
      undefined,
    );
  });

  it("forwards voice, speed, and format when set - and omits voice when empty", async () => {
    await generateSpeech({
      model: "elevenlabs-tts-v3",
      input: "Bonjour",
      voice: "Aria",
      speed: 1.5,
      format: "wav",
    });
    expect(mediaBinaryMock).toHaveBeenCalledWith(
      "/audio/speech",
      {
        model: "elevenlabs-tts-v3",
        input: "Bonjour",
        speed: 1.5,
        response_format: "wav",
        voice: "Aria",
      },
      undefined,
    );

    await generateSpeech({ model: "tts-kokoro", input: "x", voice: "" });
    const lastBody = mediaBinaryMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect("voice" in lastBody).toBe(false);
  });
});
