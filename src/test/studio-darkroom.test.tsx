import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Darkroom } from "../components/studio/Darkroom";
import { darkroomAspect, darkroomSeed, darkroomWave } from "../lib/studio/darkroom";
import {
  describeRemaining,
  estimateRenderMs,
  rememberRenderMs,
  renderEtaKey,
  waitProgress,
} from "../lib/studio/render-eta";

describe("darkroom seed", () => {
  it("gives the same request the same light every time", () => {
    expect(darkroomSeed("job-1a woman walks")).toEqual(darkroomSeed("job-1a woman walks"));
  });

  it("gives two queued renders different light", () => {
    // Two clips waiting side by side must not read as one animation drawn twice.
    expect(darkroomSeed("job-1").hueA).not.toBe(darkroomSeed("job-2").hueA);
  });

  it("keeps every derived value inside its range", () => {
    for (const input of ["", "a", "seedance-1-0-pro", "job-9f2 a long prompt about a red door"]) {
      const seed = darkroomSeed(input);
      for (const hue of [seed.hueA, seed.hueB, seed.hueC]) {
        expect(hue).toBeGreaterThanOrEqual(0);
        expect(hue).toBeLessThan(360);
      }
      expect(seed.driftMs).toBeGreaterThanOrEqual(17_000);
      expect(seed.driftMs).toBeLessThan(28_000);
      expect(Math.abs(seed.tiltDeg)).toBeLessThanOrEqual(20);
      expect(seed.bloom).toBeGreaterThan(0.8);
      expect(seed.bloom).toBeLessThan(1.25);
    }
  });
});

describe("darkroom frame shape", () => {
  it("reads the ratios the models are asked for", () => {
    expect(darkroomAspect("16:9")).toBe("16 / 9");
    expect(darkroomAspect("1/1")).toBe("1 / 1");
    expect(darkroomAspect(1.5)).toBe("1.5");
  });

  it("falls back to widescreen rather than collapsing the frame", () => {
    // The frame is a reservation: a box with no height reserves nothing.
    expect(darkroomAspect(undefined)).toBe("16 / 9");
    expect(darkroomAspect("")).toBe("16 / 9");
    expect(darkroomAspect("portrait")).toBe("16 / 9");
    expect(darkroomAspect("16:0")).toBe("16 / 9");
  });
});

describe("darkroom wave", () => {
  it("draws a stable silhouette with every bar visible", () => {
    const wave = darkroomWave("music-model-a jazz trio", 24);
    expect(wave).toHaveLength(24);
    expect(wave).toEqual(darkroomWave("music-model-a jazz trio", 24));
    for (const height of wave) {
      expect(height).toBeGreaterThan(0);
      expect(height).toBeLessThanOrEqual(1);
    }
  });
});

describe("render estimates", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("says nothing until it has seen two renders", () => {
    const key = renderEtaKey("video", "seedance-1-0-pro");
    expect(estimateRenderMs(key)).toBeUndefined();
    rememberRenderMs(key, 60_000);
    expect(estimateRenderMs(key)).toBeUndefined();
    rememberRenderMs(key, 80_000);
    expect(estimateRenderMs(key)).toBe(70_000);
  });

  it("takes the median, so one stalled render does not poison the estimate", () => {
    const key = renderEtaKey("video", "slow-model");
    for (const ms of [50_000, 55_000, 60_000, 20 * 60_000]) rememberRenderMs(key, ms);
    expect(estimateRenderMs(key)).toBe(57_500);
  });

  it("keeps nonsense samples out", () => {
    const key = renderEtaKey("video", "odd-model");
    rememberRenderMs(key, 40);
    rememberRenderMs(key, 60 * 60_000);
    rememberRenderMs(key, Number.NaN);
    expect(estimateRenderMs(key)).toBeUndefined();
  });

  it("keeps models apart", () => {
    rememberRenderMs(renderEtaKey("video", "a"), 30_000);
    rememberRenderMs(renderEtaKey("video", "a"), 30_000);
    expect(estimateRenderMs(renderEtaKey("video", "b"))).toBeUndefined();
    expect(estimateRenderMs(renderEtaKey("music", "a"))).toBeUndefined();
  });
});

describe("wait progress", () => {
  it("has no position to report without an estimate", () => {
    expect(waitProgress(30_000, undefined)).toBeUndefined();
  });

  it("rises, and never arrives", () => {
    const estimate = 60_000;
    let previous = -1;
    for (const elapsed of [0, 15_000, 45_000, 60_000, 90_000, 300_000, 3_600_000]) {
      const progress = waitProgress(elapsed, estimate) ?? 0;
      expect(progress).toBeGreaterThan(previous);
      // Only the finished render may say the render is finished.
      expect(progress).toBeLessThan(1);
      previous = progress;
    }
  });

  it("keeps moving past its own estimate", () => {
    const overdue = waitProgress(120_000, 60_000) ?? 0;
    const later = waitProgress(180_000, 60_000) ?? 0;
    expect(later).toBeGreaterThan(overdue);
  });
});

describe("remaining time", () => {
  it("rounds coarsely enough to be a promise it can keep", () => {
    expect(describeRemaining(20_000, 60_000)).toBe("about 40s left");
    expect(describeRemaining(0, 240_000)).toBe("about 4 min left");
    expect(describeRemaining(52_000, 60_000)).toBe("nearly there");
  });

  it("stops claiming to know once the estimate has passed", () => {
    expect(describeRemaining(90_000, 60_000)).toBe("any moment now");
    expect(describeRemaining(10_000, undefined)).toBeUndefined();
  });
});

describe("Darkroom", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("announces the phase and holds the render's shape", () => {
    const { container } = render(
      <Darkroom seed="job-1" phase="processing" elapsedMs={72_000} aspectRatio="9:16" />,
    );

    expect(screen.getByText("Rendering")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("1m 12s")).toBeInTheDocument();
    expect(container.querySelector(".darkroom")).toHaveStyle({ "--darkroom-aspect": "9 / 16" });
  });

  it("sweeps rather than fills when it has no estimate", () => {
    const { container } = render(<Darkroom seed="job-1" phase="processing" elapsedMs={9_000} />);

    expect(container.querySelector(".darkroom-bar")).toHaveAttribute("data-indeterminate", "true");
  });

  it("fills to the estimate once it has one", () => {
    const { container } = render(
      <Darkroom seed="job-1" phase="processing" elapsedMs={30_000} estimateMs={60_000} />,
    );

    const bar = container.querySelector(".darkroom-bar");
    expect(bar).not.toHaveAttribute("data-indeterminate");
    expect(bar?.querySelector("span")).toHaveStyle({ transform: "scaleX(0.425)" });
  });

  it("does not time a render that has not started", () => {
    // A queued render has no start, so a clock on it would be invented.
    render(<Darkroom seed="job-1" phase="queued" />);

    expect(screen.getByText("Queued, waiting for a slot")).toBeInTheDocument();
    expect(screen.queryByText("0s")).not.toBeInTheDocument();
  });

  it("takes a real progress reading over its own estimate", () => {
    const { container } = render(
      <Darkroom seed="film" phase="processing" progress={0.25} elapsedMs={10_000} />,
    );

    expect(container.querySelector(".darkroom-bar > span")).toHaveStyle({
      transform: "scaleX(0.25)",
    });
  });
});
