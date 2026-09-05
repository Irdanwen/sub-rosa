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
