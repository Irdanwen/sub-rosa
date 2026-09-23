import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaJob } from "../lib/studio/async-job";

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  claimed: vi.fn(),
  entries: vi.fn(),
  addRef: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("../lib/studio/artifacts", () => ({
  registerDownloadedArtifactDurably: mocks.register,
  isQueuedImageJobClaimed: mocks.claimed,
}));
vi.mock("../lib/studio/bible", () => ({
  listBibleEntries: mocks.entries,
  addBibleRef: mocks.addRef,
}));

import {
  bibleImageJobSource,
  dismissStandaloneImageFailure,
  observeStandaloneImageJobs,
  readStandaloneImageFailures,
  recoverStandaloneImageJob,
  STUDIO_IMAGE_FAILED_EVENT,
  STUDIO_IMAGE_RECOVERED_EVENT,
} from "../lib/studio/image-job-recovery";

const completed = (source = "studio"): MediaJob => ({
  id: "job-1",
  kind: "image",
  model: "gpt-image-2",
  prompt: "Nera at the concert",
  extension: "png",
  status: "completed",
  artifactPath: "/gallery/nera.png",
  artifactFileName: "nera.png",
  artifactBytes: 99,
  source,
  createdAt: "2026-09-23T00:00:00Z",
  updatedAt: "2026-09-23T00:01:00Z",
});

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  vi.mocked(listen).mockReset().mockResolvedValue(vi.fn());
  mocks.register.mockReset().mockReturnValue({ id: "nera.png" });
  mocks.claimed.mockReset().mockReturnValue(false);
  mocks.entries.mockReset().mockResolvedValue([]);
  mocks.addRef.mockReset().mockResolvedValue("ref-1");
});

describe("standalone image recovery", () => {
  it("surfaces a failed image after restart and acknowledges its durable row", async () => {
    const failed: MediaJob = {
      ...completed(),
      status: "failed",
      error: "Provider refused",
      artifactPath: undefined,
      artifactFileName: undefined,
    };
    const onFailure = vi.fn();
    window.addEventListener(STUDIO_IMAGE_FAILED_EVENT, onFailure);
    await recoverStandaloneImageJob(failed);

    expect(readStandaloneImageFailures()).toEqual([{ id: "job-1", message: "Provider refused" }]);
    expect(invoke).toHaveBeenCalledWith("media_job_dismiss", { id: "job-1" });
    expect(onFailure).toHaveBeenCalledTimes(1);
    dismissStandaloneImageFailure("job-1");
    expect(readStandaloneImageFailures()).toEqual([]);
    window.removeEventListener(STUDIO_IMAGE_FAILED_EVENT, onFailure);
  });

  it("adopts a completed gallery image after a cold restart and acknowledges its job", async () => {
    await recoverStandaloneImageJob(completed());

    expect(mocks.register).toHaveBeenCalledWith(
      { path: "/gallery/nera.png", fileName: "nera.png", bytes: 99 },
      expect.objectContaining({ kind: "image", model: "gpt-image-2" }),
    );
    expect(invoke).toHaveBeenCalledWith("media_job_dismiss", { id: "job-1" });
  });

  it("reattaches a bible portrait once before dismissing the durable row", async () => {
    mocks.entries.mockResolvedValue([{ id: "entry-1", refs: [] }]);
    await recoverStandaloneImageJob(completed(bibleImageJobSource("entry-1", "portrait")));

    expect(mocks.addRef).toHaveBeenCalledWith({
      entryId: "entry-1",
      artifactId: "nera.png",
      role: "portrait",
      label: "portrait",
    });
    const attachedAt = mocks.addRef.mock.invocationCallOrder[0];
    const dismissedAt = vi.mocked(invoke).mock.invocationCallOrder[0];
    expect(dismissedAt).toBeGreaterThan(attachedAt);
  });

  it("does not duplicate a reference that was attached before the restart", async () => {
    mocks.entries.mockResolvedValue([
      { id: "entry-1", refs: [{ artifactId: "nera.png", role: "portrait" }] },
    ]);
    await recoverStandaloneImageJob(completed(bibleImageJobSource("entry-1", "portrait")));

    expect(mocks.addRef).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("media_job_dismiss", { id: "job-1" });
  });

  it("leaves a live image handoff to its current consumer", async () => {
    mocks.claimed.mockReturnValue(true);
    await recoverStandaloneImageJob(completed());

    expect(mocks.register).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reads the durable rows on mount and again on foreground without a poll", async () => {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "media_job_list" ? [completed()] : undefined,
    );
    const recovered = vi.fn();
    window.addEventListener(STUDIO_IMAGE_RECOVERED_EVENT, recovered);
    const stop = observeStandaloneImageJobs();
    await vi.waitFor(() => expect(recovered).toHaveBeenCalledTimes(1));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("media_job_list"));
    stop();
    window.removeEventListener(STUDIO_IMAGE_RECOVERED_EVENT, recovered);
    expect(listen).toHaveBeenCalledWith("june://media-job", expect.any(Function));
  });
});
