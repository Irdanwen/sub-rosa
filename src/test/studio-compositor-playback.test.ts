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

  it("waits for a trimmed clip to decode before uploading its export frame", async () => {
    const video = document.createElement("video");
    let currentTime = 0;
    let completeSeek = () => {};
    Object.defineProperties(video, {
      currentTime: {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => {
          currentTime = value;
          completeSeek = () => video.dispatchEvent(new Event("seeked"));
        },
      },
      duration: { configurable: true, get: () => 10 },
      videoWidth: { configurable: true, get: () => 1920 },
      videoHeight: { configurable: true, get: () => 1080 },
    });
    video.play = vi.fn().mockResolvedValue(undefined);
    video.pause = vi.fn();
    const texImage2D = vi.fn();
    const gl = Object.fromEntries(
      [
        "viewport",
        "clearColor",
        "clear",
        "useProgram",
        "activeTexture",
        "bindTexture",
        "texParameteri",
        "getUniformLocation",
        "uniform2f",
        "uniform1f",
        "uniform4f",
        "uniform1i",
        "drawArrays",
      ].map((method) => [method, vi.fn()]),
    );
    const compositor = Object.create(EditorCompositor.prototype) as EditorCompositor;
    Object.assign(compositor, {
      canvas: document.createElement("canvas"),
      gl: { ...gl, texImage2D },
      program: {},
      curveTexture: {},
      lutTexture: {},
      sources: new Map([["clip", { element: video, texture: {} }]]),
      activeClips: new Set<string>(),
      curveCache: "",
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

    const onWait = vi.fn(async (_waiting: boolean) => {});
    const drawing = compositor.drawRecorded(doc, 30, onWait);
    await Promise.resolve();
    expect(currentTime).toBeCloseTo(3 / 30);
    expect(onWait).toHaveBeenCalledWith(true);
    expect(texImage2D).not.toHaveBeenCalled();
    expect(video.play).not.toHaveBeenCalled();
    completeSeek();
    await drawing;

    expect(texImage2D).toHaveBeenCalledWith(undefined, 0, undefined, undefined, undefined, video);
    expect(video.play).toHaveBeenCalledOnce();
    expect(onWait).toHaveBeenLastCalledWith(false);

    // A clip starting at zero already has its first frame from loadeddata;
    // assigning currentTime = 0 need not emit a seeked event.
    currentTime = 0;
    doc.clips[0].sourceStart = 0;
    compositor.pause();
    texImage2D.mockClear();
    await compositor.drawRecorded(doc, 30);
    expect(texImage2D).toHaveBeenCalledWith(undefined, 0, undefined, undefined, undefined, video);

    // Prime a later cut before recording starts so the cut itself needs no seek.
    currentTime = 0;
    doc.clips[0].sourceStart = 6;
    compositor.pause();
    const prepared = compositor.prepareRecordCuts(doc);
    expect(currentTime).toBeCloseTo(6 / 30);
    completeSeek();
    await prepared;
    onWait.mockClear();
    await compositor.drawRecorded(doc, 30, onWait);
    expect(onWait).not.toHaveBeenCalled();
  });
});
