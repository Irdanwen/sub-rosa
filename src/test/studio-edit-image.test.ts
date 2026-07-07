import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaProxyResponse } from "../lib/studio/types";

// Replace the media client so composeImages/editImage routing can be asserted
// without any network or Tauri invoke.
vi.mock("../lib/studio/client", () => {
  class MediaError extends Error {
    status: number;
    code?: string;
    retryAfterMs?: number;

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
    mediaRaw: vi.fn(),
  };
});

import { MediaError, mediaJson, mediaRaw } from "../lib/studio/client";
import { composeImages, editImage } from "../lib/studio/edit-image";

const mediaJsonMock = vi.mocked(mediaJson);
const mediaRawMock = vi.mocked(mediaRaw);

const IMG = "data:image/png;base64,AAAA";
const IMG2 = "data:image/png;base64,BBBB";
const IMG3 = "data:image/png;base64,CCCC";

function rawImage(base64: string): MediaProxyResponse {
  return { status: 200, ok: true, bodyBase64: base64, contentType: "image/png" };
}

beforeEach(() => {
  mediaJsonMock.mockReset();
  mediaRawMock.mockReset();
});

describe("editImage", () => {
  it("posts a single data URI to /image/edit and returns the image", async () => {
    mediaRawMock.mockResolvedValueOnce(rawImage("OUT"));
    const result = await editImage("seedream-v4-edit", "brighten it", IMG);
    expect(result).toBe("OUT");
    expect(mediaRawMock).toHaveBeenCalledWith("/image/edit", {
      model: "seedream-v4-edit",
      prompt: "brighten it",
      image: IMG,
      safe_mode: false,
    });
  });

  it("falls back to the async queue when the sync edit reports MODEL_REQUIRES_ASYNC", async () => {
    mediaRawMock.mockRejectedValueOnce(
      new MediaError("use the queue", { status: 409, code: "MODEL_REQUIRES_ASYNC" }),
    );
    mediaJsonMock.mockResolvedValueOnce({ queue_id: "q1", status: "pending" });
    mediaRawMock.mockResolvedValueOnce(rawImage("QUEUED"));

    const result = await editImage("seedream-v4-edit", "brighten it", IMG);
    expect(result).toBe("QUEUED");
    expect(mediaJsonMock).toHaveBeenCalledWith("/image/edit/queue", expect.any(Object));
  });
});

describe("composeImages", () => {
  it("degrades a single image to a plain /image/edit", async () => {
    mediaRawMock.mockResolvedValueOnce(rawImage("EDITED"));
    const result = await composeImages("seedream-v4-edit", "tweak", [IMG]);
    expect(result).toBe("EDITED");
    expect(mediaRawMock).toHaveBeenCalledWith("/image/edit", expect.any(Object));
    expect(mediaJsonMock).not.toHaveBeenCalled();
  });

  it("queues two or more images through /image/multi-edit", async () => {
    mediaJsonMock.mockResolvedValueOnce({ queue_id: "q9", status: "pending" });
    mediaRawMock.mockResolvedValueOnce(rawImage("COMPOSED"));

    const result = await composeImages("seedream-v4-edit", "put 1 into 2", [IMG, IMG2]);
    expect(result).toBe("COMPOSED");
    expect(mediaJsonMock).toHaveBeenCalledWith("/image/multi-edit/queue", {
      model: "seedream-v4-edit",
      prompt: "put 1 into 2",
      images: [IMG, IMG2],
      safe_mode: false,
    });
    expect(mediaRawMock).toHaveBeenCalledWith("/image/multi-edit/retrieve", {
      id: "q9",
      queue_id: "q9",
      model: "seedream-v4-edit",
    });
  });

  it("caps the composition at three source images", async () => {
    mediaJsonMock.mockResolvedValueOnce({ queue_id: "q", status: "pending" });
    mediaRawMock.mockResolvedValueOnce(rawImage("OK"));

    await composeImages("seedream-v4-edit", "merge", [
      IMG,
      IMG2,
      IMG3,
      "data:image/png;base64,DDDD",
    ]);
    const body = mediaJsonMock.mock.calls[0][1] as { images: string[] };
    expect(body.images).toEqual([IMG, IMG2, IMG3]);
  });

  it("drops blank entries before deciding the route", async () => {
    mediaRawMock.mockResolvedValueOnce(rawImage("EDITED"));
    // One real image plus an empty slot must edit, not compose.
    await composeImages("seedream-v4-edit", "x", ["", IMG, "   "]);
    expect(mediaRawMock).toHaveBeenCalledWith("/image/edit", expect.any(Object));
    expect(mediaJsonMock).not.toHaveBeenCalled();
  });

  it("rejects an empty image set", async () => {
    await expect(composeImages("seedream-v4-edit", "x", ["", "  "])).rejects.toThrow(
      /at least one image/i,
    );
  });
});
