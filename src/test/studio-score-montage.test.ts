import { describe, expect, it } from "vitest";
import { createEditorClip, createEditorDocument, fps } from "../lib/studio/editor/document";
import { dialogueDuck, ducksUnderDialogue, gainAt } from "../lib/studio/editor/duck";
import { DUCK_GAIN } from "../lib/studio/mix";
import { newShot, type ProjectShot } from "../lib/studio/projects";
import { newCue, type ProjectScore } from "../lib/studio/score";
import { placeScore } from "../lib/studio/score-montage";

function shot(id: string, takes: string[]): ProjectShot {
  return { ...newShot(0), id, takeIds: takes, activeTakeId: takes[0] };
}

const rate = fps(createEditorDocument());

function montage() {
  const timeline = createEditorDocument();
  const picture = (artifactId: string, start: number, seconds: number) =>
    createEditorClip({
      trackId: "picture",
      name: artifactId,
      artifactId,
      start: start * rate,
      duration: seconds * rate,
    });
  timeline.clips = [picture("a1", 0, 5), picture("b2", 5, 5), picture("c1", 10, 8)];
  return timeline;
}

const shots = [shot("a", ["a1"]), shot("b", ["b1", "b2"]), shot("c", ["c1"]), shot("d", ["d1"])];

describe("placing the score in the montage", () => {
  const score: ProjectScore = {
    mode: "cues",
    identity: "",
    cues: [
      { ...newCue("a", "b", "Opening"), takeIds: ["m1"], activeTakeId: "m1" },
      { ...newCue("c", "c", "Chase"), takeIds: ["m2"], activeTakeId: "m2" },
      { ...newCue("d", "d", "Coda"), takeIds: ["m3"], activeTakeId: "m3" },
    ],
  };

  it("starts each cue at its first shot's clip, whichever take the cut used, and trims it", () => {
    const { timeline, placed, unplaced } = placeScore(montage(), shots, score, () => 60);
    const music = timeline.clips.filter((clip) => clip.trackId === "music");
    expect(placed).toBe(2);
    expect(unplaced).toEqual(["Coda"]);
    expect(music[0]).toMatchObject({ artifactId: "m1", start: 0, duration: 12 * rate });
    expect(music[0].fadeIn).toBe(Math.round(0.5 * rate));
    expect(music[0].fadeOut).toBe(Math.round(1.5 * rate));
    expect(music[1]).toMatchObject({ artifactId: "m2", start: 10 * rate, duration: 10 * rate });
    expect(music[1].sourceDuration).toBe(60 * rate);
  });

  it("stops where a short piece runs out, and replaces its own earlier placement", () => {
    const once = placeScore(montage(), shots, score, () => 4).timeline;
    const twice = placeScore(once, shots, score, () => 4).timeline;
    const music = twice.clips.filter((clip) => clip.trackId === "music");
    expect(music).toHaveLength(2);
    expect(music[0].duration).toBe(4 * rate);
  });

  it("refuses a locked music track", () => {
    const timeline = montage();
    timeline.tracks = timeline.tracks.map((track) =>
      track.id === "music" ? { ...track, locked: true } : track,
    );
    expect(() => placeScore(timeline, shots, score, () => 60)).toThrow();
  });
});

describe("ducking in the montage", () => {
  it("dips the music track, and only it, under a line on the dialogue track", () => {
    const timeline = montage();
    const line = createEditorClip({
      trackId: "dialogue",
      name: "line",
      artifactId: "l1",
      start: 4 * rate,
      duration: 2 * rate,
    });
    const cue = createEditorClip({
      trackId: "music",
      name: "cue",
      artifactId: "m1",
      duration: 480,
    });
    timeline.clips.push(line, cue);
    const duck = dialogueDuck(timeline);
    expect(duck(cue, 0)).toBe(1);
    expect(duck(cue, 5 * rate)).toBe(DUCK_GAIN);
    expect(duck(cue, 10 * rate)).toBe(1);
    expect(duck(timeline.clips[0], 5 * rate)).toBe(1);
  });

  it("follows the track's choice", () => {
    const [picture, dialogue, effects, music] = createEditorDocument().tracks;
    expect(ducksUnderDialogue(music)).toBe(true);
    expect(ducksUnderDialogue({ ...music, duckUnderDialogue: false })).toBe(false);
    expect(ducksUnderDialogue(effects)).toBe(false);
    expect(ducksUnderDialogue(picture)).toBe(false);
    expect(ducksUnderDialogue(dialogue)).toBe(false);
  });

  it("interpolates between stops", () => {
    const stops = [
      { atSeconds: 0, gain: 1 },
      { atSeconds: 2, gain: 0.5 },
    ];
    expect(gainAt(stops, 1)).toBeCloseTo(0.75);
    expect(gainAt(stops, 5)).toBe(0.5);
    expect(gainAt([], 3)).toBe(1);
  });
});
