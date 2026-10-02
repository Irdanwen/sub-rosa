import { describe, expect, it } from "vitest";
import {
  clampView,
  FIT,
  MAX_SCALE,
  panBy,
  TAP_SCALE,
  toggleZoom,
  zoomAt,
} from "../lib/studio/retouch/view";

const FRAME = { width: 400, height: 300 };

/** Where a point of the picture lands on screen, relative to the frame's
 * untransformed centre. */
function onScreen(
  view: { scale: number; x: number; y: number },
  picture: { x: number; y: number },
) {
  return { x: view.x + picture.x * view.scale, y: view.y + picture.y * view.scale };
}

describe("zooming into the picture", () => {
  it("keeps the pinched point under the fingers", () => {
    const point = { x: 120, y: -60 };
    const zoomed = zoomAt(FIT, 2, point, FRAME);
    // The picture point that was under the fingers at fit is still there.
    expect(onScreen(zoomed, point)).toEqual(point);
    const further = zoomAt(zoomed, 1.5, { x: 40, y: 20 }, FRAME);
    const picturePoint = { x: (40 - zoomed.x) / zoomed.scale, y: (20 - zoomed.y) / zoomed.scale };
    const landed = onScreen(further, picturePoint);
    expect(landed.x).toBeCloseTo(40);
    expect(landed.y).toBeCloseTo(20);
  });

  it("never zooms out past fit, nor in past the ceiling", () => {
    expect(zoomAt(FIT, 0.2, { x: 0, y: 0 }, FRAME)).toEqual(FIT);
    expect(zoomAt(FIT, 100, { x: 0, y: 0 }, FRAME).scale).toBe(MAX_SCALE);
  });

  it("does not let an edge of the picture come inside the room", () => {
    const zoomed = { scale: 2, x: 0, y: 0 };
    expect(panBy(zoomed, 1000, -1000, FRAME)).toEqual({ scale: 2, x: 200, y: -150 });
    expect(clampView({ scale: 1, x: 50, y: 50 }, FRAME)).toEqual(FIT);
  });

  it("zooms in on a double tap, and back out on the next", () => {
    const zoomed = toggleZoom(FIT, { x: 100, y: 50 }, FRAME);
    expect(zoomed.scale).toBe(TAP_SCALE);
    expect(onScreen(zoomed, { x: 100, y: 50 })).toEqual({ x: 100, y: 50 });
    expect(toggleZoom(zoomed, { x: 0, y: 0 }, FRAME)).toEqual(FIT);
  });
});
