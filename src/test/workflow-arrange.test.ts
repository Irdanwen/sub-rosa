/**
 * Lining steps up: aligned on an edge or a centre, or spread so the gaps
 * between them are equal, the outermost two staying put.
 */

import { describe, expect, it } from "vitest";
import { align, distribute, layered } from "../lib/studio/workflow/arrange";

const boxes = [
  { id: "a", x: 10, y: 40, width: 100, height: 50 },
  { id: "b", x: 200, y: 0, width: 80, height: 90 },
  { id: "c", x: 500, y: 20, width: 120, height: 60 },
];

describe("aligning steps", () => {
  it("lines them up on the chosen edge or centre", () => {
    const left = align(boxes, "left");
    expect([...left.values()].map((point) => point.x)).toEqual([10, 10, 10]);
    const top = align(boxes, "top");
    expect([...top.values()].map((point) => point.y)).toEqual([0, 0, 0]);
    const bottom = align(boxes, "bottom");
    expect(bottom.get("a")).toEqual({ x: 10, y: 40 });
    expect(bottom.get("b")).toEqual({ x: 200, y: 0 });
    const middle = align(boxes, "centerY");
    expect(middle.get("a")?.y).toBe(20);
  });

  it("does nothing for a single step", () => {
    expect(align(boxes.slice(0, 1), "left").size).toBe(0);
  });
});

describe("spreading steps", () => {
  it("makes the gaps equal and keeps the outermost two in place", () => {
    const spread = distribute(boxes, "horizontal");
    expect(spread.get("a")?.x).toBe(10);
    expect(spread.get("c")?.x).toBe(500);
    const gapAB = (spread.get("b")?.x ?? 0) - (10 + 100);
    const gapBC = 500 - ((spread.get("b")?.x ?? 0) + 80);
    expect(gapAB).toBeCloseTo(gapBC);
  });

  it("needs three steps", () => {
    expect(distribute(boxes.slice(0, 2), "vertical").size).toBe(0);
  });
});

describe("arranging a graph", () => {
  it("puts each step in the column of its longest chain of inputs, spaced by the gap", () => {
    const steps = [
      { id: "idea", x: 400, y: 300, width: 100, height: 40 },
      { id: "write", x: 0, y: 0, width: 200, height: 80 },
      { id: "pic", x: 50, y: 500, width: 150, height: 60 },
      { id: "music", x: 10, y: 600, width: 150, height: 60 },
    ];
    const moved = layered(
      steps,
      [
        { source: "idea", target: "write" },
        { source: "write", target: "pic" },
        { source: "idea", target: "pic" },
      ],
      50,
    );
    // Columns: idea and music (no inputs, widest 150), then write (200),
    // then pic.
    expect(moved.get("idea")?.x).toBe(0);
    expect(moved.get("music")?.x).toBe(0);
    expect(moved.get("write")?.x).toBe(200);
    expect(moved.get("pic")?.x).toBe(450);
    // Stacked in their current vertical order, spaced by the gap.
    expect(moved.get("idea")?.y).toBe(0);
    expect(moved.get("music")?.y).toBe(90);
  });
});
