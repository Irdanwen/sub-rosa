import { describe, expect, it } from "vitest";
import {
  clipFade,
  clipOpacity,
  createEditorClip,
  createEditorDocument,
  durationFrames,
  hasAudioCandidates,
  duplicateClip,
  insertionTrack,
  removeClip,
  resizeClip,
  resizeClipLeft,
  setKeyframe,
  snapFrame,
  sourceFrame,
  splitClip,
  titleTrack,
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

describe("silent montage audio", () => {
  it("needs no audio processor for images or muted and hidden media", () => {
    const doc = cut();
    const video = [{ id: "take.mp4", kind: "video" as const }];
    expect(hasAudioCandidates(doc, video)).toBe(true);
    expect(hasAudioCandidates(doc, [{ id: "take.mp4", kind: "image" }])).toBe(false);
    const picture = doc.tracks.find((track) => track.id === "picture");
    if (!picture) throw new Error("Picture track missing");
    picture.muted = true;
    expect(hasAudioCandidates(doc, video)).toBe(false);
    picture.muted = false;
    picture.hidden = true;
    expect(hasAudioCandidates(doc, video)).toBe(false);
  });
});
describe("editable montage document", () => {
  it("inserts generated audio on its matching lane", () => {
    const doc = createEditorDocument();
    expect(insertionTrack(doc, "speech")?.id).toBe("dialogue");
    expect(insertionTrack(doc, "sfx")?.id).toBe("effects");
    expect(insertionTrack(doc, "music")?.id).toBe("music");
    const music = doc.tracks.find((track) => track.id === "music");
    if (music) music.locked = true;
    expect(insertionTrack(doc, "music")).toBeUndefined();
  });

  it("adds titles only to a visible unlocked overlay track", () => {
    const doc = createEditorDocument();
    doc.tracks.push({
      id: "hidden-titles",
      name: "Hidden titles",
      kind: "video",
      locked: false,
      muted: false,
      hidden: true,
    });
    expect(titleTrack(doc)).toBeUndefined();
    doc.tracks.push({
      id: "visible-titles",
      name: "Visible titles",
      kind: "video",
      locked: false,
      muted: false,
      hidden: false,
    });
    expect(titleTrack(doc)?.id).toBe("visible-titles");
  });

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
  it("matches edge trimming when duration is shortened numerically", () => {
    const doc = cut();
    doc.clips[0].fadeOut = 45;
    doc.clips[0] = setKeyframe(doc.clips[0], "opacity", 90, 0.2);
    doc.clips[0] = setKeyframe(doc.clips[0], "speed", 0, 1);
    doc.clips[0] = setKeyframe(doc.clips[0], "speed", 90, 1.5);
    const viaDuration = resizeClip(doc, "clip", 70);
    const viaEdge = trimClip(doc, "clip", 0, 70);
    expect(viaDuration).toEqual(viaEdge);
    for (let frame = 0; frame <= 70; frame++)
      expect(clipOpacity(viaDuration.clips[0], frame)).toBeCloseTo(
        clipOpacity(doc.clips[0], frame),
        8,
      );
    const extended = resizeClip(viaDuration, "clip", 90).clips[0];
    expect(extended.fadeOutOffset).toBe(30);
    expect(clipFade(extended, 90)).toBeCloseTo(clipFade(doc.clips[0], 90), 8);
    expect(clipOpacity(extended, 90)).toBeCloseTo(clipOpacity(doc.clips[0], 90), 8);
    expect(sourceFrame(extended, 90)).toBeCloseTo(sourceFrame(doc.clips[0], 90), 8);
  });
  it("restores source frames, animation and fades when either trim handle extends", () => {
    const doc = cut();
    doc.clips[0].start = 50;
    doc.clips[0].sourceDuration = 120;
    doc.clips[0].fadeIn = 30;
    doc.clips[0].fadeOut = 30;
    doc.clips[0] = setKeyframe(doc.clips[0], "opacity", 10, 0.4);
    doc.clips[0] = setKeyframe(doc.clips[0], "opacity", 100, 0.7);
    const original = doc.clips[0];
    const trimmed = trimClip(doc, "clip", 20, 90);
    const restoredLeft = resizeClipLeft(trimmed, "clip", -100);
    expect(restoredLeft.clips[0].start).toBe(50);
    expect(restoredLeft.clips[0].duration).toBe(90);
    const restored = resizeClip(restoredLeft, "clip", 200).clips[0];
    expect(restored.duration).toBe(120);
    for (let frame = 0; frame <= 120; frame += 10) {
      expect(sourceFrame(restored, frame)).toBeCloseTo(sourceFrame(original, frame), 8);
      expect(clipOpacity(restored, frame)).toBeCloseTo(clipOpacity(original, frame), 8);
    }
  });
  it("restores the source position through a speed ramp after a head trim", () => {
    const doc = cut();
    doc.clips[0].start = 40;
    doc.clips[0] = setKeyframe(doc.clips[0], "speed", 0, 0.75);
    doc.clips[0] = setKeyframe(doc.clips[0], "speed", 35, 1.5);
    doc.clips[0] = setKeyframe(doc.clips[0], "speed", 90, 0.8);
    const original = doc.clips[0];
    const trimmed = trimClip(doc, "clip", 25, 100);
    const restored = resizeClipLeft(trimmed, "clip", -25).clips[0];
    expect(restored.sourceStart).toBeCloseTo(0, 8);
    for (let frame = 0; frame <= 100; frame += 5)
      expect(sourceFrame(restored, frame)).toBeCloseTo(sourceFrame(original, frame), 8);
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
  it("renders an audio-only or hidden-picture montage before interchange export", () => {
    const audioOnly = createEditorDocument();
    audioOnly.clips = [
      createEditorClip({
        id: "score",
        trackId: "music",
        name: "Score",
        duration: 90,
        artifactId: "score.wav",
      }),
    ];
    expect(interchangeProblems(audioOnly)).toContain("No visible picture clips");
    const hiddenPicture = cut();
    const picture = hiddenPicture.tracks.find((track) => track.id === "picture");
    if (picture) picture.hidden = true;
    expect(interchangeProblems(hiddenPicture)).toContain("No visible picture clips");
  });

  it("ships hidden media and keeps dialogue, effects and music on their lanes", () => {
    const doc = cut();
    const music = doc.tracks.find((track) => track.id === "music");
    if (music) music.hidden = true;
    for (const [trackId, id] of [
      ["dialogue", "line.wav"],
      ["effects", "steps.wav"],
      ["music", "score.wav"],
    ])
      doc.clips.push(
        createEditorClip({
          id,
          trackId,
          name: id,
          duration: 60,
          sourceDuration: 120,
          artifactId: id,
        }),
      );
    const files = ["take.mp4", "line.wav", "steps.wav", "score.wav"].map((id) => ({
      id,
      path: `/gallery/${id}`,
      fileName: id,
      kind: id === "take.mp4" ? ("video" as const) : ("speech" as const),
      model: "test",
      prompt: "test",
      bytes: 1,
      createdAt: 0,
    }));
    const bundle = editorBundle(doc, files, "Film");
    expect(bundle.audio?.dialogue?.map((clip) => clip.artifact.id)).toEqual(["line.wav"]);
    expect(bundle.audio?.sfx?.map((clip) => clip.artifact.id)).toEqual(["steps.wav"]);
    expect(bundle.audio?.music).toBeUndefined();
    expect(bundle.additionalMedia).toEqual([
      "/gallery/take.mp4",
      "/gallery/line.wav",
      "/gallery/steps.wav",
      "/gallery/score.wav",
    ]);
  });
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
  it("keeps a constant volume compatible after trimming and still rejects a ramp", () => {
    const doc = cut();
    const trimmed = trimClip(doc, "clip", 0, 60);
    expect(interchangeProblems(trimmed)).not.toContain("Volume keyframes");
    doc.clips[0] = setKeyframe(doc.clips[0], "volume", 30, 0.5);
    expect(interchangeProblems(trimClip(doc, "clip", 0, 60))).toContain("Volume keyframes");
  });
});
