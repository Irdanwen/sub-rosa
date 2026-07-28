// The Studio job hooks are a *view* over durable rows Rust owns: they queue a
// generation, hand the id over, then reconcile. These tests stand in a fake
// Rust job store so the interesting case is testable — a render that finished
// while the webview was frozen must still reach the gallery.

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
vi.mock("../lib/notifications", () => ({
  ensureNotificationPermission: vi.fn().mockResolvedValue(false),
}));

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Set<(event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.add(handler);
    return Promise.resolve(() => mocks.listeners.delete(handler));
  },
}));

import { type MediaJob, useMediaJob, useMediaJobQueue } from "../lib/studio/async-job";
import { mediaJson } from "../lib/studio/client";

const mediaJsonMock = vi.mocked(mediaJson);

/** Stand-in for the `media_jobs` table. */
let store: MediaJob[] = [];

function job(id: string, overrides: Partial<MediaJob> = {}): MediaJob {
  return {
    id,
    kind: "video",
    model: "wan-2-7-text-to-video",
    prompt: "a fox",
    extension: "mp4",
    status: "queued",
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    ...overrides,
  };
}

function emit(payload: MediaJob) {
  for (const handler of mocks.listeners) handler({ payload });
}

function startOptions(overrides: Partial<{ prompt: string }> = {}) {
  return {
    kind: "video" as const,
    model: "wan-2-7-text-to-video",
    prompt: overrides.prompt ?? "a fox",
    extension: "mp4",
    queuePath: "/video/queue",
    queueBody: { model: "wan-2-7-text-to-video", prompt: overrides.prompt ?? "a fox" },
    retrieve: (queueId: string) => ({
      path: "/video/retrieve",
      body: { id: queueId, model: "wan-2-7-text-to-video" },
    }),
    urlFields: ["video_url", "url"],
  };
}

beforeEach(() => {
  mediaJsonMock.mockReset();
  mocks.listeners.clear();
  store = [];
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "media_job_list":
        return store;
      case "media_job_start": {
        const request = args?.request as Record<string, unknown>;
        const created = job(request.queueId as string, {
          prompt: request.prompt as string,
        });
        store = [created, ...store];
        return created;
      }
      case "media_job_dismiss":
      case "media_job_stop":
        store = store.filter((entry) => entry.id !== args?.id);
        return undefined;
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
});

describe("useMediaJobQueue", () => {
  it("queues upstream, hands the id to Rust, and shows a live card", async () => {
    mediaJsonMock.mockResolvedValueOnce({ queue_id: "q1", status: "QUEUED" });
    const onCompleted = vi.fn();

    const { result } = renderHook(() => useMediaJobQueue("video", onCompleted));
    await act(async () => {
      await result.current.start(startOptions());
    });

    expect(mocks.invoke).toHaveBeenCalledWith(
      "media_job_start",
      expect.objectContaining({
        request: expect.objectContaining({
          queueId: "q1",
          retrievePath: "/video/retrieve",
          urlFields: ["video_url", "url"],
        }),
      }),
    );
    await waitFor(() => expect(result.current.jobs).toHaveLength(1));
    expect(result.current.jobs[0].job.id).toBe("q1");
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it("files the artifact and clears the row when Rust reports a completion", async () => {
    mediaJsonMock.mockResolvedValueOnce({ queue_id: "q1", status: "QUEUED" });
    const onCompleted = vi.fn();

    const { result } = renderHook(() => useMediaJobQueue("video", onCompleted));
    await act(async () => {
      await result.current.start(startOptions());
    });

    await act(async () => {
      emit(
        job("q1", {
          status: "completed",
          artifactPath: "/gallery/q1.mp4",
          artifactFileName: "q1.mp4",
          artifactBytes: 42,
        }),
      );
    });

    await waitFor(() =>
      expect(onCompleted).toHaveBeenCalledWith(
        { path: "/gallery/q1.mp4", fileName: "q1.mp4", bytes: 42 },
        expect.objectContaining({ id: "q1" }),
      ),
    );
    // Acknowledged: Rust may forget the row now.
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("media_job_dismiss", { id: "q1" }),
    );
    await waitFor(() => expect(result.current.jobs).toHaveLength(0));
  });

  it("picks up a render that finished while the app was closed", async () => {
    // No start() here: the row is simply already there on mount, which is what
    // a suspended (or killed) app comes back to.
    store = [
      job("q-overnight", {
        status: "completed",
        artifactPath: "/gallery/q-overnight.mp4",
        artifactFileName: "q-overnight.mp4",
        artifactBytes: 7,
      }),
    ];
    const onCompleted = vi.fn();

    renderHook(() => useMediaJobQueue("video", onCompleted));

    await waitFor(() =>
      expect(onCompleted).toHaveBeenCalledWith(
        { path: "/gallery/q-overnight.mp4", fileName: "q-overnight.mp4", bytes: 7 },
        expect.objectContaining({ id: "q-overnight" }),
      ),
    );
  });

  it("keeps a failed job visible until dismissed", async () => {
    mediaJsonMock.mockResolvedValueOnce({ queue_id: "q-bad", status: "QUEUED" });
    const { result } = renderHook(() => useMediaJobQueue("video", vi.fn()));
    await act(async () => {
      await result.current.start(startOptions());
    });

    await act(async () => {
      emit(job("q-bad", { status: "failed", error: "model exploded" }));
    });

    await waitFor(() => expect(result.current.jobs[0]?.phase).toBe("failed"));
    expect(result.current.jobs[0].message).toMatch(/model exploded/);

    await act(async () => {
      result.current.dismiss("q-bad");
    });
    await waitFor(() => expect(result.current.jobs).toHaveLength(0));
  });

  it("surfaces a queue-submit failure as a failed card without creating a row", async () => {
    mediaJsonMock.mockRejectedValueOnce(new Error("insufficient credits"));
    const { result } = renderHook(() => useMediaJobQueue("video", vi.fn()));
    await act(async () => {
      await result.current.start(startOptions());
    });

    await waitFor(() => expect(result.current.jobs).toHaveLength(1));
    expect(result.current.jobs[0].phase).toBe("failed");
    expect(result.current.jobs[0].message).toMatch(/insufficient credits/);
    expect(mocks.invoke).not.toHaveBeenCalledWith("media_job_start", expect.anything());
    expect(store).toHaveLength(0);
  });
});

describe("useMediaJob", () => {
  it("re-attaches to a render still running from a previous session", async () => {
    store = [job("q-live", { status: "processing" })];

    const { result } = renderHook(() => useMediaJob("video", vi.fn()));

    await waitFor(() => expect(result.current.state.phase).toBe("processing"));
  });
});
