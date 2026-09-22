import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("../lib/notifications", () => ({ ensureNotificationPermission: vi.fn() }));
vi.mock("../lib/studio/client", () => {
  class MediaError extends Error {
    status: number;
    constructor(message: string, options: { status: number }) {
      super(message);
      this.status = options.status;
    }
  }
  return {
    MediaError,
    mediaJson: vi.fn(async () => {
      throw new MediaError("Insufficient credits", { status: 402 });
    }),
    mediaRaw: vi.fn(),
  };
});

import { useMediaJob } from "../lib/studio/async-job";

const failedRow = {
  id: "old-failure",
  kind: "video",
  model: "flux-3",
  prompt: "a violinist",
  extension: "mp4",
  status: "failed",
  error: "Video generation failed: Insufficient USD or Diem balance to complete request.",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const options = {
  kind: "video" as const,
  model: "flux-3",
  prompt: "a violinist",
  extension: "mp4",
  queuePath: "/video/queue",
  queueBody: {},
  retrieve: () => ({ path: "/video/retrieve", body: {} }),
  urlFields: ["url"],
};

beforeEach(() => {
  tauri.listen.mockReset().mockResolvedValue(() => undefined);
  tauri.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "media_job_list") return [failedRow];
    return undefined;
  });
});

describe("a failed render in a single-slot Studio tab", () => {
  it("comes back from the durable row until something settles it", async () => {
    const { result } = renderHook(() => useMediaJob("video", () => undefined));
    await waitFor(() => expect(result.current.state.phase).toBe("failed"));
  });

  it("is settled for good when a new render is started", async () => {
    const { result } = renderHook(() => useMediaJob("video", () => undefined));
    await waitFor(() => expect(result.current.state.phase).toBe("failed"));

    await act(async () => {
      await result.current.start(options);
    });

    expect(tauri.invoke).toHaveBeenCalledWith("media_job_dismiss", { id: "old-failure" });
    // The new attempt's own refusal is what shows, with its status kept.
    expect(result.current.state).toEqual({
      phase: "failed",
      message: "Insufficient credits",
      status: 402,
    });
  });

  it("is settled for good when dismissed", async () => {
    const { result } = renderHook(() => useMediaJob("video", () => undefined));
    await waitFor(() => expect(result.current.state.phase).toBe("failed"));

    act(() => result.current.reset());

    expect(tauri.invoke).toHaveBeenCalledWith("media_job_dismiss", { id: "old-failure" });
    await waitFor(() => expect(result.current.state.phase).toBe("idle"));
  });
});
