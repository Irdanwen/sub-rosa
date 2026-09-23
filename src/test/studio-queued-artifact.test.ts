import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { rememberQueuedImage, saveArtifactFromBase64 } from "../lib/studio/artifacts";

const metadata = { kind: "image" as const, model: "gpt-image-2", prompt: "A concert" };

beforeEach(() => {
  localStorage.clear();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
});

describe("queued image gallery handoff", () => {
  it("registers the native file and dismisses its job without saving a duplicate", async () => {
    rememberQueuedImage(
      "QUEUED-IMAGE",
      { path: "/gallery/result.png", fileName: "result.png", bytes: 42 },
      "job-1",
    );

    const artifact = await saveArtifactFromBase64("QUEUED-IMAGE", "png", metadata);

    expect(artifact).toMatchObject({
      id: "result.png",
      path: "/gallery/result.png",
      model: "gpt-image-2",
      prompt: "A concert",
    });
    expect(invoke).not.toHaveBeenCalledWith("carpe_diem_media_save_artifact", expect.anything());
    expect(invoke).toHaveBeenCalledWith("studio_artifact_save", {
      request: expect.objectContaining({ id: "result.png" }),
    });
    expect(invoke).toHaveBeenCalledWith("media_job_dismiss", { id: "job-1" });
  });

  it("still saves ordinary synchronous image results", async () => {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "carpe_diem_media_save_artifact"
        ? { path: "/gallery/sync.png", fileName: "sync.png", bytes: 7 }
        : undefined,
    );

    await saveArtifactFromBase64("SYNC-IMAGE", "png", metadata);

    expect(invoke).toHaveBeenCalledWith("carpe_diem_media_save_artifact", {
      request: { base64: "SYNC-IMAGE", extension: "png" },
    });
    expect(invoke).not.toHaveBeenCalledWith("media_job_dismiss", expect.anything());
  });

  it("keeps distinct native files when two jobs return identical image bytes", async () => {
    rememberQueuedImage("SAME-IMAGE", { path: "/gallery/a.png", fileName: "a.png", bytes: 4 }, "a");
    rememberQueuedImage("SAME-IMAGE", { path: "/gallery/b.png", fileName: "b.png", bytes: 4 }, "b");

    const first = await saveArtifactFromBase64("SAME-IMAGE", "png", metadata);
    const second = await saveArtifactFromBase64("SAME-IMAGE", "png", metadata);

    expect([first.id, second.id]).toEqual(["a.png", "b.png"]);
    expect(invoke).toHaveBeenCalledWith("media_job_dismiss", { id: "a" });
    expect(invoke).toHaveBeenCalledWith("media_job_dismiss", { id: "b" });
    expect(invoke).not.toHaveBeenCalledWith("carpe_diem_media_save_artifact", expect.anything());
  });
});
