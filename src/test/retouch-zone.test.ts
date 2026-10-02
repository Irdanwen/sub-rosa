import { describe, expect, it } from "vitest";
import {
  featherFor,
  featherMask,
  hasZone,
  ratioValue,
  strokesInCrop,
  zoneBounds,
  zoneCrop,
  type ZoneStroke,
} from "../lib/studio/retouch/zone";

const IMAGE = { width: 1248, height: 832 };
// What Ideogram 4.5 edit accepts, "auto" aside (measured 2026-10-02: 4:3 is refused).
const RATIOS = ["1:1", "3:2", "16:9", "9:16", "2:3", "3:4", "4:5"];

const brush = (points: [number, number][], radius = 10, erase = false): ZoneStroke => ({
  kind: "brush",
  points,
  radius,
  ...(erase ? { erase: true } : {}),
});

describe("the zone's extent", () => {
  it("covers every additive stroke, brush radius included, and ignores the eraser", () => {
    const bounds = zoneBounds(
      [
        brush(
          [
            [100, 100],
            [200, 120],
          ],
          10,
        ),
        brush([[900, 700]], 50, true),
      ],
      IMAGE,
    );
    expect(bounds).toEqual({ x: 90, y: 90, width: 120, height: 40 });
  });

  it("clips to the image", () => {
    expect(zoneBounds([brush([[-20, 5]], 30)], IMAGE)).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 35,
    });
  });

  it("knows when nothing was drawn", () => {
    expect(hasZone([])).toBe(false);
    expect(hasZone([brush([[10, 10]], 10, true)])).toBe(false);
    expect(
      hasZone([
        {
          kind: "lasso",
          points: [
            [1, 1],
            [5, 5],
          ],
        },
      ]),
    ).toBe(false);
    expect(
      hasZone([
        {
          kind: "lasso",
          points: [
            [1, 1],
            [50, 5],
            [20, 40],
          ],
        },
      ]),
    ).toBe(true);
    expect(zoneBounds([], IMAGE)).toBeUndefined();
  });
});

describe("the crop sent for a zone", () => {
  const zone = { x: 415, y: 550, width: 140, height: 80 };

  it("keeps the whole zone, at a ratio the model accepts, inside the image", () => {
    const crop = zoneCrop(zone, IMAGE, { ratios: RATIOS });
    if (!crop) throw new Error("no crop");
    expect(RATIOS).toContain(crop.ratio);
    expect(crop.width / crop.height).toBeCloseTo(ratioValue(crop.ratio) ?? 0, 1);
    expect(crop.x).toBeLessThanOrEqual(zone.x);
    expect(crop.y).toBeLessThanOrEqual(zone.y);
    expect(crop.x + crop.width).toBeGreaterThanOrEqual(zone.x + zone.width);
    expect(crop.y + crop.height).toBeGreaterThanOrEqual(zone.y + zone.height);
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.y + crop.height).toBeLessThanOrEqual(IMAGE.height);
  });

  it("gives the model enough around a small zone", () => {
    const crop = zoneCrop({ x: 600, y: 400, width: 20, height: 20 }, IMAGE, { ratios: RATIOS });
    expect(Math.min(crop?.width ?? 0, crop?.height ?? 0)).toBeGreaterThanOrEqual(380);
  });

  it("picks the shape that wastes the least, a wide zone getting a wide crop", () => {
    const crop = zoneCrop({ x: 100, y: 400, width: 900, height: 120 }, IMAGE, { ratios: RATIOS });
    expect(crop?.ratio).toBe("16:9");
  });

  it("fits a zone as large as the image", () => {
    const crop = zoneCrop({ x: 0, y: 0, ...IMAGE }, IMAGE, { ratios: RATIOS });
    expect(crop).toMatchObject({ x: 0, y: 0, ratio: "3:2" });
    expect(crop?.width).toBeLessThanOrEqual(IMAGE.width);
  });

  it("refuses without an explicit ratio to send", () => {
    expect(zoneCrop(zone, IMAGE, { ratios: [] })).toBeUndefined();
    expect(ratioValue("auto")).toBeUndefined();
  });

  it("moves the strokes into the crop's own coordinates", () => {
    const [moved] = strokesInCrop([brush([[120, 130]])], { x: 100, y: 100, width: 50, height: 50 });
    expect(moved.points).toEqual([[20, 30]]);
  });
});

describe("the feathered mask", () => {
  function square(size: number, from: number, to: number): Uint8ClampedArray {
    const alpha = new Uint8ClampedArray(size * size);
    for (let y = from; y < to; y += 1) for (let x = from; x < to; x += 1) alpha[y * size + x] = 255;
    return alpha;
  }

  it("keeps what was drawn fully replaced and fades only outside it", () => {
    const size = 60;
    const out = featherMask(square(size, 20, 40), size, size, 6);
    expect(out[30 * size + 30]).toBe(255);
    expect(out[20 * size + 20]).toBe(255);
    expect(out[0]).toBe(0);
    const edge = out[30 * size + 44];
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
  });

  it("scales its width with the crop", () => {
    expect(featherFor({ width: 100, height: 100 })).toBe(4);
    expect(featherFor({ width: 1200, height: 800 })).toBe(20);
  });
});
