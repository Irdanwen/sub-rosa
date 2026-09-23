import { describe, expect, it, vi } from "vitest";
import { EditorCompositor } from "../lib/studio/editor/compositor";
import { createEditorClip, createEditorDocument } from "../lib/studio/editor/document";

describe("montage playback", () => {
  it("seeks a newly active video past a short head trim", () => {
    const video = document.createElement("video");
    let currentTime = 0;
    Object.defineProperties(video, {
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => {
          currentTime = value;
        },
      },
      duration: { configurable: true, get: () => 10 },
    });
    video.play = vi.fn().mockResolvedValue(undefined);
    video.pause = vi.fn();
    const compositor = Object.create(EditorCompositor.prototype) as EditorCompositor;
    Object.assign(compositor, {
      canvas: document.createElement("canvas"),
      gl: {
        viewport: vi.fn(),
        clearColor: vi.fn(),
        clear: vi.fn(),
        useProgram: vi.fn(),
      },
      program: {},
      sources: new Map([["clip", { element: video, texture: {} }]]),
      activeClips: new Set<string>(),
      disposed: false,
    });
    const doc = createEditorDocument();
    doc.clips = [
      createEditorClip({
        id: "clip",
        trackId: "picture",
        name: "Trimmed take",
        start: 30,
        duration: 30,
        sourceStart: 3,
        sourceDuration: 300,
        artifactId: "take.mp4",
      }),
    ];

    compositor.draw(doc, 29, true);
    compositor.draw(doc, 30, true);

    expect(currentTime).toBeCloseTo(3 / 30);
  });
});
