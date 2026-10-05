import { describe, expect, it } from "vitest";
import { createEditorClip, createEditorDocument, fps } from "../lib/studio/editor/document";
import { dialogueDuck } from "../lib/studio/editor/duck";
import { appendTakes } from "../lib/studio/project-montage";

const take = (artifactId: string, over = {}) => ({
  title: artifactId,
  artifactId,
  seconds: 4,
  ...over,
});

describe("placing takes in the montage", () => {
  it("joins shots the way their transition asks, in the montage rather than the prompt", () => {
    const timeline = appendTakes(createEditorDocument(), [
      take("a"),
      take("b", { transition: "fade-black" }),
      take("c", { transition: "hard-cut" }),
    ]);
    const rate = fps(timeline);
    const [a, b, c] = timeline.clips;
    expect(a.fadeOut).toBe(rate);
    expect(b.fadeIn).toBe(rate);
    expect(b.fadeOut).toBe(0);
    expect(c.fadeIn).toBe(0);
    expect(b.start).toBe(a.duration);
  });

  it("mutes a take whose own voice would double a dubbed line, and marks one that speaks", () => {
    const timeline = appendTakes(createEditorDocument(), [
      take("dubbed", { mute: true }),
      take("native", { speaks: true }),
    ]);
    expect(timeline.clips[0].properties.volume).toEqual([{ frame: 0, value: 0 }]);
    expect(timeline.clips[0].speaks).toBeUndefined();
    expect(timeline.clips[1].speaks).toBe(true);
  });

  it("dips the music under a line the video model spoke", () => {
    const timeline = appendTakes(createEditorDocument(), [
      take("native", { speaks: true, seconds: 6 }),
    ]);
    const rate = fps(timeline);
    const music = createEditorClip({
      trackId: "music",
      name: "score",
      artifactId: "score",
      duration: rate * 20,
    });
    timeline.clips.push(music);
    const duck = dialogueDuck(timeline);
    expect(duck(music, rate * 3)).toBeLessThan(1);
    expect(duck(music, rate * 15)).toBe(1);
  });
});
