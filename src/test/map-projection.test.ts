import { describe, expect, it } from "vitest";
import { fitBounds, pixelOffset, project } from "../lib/map-projection";

describe("map projection", () => {
  it("projects the known world anchors", () => {
    // Lat 0 / lng 0 is the exact center of the world grid at any zoom.
    const origin = project({ lat: 0, lng: 0 }, 1);
    expect(origin.x).toBeCloseTo(256);
    expect(origin.y).toBeCloseTo(256);
    // East is +x, north is -y.
    const northeast = project({ lat: 45, lng: 90 }, 1);
    expect(northeast.x).toBeGreaterThan(256);
    expect(northeast.y).toBeLessThan(256);
  });

  it("fits bounds inside the padded viewport and centers a single pin", () => {
    const points = [
      { lat: 46.19, lng: 6.23 },
      { lat: 46.2, lng: 6.25 },
      { lat: 46.18, lng: 6.21 },
    ];
    const { center, zoom } = fitBounds(points, 480, 200);
    const projected = points.map((point) => pixelOffset(point, center, zoom, 480, 200));
    for (const { left, top } of projected) {
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThanOrEqual(480);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top).toBeLessThanOrEqual(200);
    }

    const single = fitBounds([{ lat: 46.19, lng: 6.23 }], 480, 200);
    expect(single.zoom).toBe(15);
    const offset = pixelOffset({ lat: 46.19, lng: 6.23 }, single.center, single.zoom, 480, 200);
    expect(offset.left).toBeCloseTo(240);
    expect(offset.top).toBeCloseTo(100);
  });

  it("zooms out far enough for continent-wide bounds", () => {
    const wide = fitBounds(
      [
        { lat: 48.85, lng: 2.35 },
        { lat: 40.71, lng: -74.0 },
      ],
      480,
      200,
    );
    expect(wide.zoom).toBeLessThanOrEqual(4);
  });
});
