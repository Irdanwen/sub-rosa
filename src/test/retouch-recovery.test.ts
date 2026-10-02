import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaJob } from "../lib/studio/async-job";

const mocks = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("../lib/studio/artifacts", () => ({
  registerDownloadedArtifactDurably: mocks.register,
  isQueuedImageJobClaimed: () => false,
}));
vi.mock("../lib/studio/bible", () => ({ listBibleEntries: vi.fn(), addBibleRef: vi.fn() }));

import {
  STUDIO_IMAGE_RECOVERED_EVENT,
  readStandaloneImageFailures,
  recoverStandaloneImageJob,
} from "../lib/studio/image-job-recovery";
import {
  inFlightRetouches,
  RETOUCH_FAILED_EVENT,
  RETOUCH_VERSION_EVENT,
  type RetouchVersionDetail,
  readRetouchFailures,
  recoverRetouchJob,
  retouchRootOf,
  retouchSource,
  submitRetouch,
} from "../lib/studio/retouch/jobs";

const lineage = { of: "v1.png", root: "root.png", op: "prompt" as const, n: 2 };

const finished = (overrides: Partial<MediaJob> = {}): MediaJob => ({
  id: "job-1",
  kind: "image",
  model: "ideogram-v4-5-edit",
  prompt: "Paint the wall green.",
  extension: "png",
  status: "completed",
  artifactPath: "/gallery/v2.png",
  artifactFileName: "v2.png",
  artifactBytes: 42,
  costCredits: 10.76,
  source: retouchSource("root.png"),
  clientContext: { v: 1, edit: lineage },
  createdAt: "2026-10-02T08:00:00.000Z",
  updatedAt: "2026-10-02T08:00:44.700Z",
  ...overrides,
});

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  mocks.register.mockReset().mockResolvedValue({ id: "v2.png" });
});

describe("retouch submission", () => {
  it("queues a durable job that carries its lineage and its zone", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(finished({ status: "queued" }));
    const composite = {
      parentFileName: "v1.png",
      crop: [10, 20, 300, 200] as [number, number, number, number],
      maskPngBase64: "AAAA",
    };
    await submitRetouch({
      request: {
        base: "/image/multi-edit",
        body: { model: "ideogram-v4-5-edit", prompt: "Paint the wall green.", images: ["x"] },
      },
      lineage: { ...lineage, op: "zone" },
      costCredits: 10.76,
      composite,
    });
    expect(invoke).toHaveBeenCalledWith("media_job_queue", {
      request: expect.objectContaining({
        kind: "image",
        queuePath: "/image/multi-edit/queue",
        retrievePath: "/image/multi-edit/retrieve",
        source: "retouch:root.png",
        costCredits: 10.76,
        clientContext: { v: 1, edit: { ...lineage, op: "zone" } },
        composite,
      }),
    });
  });

  it("drops a refused submission's row and keeps an uncertain one", async () => {
    const request = { base: "/image/multi-edit" as const, body: { model: "m", prompt: "p" } };
    vi.mocked(invoke).mockRejectedValueOnce({ code: "media_job_queue_failed", message: "no" });
    await expect(submitRetouch({ request, lineage })).rejects.toBeTruthy();
    expect(invoke).toHaveBeenLastCalledWith("media_job_dismiss", expect.any(Object));

    vi.mocked(invoke).mockReset().mockRejectedValueOnce({
      code: "media_job_submission_uncertain",
      message: "maybe",
    });
    await expect(submitRetouch({ request, lineage })).rejects.toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("lists the jobs still rendering for one session", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      finished({ id: "a", status: "processing" }),
      finished({ id: "b", status: "completed" }),
      finished({ id: "c", status: "queued", source: retouchSource("other.png") }),
      finished({ id: "d", status: "queued", source: "studio" }),
    ]);
    expect((await inFlightRetouches("root.png")).map((job) => job.id)).toEqual(["a"]);
  });
});

describe("retouch recovery", () => {
  it("files the version with its lineage and how long it took, then acknowledges the row", async () => {
    const versions: RetouchVersionDetail[] = [];
    const onVersion = (event: Event) =>
      versions.push((event as CustomEvent<RetouchVersionDetail>).detail);
    window.addEventListener(RETOUCH_VERSION_EVENT, onVersion);
    try {
      expect(await recoverRetouchJob(finished())).toBe(true);
    } finally {
      window.removeEventListener(RETOUCH_VERSION_EVENT, onVersion);
    }
    expect(mocks.register).toHaveBeenCalledWith(
      { path: "/gallery/v2.png", fileName: "v2.png", bytes: 42 },
      {
        kind: "image",
        model: "ideogram-v4-5-edit",
        prompt: "Paint the wall green.",
        costCredits: 10.76,
        edit: { ...lineage, jobId: "job-1", elapsedMs: 44700 },
      },
    );
    expect(invoke).toHaveBeenCalledWith("media_job_dismiss", { id: "job-1" });
    expect(versions).toEqual([
      { rootId: "root.png", artifactId: "v2.png", parentId: "v1.png", jobId: "job-1" },
    ]);
  });

  it("marks a zone the source could not take back", async () => {
    await recoverRetouchJob(
      finished({ clientContext: { v: 1, edit: lineage, compositeFailed: true } }),
    );
    expect(mocks.register.mock.calls[0][1].edit).toMatchObject({ unmerged: true });
  });

  it("keeps a failure for its session rather than the gallery's notices", async () => {
    const failed = vi.fn();
    window.addEventListener(RETOUCH_FAILED_EVENT, failed);
    try {
      await recoverStandaloneImageJob(
        finished({
          status: "failed",
          error: "Aspect ratio '4:3' is not supported",
          artifactPath: undefined,
        }),
      );
    } finally {
      window.removeEventListener(RETOUCH_FAILED_EVENT, failed);
    }
    expect(readRetouchFailures("root.png")).toEqual([
      {
        jobId: "job-1",
        rootId: "root.png",
        parentId: "v1.png",
        prompt: "Paint the wall green.",
        message: "Aspect ratio '4:3' is not supported",
      },
    ]);
    expect(readRetouchFailures("other.png")).toEqual([]);
    expect(readStandaloneImageFailures()).toEqual([]);
    expect(mocks.register).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("media_job_dismiss", { id: "job-1" });
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("refreshes the gallery when a version is filed through the shared observer", async () => {
    const recovered = vi.fn();
    window.addEventListener(STUDIO_IMAGE_RECOVERED_EVENT, recovered);
    try {
      await recoverStandaloneImageJob(finished());
    } finally {
      window.removeEventListener(STUDIO_IMAGE_RECOVERED_EVENT, recovered);
    }
    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it("leaves running and foreign jobs alone", async () => {
    expect(await recoverRetouchJob(finished({ status: "processing" }))).toBe(true);
    expect(await recoverRetouchJob(finished({ source: "studio" }))).toBe(false);
    expect(mocks.register).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(retouchRootOf("retouch:")).toBeUndefined();
  });

  it("files a job event and its snapshot twin only once at a time", async () => {
    await Promise.all([recoverRetouchJob(finished()), recoverRetouchJob(finished())]);
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });
});
