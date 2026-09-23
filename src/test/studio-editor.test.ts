import { describe, expect, it } from "vitest";
import {
  clipOpacity,
  createEditorClip,
  createEditorDocument,
  durationFrames,
  duplicateClip,
  removeClip,
  setKeyframe,
  snapFrame,
  sourceFrame,
  splitClip,
  trimClip,
  validateEditorDocument,
  valueAt,
} from "../lib/studio/editor/document";
import { interchangeProblems, editorBundle } from "../lib/studio/editor/interchange";
import { parseCube } from "../lib/studio/editor/lut";

function cut() {
  const doc = createEditorDocument();
  doc.clips = [
    createEditorClip({
      id: "clip",
      trackId: "picture",
      name: "Take",
      duration: 120,
      sourceDuration: 600,
      artifactId: "take.mp4",
    }),
  ];
  return doc;
}
describe("editable montage document", () => {
  it("integrates a speed ramp, and preserves the source on both sides of a split", () => {
    const doc = cut();
    doc.clips[0] = setKeyframe(doc.clips[0], "speed", 100, 3);
    expect(sourceFrame(doc.clips[0], 100)).toBe(200);
    const split = splitClip(doc, "clip", 50);
    expect(split.clips).toHaveLength(2);
    for (let frame = 0; frame < 70; frame++)
      expect(sourceFrame(split.clips[1], frame)).toBeCloseTo(
        sourceFrame(doc.clips[0], frame + 50),
        8,
      );
    expect(durationFrames(split)).toBe(120);
  });
  it("trims picture, sound and keyframes against one source mapping", () => {
    const doc = cut();
    doc.clips[0] = setKeyframe(doc.clips[0], "x", 100, 200);
    doc.clips[0] = setKeyframe(doc.clips[0], "speed", 100, 2);
    const trimmed = trimClip(doc, "clip", 25, 95).clips[0];
    expect(trimmed.start).toBe(25);
    expect(trimmed.duration).toBe(70);
    expect(valueAt(trimmed.properties.x, 0)).toBe(50);
    for (let f = 0; f <= 70; f++)
      expect(sourceFrame(trimmed, f)).toBeCloseTo(sourceFrame(doc.clips[0], f + 25), 8);
  });
  it("preserves opacity through trimmed and split fades", () => {
    const doc = cut();
    doc.clips[0].fadeIn = 40;
    doc.clips[0].fadeOut = 35;
    const original = doc.clips[0];
    const trimmed = trimClip(doc, "clip", 25, 105).clips[0];
    for (let frame = 0; frame <= trimmed.duration; frame++)
      expect(clipOpacity(trimmed, frame)).toBeCloseTo(clipOpacity(original, frame + 25), 8);
    const split = splitClip(doc, "clip", 30);
    for (let frame = 0; frame <= split.clips[0].duration; frame++)
      expect(clipOpacity(split.clips[0], frame)).toBeCloseTo(clipOpacity(original, frame), 8);
    for (let frame = 0; frame <= split.clips[1].duration; frame++)
      expect(clipOpacity(split.clips[1], frame)).toBeCloseTo(clipOpacity(original, frame + 30), 8);
  });
  it("respects locked tracks for split, trim, duplicate and delete", () => {
    const doc = cut();
    doc.tracks[0].locked = true;
    expect(splitClip(doc, "clip", 20)).toBe(doc);
    expect(trimClip(doc, "clip", 20, 70)).toBe(doc);
    expect(duplicateClip(doc, "clip")).toBe(doc);
    expect(removeClip(doc, "clip", true)).toBe(doc);
  });
  it("ripple deletes only subsequent clips on the selected track", () => {
    const doc = cut();
    doc.clips.push(
      createEditorClip({
        id: "later",
        trackId: "picture",
        name: "Later",
        start: 120,
        duration: 30,
      }),
      createEditorClip({
        id: "sound",
        trackId: "dialogue",
        name: "Sound",
        start: 120,
        duration: 30,
      }),
    );
    const next = removeClip(doc, "clip", true);
    expect(next.clips.find((c) => c.id === "later")?.start).toBe(0);
    expect(next.clips.find((c) => c.id === "sound")?.start).toBe(120);
  });
  it("snaps to the nearest external edge, with a bounded threshold", () => {
    const doc = cut();
    expect(snapFrame(doc, 118, "other", 4)).toBe(120);
    expect(snapFrame(doc, 6, "other", 4)).toBe(6);
    expect(snapFrame(doc, 118, "clip", 4)).toBe(118);
  });
  it("reports speed that reads beyond the source instead of freezing the last frame", () => {
    const doc = cut();
    doc.clips[0].sourceDuration = 120;
    doc.clips[0] = setKeyframe(doc.clips[0], "speed", 0, 2);
    expect(validateEditorDocument(doc)).toHaveLength(1);
  });
  it("round-trips the complete document through JSON", () => {
    const doc = cut();
    doc.frameRate = { base: 30, ntsc: true };
    doc.clips[0] = setKeyframe(doc.clips[0], "opacity", 90, 0.2);
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });
});
describe("cube LUT input", () => {
  const identity = "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1";
  it("retains red-fastest coordinates and custom input domain", () => {
    const lut = parseCube(
      `TITLE "Identity"\nDOMAIN_MIN -1 -1 -1\nDOMAIN_MAX 2 2 2\n${identity}`,
      "test.cube",
    );
    expect(lut.size).toBe(2);
    expect(lut.values.slice(3, 6)).toEqual([1, 0, 0]);
    expect(lut.domainMin).toEqual([-1, -1, -1]);
  });
  it("rejects incomplete, non-finite, oversized and inverted-domain LUTs", () => {
    for (const text of [
      identity.replace("1 1 1", ""),
      identity.replace("1 1 1", "NaN 0 1"),
      identity.replace("SIZE 2", "SIZE 999"),
      `DOMAIN_MAX -1 -1 -1\n${identity}`,
    ])
      expect(() => parseCube(text, "bad")).toThrow();
  });
});
describe("editable interchange", () => {
  it("lists richer operations and refuses a lossy export", () => {
    const doc = cut();
    doc.clips[0].grade.exposure = 1;
    doc.clips[0].fadeIn = 10;
    expect(interchangeProblems(doc)).toHaveLength(2);
    expect(() => editorBundle(doc, [], "Film")).toThrow();
  });
  it("keeps source trims and rational timebase for compatible cuts", () => {
    const doc = cut();
    doc.frameRate = { base: 30, ntsc: true };
    doc.clips[0].sourceStart = 30;
    const bundle = editorBundle(
      doc,
      [
        {
          id: "take.mp4",
          path: "/tmp/take.mp4",
          fileName: "take.mp4",
          kind: "video",
          model: "",
          prompt: "",
          bytes: 1,
          createdAt: 0,
        },
      ],
      "Film",
    );
    expect(bundle.frameRate).toEqual({ base: 30, ntsc: true });
    expect(bundle.clips[0].inSeconds).toBeCloseTo(1.001);
  });
});
