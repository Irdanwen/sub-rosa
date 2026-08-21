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

const media = vi.hoisted(() => ({ readBase64: vi.fn(), extract: vi.fn() }));

vi.mock("../lib/studio/artifacts", () => ({
  artifactSrc: (artifact: { path: string }) => `asset://${artifact.path}`,
  listArtifacts: vi.fn(),
  readArtifactBase64: media.readBase64,
}));
vi.mock("../lib/studio/frames", () => ({ extractFrameAt: media.extract }));
vi.mock("../lib/studio/downscale", () => ({
  // The real one needs a canvas; what matters here is that the poster, not the
  // clip, is what gets downscaled into the tile.
  makeThumbnail: (dataUrl: string) => Promise.resolve(`${dataUrl}#thumb`),
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
  it("gives a clip a still to paint, and its length with it", async () => {
    const { artifactThumbnail } = await import("../lib/artifact-media");

    const thumbnail = await artifactThumbnail(CLIP);

    expect(thumbnail).toEqual({
      src: "data:image/jpeg;base64,frame#thumb",
      kind: "still",
      durationSeconds: 5.2,
    });
    // Read from a throwaway object URL that does not outlive the decode: the
    // full-size cache evicts by revoking, and a poster read must not take the
    // URL the lightbox is playing from with it.
    expect(objectUrls.revoked).toEqual(objectUrls.created);
  });

  it("reads the clip once for two tiles, and not at all for a third", async () => {
    const { artifactThumbnail } = await import("../lib/artifact-media");

    const [first, second] = await Promise.all([artifactThumbnail(CLIP), artifactThumbnail(CLIP)]);
    const third = await artifactThumbnail(CLIP);

    expect(media.readBase64).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(third.kind).toBe("still");
    expect(third.durationSeconds).toBe(5.2);
  });

  it("falls back to the clip itself when no frame decodes", async () => {
    media.extract.mockRejectedValue(new Error("That clip decoded no picture at that position."));
    const { artifactThumbnail } = await import("../lib/artifact-media");

    const thumbnail = await artifactThumbnail(CLIP);

    // The tile still has to be reachable and deletable, so it keeps the media
    // element it always had rather than resolving to nothing.
    expect(thumbnail.kind).toBe("media");
    expect(thumbnail.src).toMatch(/^blob:/);
  });

  it("leaves images on the downscale path", async () => {
    const { artifactThumbnail } = await import("../lib/artifact-media");

    const thumbnail = await artifactThumbnail({ ...CLIP, kind: "image", path: "/gallery/a.png" });

    expect(media.extract).not.toHaveBeenCalled();
    expect(thumbnail).toEqual({
      src: "data:image/png;base64,AAAA#thumb",
      kind: "still",
      durationSeconds: undefined,
    });
  });
});
