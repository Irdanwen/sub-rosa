import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("../lib/studio/artifacts", () => ({
  readArtifactBase64: vi.fn(async () => "QUEUED"),
  rememberQueuedImage: vi.fn(),
}));
import type { MediaProxyResponse } from "../lib/studio/types";

// Replace the media client so composeImages/editImage routing can be asserted
// without any network or Tauri invoke. Keep the real MediaError
// (isAsyncRetrySignal instanceof-checks the class the tests throw); mock only
// the transport functions.
vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  mediaJson: vi.fn(),
  mediaRaw: vi.fn(),
}));

import { MediaError, mediaJson, mediaRaw } from "../lib/studio/client";
import { rememberQueuedImage } from "../lib/studio/artifacts";
import { composeImages, editImage, removeBackground } from "../lib/studio/edit-image";

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
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "media_job_list") return [];
    return {
      id: (args as { request: { jobId: string } }).request.jobId,
      status: "completed",
      artifactPath: "/gallery/result.png",
      artifactFileName: "result.png",
      artifactBytes: 6,
    };
  });
  vi.mocked(rememberQueuedImage).mockReset();
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
    expect(rememberQueuedImage).toHaveBeenCalledWith(
      "QUEUED",
      { path: "/gallery/result.png", fileName: "result.png", bytes: 6 },
      expect.any(String),
    );
    expect(invoke).toHaveBeenCalledWith(
      "media_job_queue",
      expect.objectContaining({
        request: expect.objectContaining({ queuePath: "/image/edit/queue" }),
      }),
    );
  });

  it("reconciles a completed native image after a frozen webview misses its event", async () => {
    let jobId = "";
    let completed = false;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "media_job_queue") {
        jobId = (args as { request: { jobId: string } }).request.jobId;
        return { id: jobId, status: "processing" };
      }
      if (command === "media_job_list") {
        return jobId
          ? [
              {
                id: jobId,
                status: completed ? "completed" : "processing",
                artifactPath: "/gallery/result.png",
                artifactFileName: "result.png",
              },
            ]
          : [];
      }
      return null;
    });
    const pending = editImage("gpt-image-2", "brighten it", IMG);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("media_job_list"));
    completed = true;
    document.dispatchEvent(new Event("visibilitychange"));
    const result = await pending;
    expect(result).toBe("QUEUED");
    expect(
      vi.mocked(invoke).mock.calls.filter(([command]) => command === "media_job_list"),
    ).toHaveLength(2);
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
    expect(result).toBe("QUEUED");
    expect(invoke).toHaveBeenCalledWith("media_job_queue", {
      request: expect.objectContaining({
        queuePath: "/image/multi-edit/queue",
        queueBody: {
          model: "seedream-v4-edit",
          prompt: "put 1 into 2",
          images: [IMG, IMG2],
          safe_mode: false,
        },
      }),
    });
    expect(mediaRawMock).not.toHaveBeenCalled();
    expect(listen).toHaveBeenCalledWith("june://media-job", expect.any(Function));
  });

  it("refuses more than three source images without silently dropping one", async () => {
    await expect(
      composeImages("seedream-v4-edit", "merge", [IMG, IMG2, IMG3, IMG]),
    ).rejects.toThrow("at most three");
    expect(invoke).not.toHaveBeenCalled();
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

describe("removeBackground", () => {
  it("strips a data-URI prefix and posts plain base64 to /image/background-remove", async () => {
    mediaRawMock.mockResolvedValueOnce(rawImage("CUTOUT"));
    const result = await removeBackground(IMG);
    expect(result).toBe("CUTOUT");
    expect(mediaRawMock).toHaveBeenCalledWith("/image/background-remove", { image: "AAAA" });
  });

  it("passes raw base64 through untouched", async () => {
    mediaRawMock.mockResolvedValueOnce(rawImage("CUTOUT"));
    await removeBackground("ZZZZ");
    expect(mediaRawMock).toHaveBeenCalledWith("/image/background-remove", { image: "ZZZZ" });
  });

  it("surfaces a missing image as an error", async () => {
    mediaRawMock.mockResolvedValueOnce({ status: 200, ok: true });
    await expect(removeBackground(IMG)).rejects.toThrow(/did not return an image/i);
  });
});
