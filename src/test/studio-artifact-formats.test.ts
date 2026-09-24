import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (path: string) => path }));

import { artifactDataUri, artifactDataUrl } from "../lib/artifact-media";
import { listArtifacts } from "../lib/studio/artifacts";

beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
});

it("recovers a FLAC file as audio when the gallery index is gone", async () => {
  invoke.mockResolvedValue([
    { fileName: "track.flac", path: "/gallery/track.flac", bytes: 128, modifiedMs: 1 },
  ]);
  const items = await listArtifacts("music");
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "music", fileName: "track.flac" });
});

it("fills a project membership stub with legacy generation metadata", async () => {
  const legacy = {
    id: "clip.mp4",
    kind: "video",
    path: "/old/clip.mp4",
    fileName: "clip.mp4",
    bytes: 120,
    model: "legacy-model",
    prompt: "A stage",
    costCredits: 8,
    createdAt: 1,
    title: "Concert take",
    projectIds: ["original"],
  };
  localStorage.setItem("os-june:studio-gallery", JSON.stringify([legacy]));
  const stub = { id: "clip.mp4", title: "", projectIds: ["new-film"], generation: null };
  invoke.mockImplementation(async (command, args) => {
    if (command === "studio_artifact_list") return [stub];
    if (command === "studio_artifact_save")
      return {
        ...stub,
        title: args.request.title,
        projectIds: args.request.projectIds,
        generation: args.request.generation,
      };
    if (command === "carpe_diem_media_list_artifacts")
      return [{ fileName: "clip.mp4", path: "/gallery/clip.mp4", bytes: 120 }];
    throw new Error(`Unexpected command: ${command}`);
  });

  const [artifact] = await listArtifacts();
  expect(invoke).toHaveBeenCalledWith("studio_artifact_save", {
    request: expect.objectContaining({
      id: "clip.mp4",
      title: "Concert take",
      projectIds: ["new-film"],
      generation: expect.objectContaining({ model: "legacy-model", prompt: "A stage" }),
    }),
  });
  expect(artifact).toMatchObject({
    title: "Concert take",
    projectIds: ["new-film"],
    model: "legacy-model",
    prompt: "A stage",
    path: "/gallery/clip.mp4",
  });
});

it("does not restore deleted prompts from the local cache after a crash", async () => {
  localStorage.setItem(
    "os-june:studio-gallery",
    JSON.stringify([
      {
        id: "deleted.mp4",
        fileName: "deleted.mp4",
        path: "/gallery/deleted.mp4",
        kind: "video",
        model: "model",
        prompt: "private scene",
        createdAt: 1,
      },
    ]),
  );
  invoke.mockImplementation(async (command) => {
    if (command === "carpe_diem_media_list_artifacts") return [];
    if (command === "studio_artifact_list") return [];
    throw new Error(`Unexpected command: ${command}`);
  });

  expect(await listArtifacts()).toEqual([]);
  expect(invoke).not.toHaveBeenCalledWith("studio_artifact_save", expect.anything());
});

it("gives mobile FLAC playback a typed blob and model inputs a typed data URI", async () => {
  invoke.mockResolvedValue("ZkxhQw==");
  const create = vi.fn<(blob: Blob) => string>().mockReturnValue("blob:flac-playback");
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = create;
    },
  );
  try {
    const artifact = { path: "/gallery/playback.flac" };
    expect(await artifactDataUrl(artifact)).toBe("blob:flac-playback");
    expect(create.mock.calls[0][0]).toMatchObject({ type: "audio/flac" });
    expect(await artifactDataUri(artifact)).toBe("data:audio/flac;base64,ZkxhQw==");
  } finally {
    vi.unstubAllGlobals();
  }
});
