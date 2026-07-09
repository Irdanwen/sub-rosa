import { beforeEach, describe, expect, it, vi } from "vitest";

// No network, no Tauri: the poller only talks through the media client.
vi.mock("../lib/studio/client", () => {
  class MediaError extends Error {
    status: number;
    code?: string;

    constructor(message: string, options: { status: number; code?: string }) {
      super(message);
      this.name = "MediaError";
      this.status = options.status;
      this.code = options.code;
    }
  }
  return {
    MediaError,
    mediaJson: vi.fn(),
    mediaBinary: vi.fn(),
    mediaGet: vi.fn(),
    mediaRaw: vi.fn(),
  };
});

import { fileResultFrom, pollUntilDone } from "../lib/studio/async-job";
import { MediaError, mediaRaw } from "../lib/studio/client";

const mediaRawMock = vi.mocked(mediaRaw);

beforeEach(() => {
  mediaRawMock.mockReset();
});

describe("pollUntilDone", () => {
  it("keeps polling on pending JSON, then treats a binary body as the delivery", async () => {
    // Carpe Diem music: JSON while pending, then the MP3 itself, exactly once
    // (the job is dropped server-side right after). The binary response must
    // be recognized as the completion or the paid track is lost to a 404.
    mediaRawMock
      .mockResolvedValueOnce({ status: 200, ok: true, json: { status: "PROCESSING" } })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        bodyBase64: "TVAzREFUQQ==",
        contentType: "audio/mpeg",
      });

    const result = await pollUntilDone({
      retrievePath: "/audio/music/retrieve",
      retrieveBody: { id: "song-1", queue_id: "song-1", model: "elevenlabs-music" },
      getResult: fileResultFrom("audio_url", "url"),
      intervalMs: 1,
    });

    expect(result).toEqual({ base64: "TVAzREFUQQ==" });
    expect(mediaRawMock).toHaveBeenCalledTimes(2);
  });

  it("still resolves a completed JSON response through its URL field", async () => {
    mediaRawMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: { status: "completed", audio_url: "/v1/audio/music/file/song-1" },
    });

    const result = await pollUntilDone({
      retrievePath: "/audio/music/retrieve",
      retrieveBody: { id: "song-1", queue_id: "song-1", model: "m" },
      getResult: fileResultFrom("audio_url", "url"),
      intervalMs: 1,
    });

    expect(result).toEqual({ url: "/v1/audio/music/file/song-1" });
  });

  it("fails fast on a 4xx retrieve (expired or unknown job)", async () => {
    mediaRawMock.mockRejectedValue(
      new MediaError("Unknown queue_id (expired or unknown to this operator)", { status: 404 }),
    );

    await expect(
      pollUntilDone({
        retrievePath: "/audio/music/retrieve",
        retrieveBody: { id: "gone", queue_id: "gone", model: "m" },
        getResult: fileResultFrom("audio_url", "url"),
        intervalMs: 1,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(mediaRawMock).toHaveBeenCalledTimes(1);
  });
});
