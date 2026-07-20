import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// No network, no Tauri: the queue only talks through the media client, and
// notifications are a mobile nicety stubbed out here.
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
vi.mock("../lib/studio/media-notifications", () => ({
  ensureNotificationPermission: vi.fn().mockResolvedValue(false),
  notifyMediaJobDone: vi.fn().mockResolvedValue(undefined),
}));

import { fileResultFrom, type MediaFileResult, useMediaJobQueue } from "../lib/studio/async-job";
import { mediaJson, mediaRaw } from "../lib/studio/client";

const mediaJsonMock = vi.mocked(mediaJson);
const mediaRawMock = vi.mocked(mediaRaw);
const videoResultFrom = fileResultFrom("video_url", "url");

const JOBS_KEY = "os-june:studio-jobs";

function startOptions(overrides: Partial<{ prompt: string; queueBody: Record<string, unknown> }>) {
  return {
    kind: "video" as const,
    model: "wan-2-7-text-to-video",
    prompt: overrides.prompt ?? "a fox",
    extension: "mp4",
    queuePath: "/video/queue",
    queueBody: overrides.queueBody ?? { model: "wan-2-7-text-to-video", prompt: "a fox" },
    retrieve: (queueId: string) => ({
      path: "/video/retrieve",
      body: { id: queueId, queue_id: queueId, model: "wan-2-7-text-to-video" },
    }),
  };
}

beforeEach(() => {
  mediaJsonMock.mockReset();
  mediaRawMock.mockReset();
  window.localStorage.removeItem(JOBS_KEY);
});

describe("useMediaJobQueue", () => {
  it("runs a job to completion, delivers it, and clears the persisted entry", async () => {
    mediaJsonMock.mockResolvedValueOnce({ queue_id: "q1", status: "QUEUED" });
    mediaRawMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: { status: "completed", video_url: "/v1/video/file/q1" },
    });
    const onCompleted = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useMediaJobQueue<MediaFileResult>(onCompleted, videoResultFrom),
    );
    await act(async () => {
      await result.current.start(startOptions({}));
    });

    expect(onCompleted).toHaveBeenCalledWith(
      { url: "/v1/video/file/q1" },
      expect.objectContaining({ id: "q1" }),
    );
    expect(result.current.jobs).toHaveLength(0);
    expect(window.localStorage.getItem(JOBS_KEY) ?? "[]").not.toContain("q1");
  });

  it("tracks several renders at once", async () => {
    mediaJsonMock
      .mockResolvedValueOnce({ queue_id: "qa", status: "QUEUED" })
      .mockResolvedValueOnce({ queue_id: "qb", status: "QUEUED" });
    // Both jobs stay pending; the list must show two live cards.
    mediaRawMock.mockResolvedValue({ status: 200, ok: true, json: { status: "processing" } });
    const onCompleted = vi.fn().mockResolvedValue(undefined);

    const { result, unmount } = renderHook(() =>
      useMediaJobQueue<MediaFileResult>(onCompleted, videoResultFrom),
    );
    act(() => {
      void result.current.start(startOptions({ prompt: "first" }));
      void result.current.start(startOptions({ prompt: "second" }));
    });
    await waitFor(() => expect(result.current.jobs).toHaveLength(2));

    expect(result.current.jobs.map((entry) => entry.job.id).sort()).toEqual(["qa", "qb"]);
    // Both persisted for a later re-attach.
    const persisted = JSON.parse(window.localStorage.getItem(JOBS_KEY) ?? "[]");
    expect(persisted).toHaveLength(2);
    unmount();
  });

  it("keeps a failed job visible until dismissed, and drops it from storage", async () => {
    mediaJsonMock.mockResolvedValueOnce({ queue_id: "q-bad", status: "QUEUED" });
    mediaRawMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: { status: "failed", error: "model exploded" },
    });
    const onCompleted = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useMediaJobQueue<MediaFileResult>(onCompleted, videoResultFrom),
    );
    await act(async () => {
      await result.current.start(startOptions({}));
    });

    expect(result.current.jobs).toHaveLength(1);
    expect(result.current.jobs[0].phase).toBe("failed");
    expect(result.current.jobs[0].message).toMatch(/model exploded/);
    expect(window.localStorage.getItem(JOBS_KEY) ?? "[]").not.toContain("q-bad");

    act(() => result.current.dismiss("q-bad"));
    expect(result.current.jobs).toHaveLength(0);
  });

  it("surfaces a queue-submit failure as a failed card without persisting anything", async () => {
    mediaJsonMock.mockRejectedValueOnce(new Error("insufficient credits"));
    const onCompleted = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useMediaJobQueue<MediaFileResult>(onCompleted, videoResultFrom),
    );
    await act(async () => {
      await result.current.start(startOptions({}));
    });

    expect(result.current.jobs).toHaveLength(1);
    expect(result.current.jobs[0].phase).toBe("failed");
    expect(result.current.jobs[0].message).toMatch(/insufficient credits/);
    expect(JSON.parse(window.localStorage.getItem(JOBS_KEY) ?? "[]")).toHaveLength(0);
  });
});
