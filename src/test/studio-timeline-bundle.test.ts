import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioArtifact } from "../lib/studio/types";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { bundleCut, MEDIA_SUBDIR, writeTimelineBundle } from "../lib/studio/timeline/bundle";

function artifact(fileName: string, path = `/gallery/${fileName}`): StudioArtifact {
  return {
    id: fileName,
    kind: "video",
    path,
    fileName,
    bytes: 1,
    model: "seedance",
    prompt: "a shot",
    createdAt: 0,
  };
}

function clip(fileName: string, over: Record<string, unknown> = {}) {
  return {
    artifact: artifact(fileName),
    name: fileName,
    inSeconds: 0,
    outSeconds: 4,
    sourceDurationSeconds: 5,
    hasAudio: true,
    ...over,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({
    directory: "/out/Film.timeline",
    documentPath: "x",
    mediaCount: 1,
  });
});

describe("bundleCut", () => {
  it("points the document at the copies, not at the gallery", () => {
    // Rust picks the final folder (it refuses to overwrite an earlier export),
    // so the document cannot contain an absolute path even in principle.
    const { cut, media } = bundleCut({ name: "Film", clips: [clip("one.mp4")] });
    expect(cut.clips[0]?.href).toBe(`${MEDIA_SUBDIR}/one.mp4`);
    expect(media).toEqual(["/gallery/one.mp4"]);
  });

  it("encodes a file name that is not URL-safe", () => {
    const { cut } = bundleCut({
      name: "Film",
      clips: [clip("a b&c.mp4", { artifact: artifact("a b&c.mp4") })],
    });
    expect(cut.clips[0]?.href).toBe(`${MEDIA_SUBDIR}/a%20b%26c.mp4`);
  });

  it("copies a clip used twice only once", () => {
    const { media } = bundleCut({
      name: "Film",
      clips: [clip("one.mp4"), clip("one.mp4", { inSeconds: 4, outSeconds: 5 })],
    });
    expect(media).toEqual(["/gallery/one.mp4"]);
  });

  it("carries the sound files too, and drops an empty lane", () => {
    const { cut, media } = bundleCut({
      name: "Film",
      clips: [clip("one.mp4")],
      audio: {
        dialogue: [],
        music: [
          {
            artifact: artifact("score.mp3", "/gallery/score.mp3"),
            name: "Score",
            inSeconds: 0,
            outSeconds: 4,
            sourceDurationSeconds: 30,
            atSeconds: 0,
            gain: 0.4,
          },
        ],
      },
    });
    expect(Object.keys(cut.audio ?? {})).toEqual(["music"]);
    expect(media).toEqual(["/gallery/one.mp4", "/gallery/score.mp3"]);
  });

  it("defaults a frame rate and a frame size rather than writing zeroes", () => {
    const { cut } = bundleCut({ name: "Film", clips: [clip("one.mp4")] });
    expect(cut.frameRate).toEqual({ base: 30, ntsc: false });
    expect(cut.width).toBe(1920);
    expect(cut.height).toBe(1080);
  });
});

describe("writeTimelineBundle", () => {
  it("hands Rust the finished document, its extension and the files to copy", async () => {
    await writeTimelineBundle({ name: "Film", clips: [clip("one.mp4")] }, "fcpxml", "/out");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, payload] = invokeMock.mock.calls[0] as [
      string,
      { request: Record<string, unknown> },
    ];
    expect(command).toBe("export_timeline_bundle");
    expect(payload.request).toMatchObject({
      directory: "/out",
      name: "Film",
      extension: "fcpxml",
      media: ["/gallery/one.mp4"],
    });
    expect(String(payload.request.document)).toContain("<fcpxml");
    expect(payload.request.subtitles).toBeUndefined();
  });

  it("writes the Premiere dialect with its own extension", async () => {
    await writeTimelineBundle({ name: "Film", clips: [clip("one.mp4")] }, "xmeml", "/out");
    const [, payload] = invokeMock.mock.calls[0] as [string, { request: Record<string, unknown> }];
    expect(payload.request.extension).toBe("xml");
    expect(String(payload.request.document)).toContain("<xmeml");
  });

  it("attaches subtitles only when there are some", async () => {
    await writeTimelineBundle(
      {
        name: "Film",
        clips: [clip("one.mp4")],
        subtitles: [{ atSeconds: 0, untilSeconds: 1, text: "Hello" }],
      },
      "fcpxml",
      "/out",
    );
    const [, payload] = invokeMock.mock.calls[0] as [string, { request: Record<string, unknown> }];
    expect(String(payload.request.subtitles)).toContain("00:00:00,000 --> 00:00:01,000");
  });

  it("refuses before writing anything when the cut is not exportable", async () => {
    // The whole point of failing here: a half-written bundle is worse than none.
    await expect(
      writeTimelineBundle(
        { name: "Film", clips: [clip("one.mp4", { sourceDurationSeconds: Number.NaN })] },
        "fcpxml",
        "/out",
      ),
    ).rejects.toThrow(/no measured duration/);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
