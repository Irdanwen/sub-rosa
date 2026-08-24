import { describe, expect, it } from "vitest";
import {
  DUCK_ATTACK_SECONDS,
  DUCK_GAIN,
  DUCK_RELEASE_SECONDS,
  duckStops,
  mergeWindows,
  type MixSource,
  planMix,
  renderMix,
  scheduleWithoutOverlap,
} from "../lib/studio/mix";

describe("mergeWindows", () => {
  it("folds overlapping and touching windows into one", () => {
    expect(
      mergeWindows([
        { start: 2, end: 4 },
        { start: 0, end: 1 },
        { start: 3, end: 6 },
      ]),
    ).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 6 },
    ]);
  });

  it("joins windows that are merely close, when asked", () => {
    expect(
      mergeWindows(
        [
          { start: 0, end: 1 },
          { start: 1.4, end: 2 },
        ],
        0.5,
      ),
    ).toEqual([{ start: 0, end: 2 }]);
  });

  it("drops a window with no length", () => {
    expect(mergeWindows([{ start: 3, end: 3 }])).toEqual([]);
  });
});

describe("ducking", () => {
  it("writes the dip around the line, not on top of it", () => {
    const stops = duckStops([{ start: 5, end: 7 }], { durationSeconds: 20 });
    expect(stops).toEqual([
      { atSeconds: 0, gain: 1 },
      { atSeconds: 5 - DUCK_ATTACK_SECONDS, gain: 1 },
      { atSeconds: 5, gain: DUCK_GAIN },
      { atSeconds: 7, gain: DUCK_GAIN },
      { atSeconds: 7 + DUCK_RELEASE_SECONDS, gain: 1 },
    ]);
  });

  it("makes two close lines one dip rather than a pump between them", () => {
    // The music coming back up for a fifth of a second between two lines is
    // the single most recognisable sign of an automatic mix.
    const stops = duckStops(
      [
        { start: 5, end: 6 },
        { start: 6.2, end: 7 },
      ],
      { durationSeconds: 20 },
    );
    expect(stops.filter((stop) => stop.gain === 1).length).toBe(3);
    expect(stops.map((stop) => stop.gain)).toEqual([1, 1, DUCK_GAIN, DUCK_GAIN, 1]);
  });

  it("keeps every point inside the film", () => {
    const stops = duckStops([{ start: 0.05, end: 9.9 }], { durationSeconds: 10 });
    expect(Math.min(...stops.map((stop) => stop.atSeconds))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...stops.map((stop) => stop.atSeconds))).toBeLessThanOrEqual(10);
  });

  it("writes stops in ascending order, always", () => {
    const stops = duckStops(
      [
        { start: 1, end: 2 },
        { start: 8, end: 9 },
        { start: 4, end: 5 },
      ],
      { durationSeconds: 20 },
    );
    const times = stops.map((stop) => stop.atSeconds);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("has nothing to say when nobody speaks", () => {
    expect(duckStops([], { durationSeconds: 20 })).toEqual([]);
  });
});

describe("dialogue scheduling", () => {
  it("never lets two lines overlap, however long one runs", () => {
    // Durations are measured, not announced: a generated voice runs as long as
    // it runs, and the second line has to move.
    const at = scheduleWithoutOverlap(
      [
        { durationSeconds: 3, preferredAtSeconds: 0 },
        { durationSeconds: 1, preferredAtSeconds: 2 },
        { durationSeconds: 1, preferredAtSeconds: 30 },
      ],
      0.25,
    );
    expect(at).toEqual([0, 3.25, 30]);
  });

  it("pushes a late line rather than dropping it", () => {
    expect(scheduleWithoutOverlap([{ durationSeconds: 5 }, { durationSeconds: 1 }], 0)).toEqual([
      0, 5,
    ]);
  });

  it("survives a duration that makes no sense", () => {
    expect(scheduleWithoutOverlap([{ durationSeconds: -4 }, { durationSeconds: 1 }], 0)).toEqual([
      0, 0,
    ]);
  });
});

describe("planMix", () => {
  const source = (over: Partial<MixSource> & Pick<MixSource, "id" | "lane">): MixSource => ({
    atSeconds: 0,
    inSeconds: 0,
    outSeconds: 2,
    ...over,
  });

  it("ducks the music under the dialogue by default", () => {
    const plan = planMix({
      durationSeconds: 20,
      sources: [
        source({ id: "m", lane: "music", outSeconds: 20 }),
        source({ id: "d", lane: "dialogue", atSeconds: 5, outSeconds: 2 }),
      ],
    });
    expect(plan.automation.music?.some((stop) => stop.gain === DUCK_GAIN)).toBe(true);
    expect(plan.automation.dialogue).toBeUndefined();
  });

  it("leaves the music alone when there is no dialogue to duck under", () => {
    const plan = planMix({
      durationSeconds: 20,
      sources: [source({ id: "m", lane: "music", outSeconds: 20 })],
    });
    expect(plan.automation.music).toBeUndefined();
  });

  it("does not automate a lane that is not there", () => {
    const plan = planMix({
      durationSeconds: 20,
      sources: [source({ id: "d", lane: "dialogue" })],
    });
    expect(plan.automation).toEqual({});
  });

  it("drops a sound trimmed to nothing instead of scheduling silence", () => {
    const plan = planMix({
      durationSeconds: 20,
      sources: [source({ id: "x", lane: "sfx", inSeconds: 3, outSeconds: 3 })],
    });
    expect(plan.sources).toEqual([]);
  });

  it("can be told not to duck", () => {
    const plan = planMix({
      duck: false,
      durationSeconds: 20,
      sources: [
        source({ id: "m", lane: "music", outSeconds: 20 }),
        source({ id: "d", lane: "dialogue", atSeconds: 5 }),
      ],
    });
    expect(plan.automation.music).toBeUndefined();
  });
});

describe("renderMix", () => {
  it("hands back nothing where there is no offline audio at all", async () => {
    // jsdom has no OfflineAudioContext, which is also the honest answer for any
    // shell that lacks one: the caller falls back to the live path rather than
    // exporting a silent film.
    expect(typeof OfflineAudioContext).toBe("undefined");
    await expect(
      renderMix(planMix({ durationSeconds: 5, sources: [] }), { buffers: new Map() }),
    ).resolves.toBeUndefined();
  });
});
