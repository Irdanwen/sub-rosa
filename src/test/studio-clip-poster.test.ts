/**
 * Clip tiles on iOS.
 *
 * WKWebView paints no first frame for a `<video>` without a `poster`, so a
 * gallery tile that renders the media element shows an empty square whatever
 * the generation produced. These cover the answer: the tile gets a still that
 * was decoded here, and the clip's bytes are read once and let go of.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioArtifact } from "../lib/studio/types";

const media = vi.hoisted(() => ({
  readBase64: vi.fn(),
  extract: vi.fn(),
  poster: vi.fn(),
  invoke: vi.fn(),
  duration: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: media.invoke,
  convertFileSrc: (path: string) => path,
}));

vi.mock("../lib/studio/artifacts", () => ({
  artifactSrc: (artifact: { path: string }) => `asset://${artifact.path}`,
  listArtifacts: vi.fn(),
  readArtifactBase64: media.readBase64,
}));
vi.mock("../lib/studio/frames", () => ({
  extractFrameAt: media.extract,
  mediaDuration: media.duration,
}));
vi.mock("../lib/studio/downscale", () => ({
  // The real ones need a canvas; what matters here is that the poster, not the
  // clip, is what gets downscaled into the tile.
  makeThumbnail: (dataUrl: string) => Promise.resolve(`${dataUrl}#thumb`),
  posterJpeg: media.poster,
}));

const CLIP: StudioArtifact = {
  id: "clip-1.mp4",
  kind: "video",
  path: "/gallery/clip-1.mp4",
  fileName: "clip-1.mp4",
  bytes: 1024,
  model: "seedance-2-0-text-to-video",
  prompt: "A tram crossing a bridge at dusk",
  createdAt: 0,
};

const objectUrls = { created: [] as string[], revoked: [] as string[] };

beforeEach(() => {
  objectUrls.created = [];
  objectUrls.revoked = [];
  let next = 0;
  URL.createObjectURL = vi.fn(() => {
    next += 1;
    const url = `blob:clip-${next}`;
    objectUrls.created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    objectUrls.revoked.push(url);
  });
  media.readBase64.mockReset().mockResolvedValue("AAAA");
  media.invoke.mockReset().mockResolvedValue(undefined);
  media.duration.mockReset().mockResolvedValue(5.2);
  media.poster
    .mockReset()
    .mockImplementation((src: string) =>
      Promise.resolve({ dataUrl: `${src}#poster`, width: 1280, height: 720 }),
    );
  media.extract.mockReset().mockResolvedValue({
    dataUrl: "data:image/jpeg;base64,frame",
    timeSeconds: 0.2,
    durationSeconds: 5.2,
    sharpness: 12,
    width: 1280,
    height: 720,
  });
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("clip posters", () => {
  it("gives a clip a still painted off the stream, and files it once", async () => {
    const { artifactThumbnail } = await import("../lib/artifact-media");

    const thumbnail = await artifactThumbnail(CLIP);

    expect(thumbnail).toEqual({
      src: "subrosa-media://localhost/clip-1.mp4#poster",
      kind: "still",
      durationSeconds: 5.2,
    });
    // Painted by WebKit from the stream: no frame decode, no base64 copy.
    expect(media.poster).toHaveBeenCalledWith("subrosa-media://localhost/clip-1.mp4");
    expect(media.extract).not.toHaveBeenCalled();
    expect(media.readBase64).not.toHaveBeenCalled();
    // Filed, with what was learned, so the next launch decodes nothing.
    await vi.waitFor(() =>
      expect(media.invoke).toHaveBeenCalledWith("studio_artifact_measure", {
        id: "clip-1.mp4",
        measures: { posterVersion: 1, width: 1280, height: 720, durationMs: 5200 },
      }),
    );
    expect(media.invoke).toHaveBeenCalledWith("carpe_diem_media_save_poster", {
      request: { id: "clip-1.mp4", base64: "subrosa-media://localhost/clip-1.mp4#poster" },
    });
  });

  it("paints a clip once for two tiles, and not at all for a third", async () => {
    const { artifactThumbnail } = await import("../lib/artifact-media");

    const [first, second] = await Promise.all([artifactThumbnail(CLIP), artifactThumbnail(CLIP)]);
    const third = await artifactThumbnail(CLIP);

    expect(media.poster).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(third.kind).toBe("still");
    expect(third.durationSeconds).toBe(5.2);
  });

  it("paints a filed poster straight from disk, decoding nothing", async () => {
    const { artifactThumbnail } = await import("../lib/artifact-media");

    const thumbnail = await artifactThumbnail({ ...CLIP, posterVersion: 1, durationMs: 7300 });

    expect(thumbnail).toEqual({
      src: "subrosa-media://localhost/poster/clip-1.mp4?v=1",
      kind: "still",
      durationSeconds: 7.3,
    });
    expect(media.extract).not.toHaveBeenCalled();
  });

  it("decodes a frame when the shell cannot paint the clip as an image", async () => {
    media.poster.mockImplementation((src: string) =>
      src.endsWith(".mp4")
        ? Promise.reject(new Error("The image could not be decoded."))
        : Promise.resolve({ dataUrl: `${src}#poster`, width: 1280, height: 720 }),
    );
    const { artifactThumbnail } = await import("../lib/artifact-media");

    const thumbnail = await artifactThumbnail(CLIP);

    expect(thumbnail.kind).toBe("still");
    expect(media.extract).toHaveBeenCalledWith("subrosa-media://localhost/clip-1.mp4", 0.2);
    expect(media.readBase64).not.toHaveBeenCalled();
  });

  it("reads the whole clip only when the stream gives no frame", async () => {
    media.poster.mockImplementation((src: string) =>
      src.endsWith(".mp4")
        ? Promise.reject(new Error("The image could not be decoded."))
        : Promise.resolve({ dataUrl: `${src}#poster`, width: 1280, height: 720 }),
    );
    media.extract
      .mockRejectedValueOnce(new Error("That clip decoded no picture at that position."))
      .mockResolvedValueOnce({
        dataUrl: "data:image/jpeg;base64,frame",
        timeSeconds: 0.2,
        durationSeconds: 5.2,
        sharpness: 12,
        width: 1280,
        height: 720,
      });
    const { artifactThumbnail } = await import("../lib/artifact-media");

    const thumbnail = await artifactThumbnail(CLIP);

    expect(thumbnail.kind).toBe("still");
    expect(media.readBase64).toHaveBeenCalledTimes(1);
    // That copy is a throwaway object URL, let go of once the frame is out.
    expect(objectUrls.revoked).toEqual(objectUrls.created);
  });

  it("falls back to the clip itself when no frame decodes at all", async () => {
    media.poster.mockRejectedValue(new Error("The image could not be decoded."));
    media.extract.mockRejectedValue(new Error("That clip decoded no picture at that position."));
    const { artifactThumbnail } = await import("../lib/artifact-media");

    const thumbnail = await artifactThumbnail(CLIP);

    // The tile still has to be reachable and deletable, so it keeps the media
    // element it always had rather than resolving to nothing - streamed, not
    // copied whole into a blob.
    expect(thumbnail.kind).toBe("media");
    expect(thumbnail.src).toBe("subrosa-media://localhost/clip-1.mp4");
  });

  it("gives a picture its poster off the stream too", async () => {
    const { artifactThumbnail } = await import("../lib/artifact-media");

    const thumbnail = await artifactThumbnail({ ...CLIP, kind: "image", path: "/gallery/a.png" });

    expect(media.extract).not.toHaveBeenCalled();
    expect(media.readBase64).not.toHaveBeenCalled();
    expect(thumbnail).toEqual({
      src: "subrosa-media://localhost/a.png#poster",
      kind: "still",
      durationSeconds: undefined,
    });
  });

  it("never revokes a URL that a player is still holding", async () => {
    const { artifactDataUrl, usePlayableMediaUrl } = await import("../lib/artifact-media");
    const { renderHook, waitFor, act } = await import("@testing-library/react");
    const mobile = await import("../lib/mobile");
    vi.spyOn(mobile, "isMobilePlatform").mockReturnValue(true);

    const { result } = renderHook(() => usePlayableMediaUrl(CLIP));
    expect(result.current.src).toBe("subrosa-media://localhost/clip-1.mp4");
    // The element could not stream it: the bytes come over IPC into a blob.
    act(() => result.current.onError());
    await waitFor(() => expect(result.current.src).toMatch(/^blob:/));
    const playing = result.current.src;

    // A gallery keeps loading behind the viewer: far more than the cache holds.
    for (let index = 0; index < 40; index += 1) {
      await artifactDataUrl({ path: `/gallery/other-${index}.mp4` });
    }

    expect(objectUrls.revoked).not.toContain(playing);
    expect(objectUrls.revoked.length).toBeGreaterThan(0);
  });
});
