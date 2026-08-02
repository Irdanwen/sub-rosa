import { describe, expect, it } from "vitest";
import {
  alternativeCount,
  anchorOf,
  chainCost,
  chainCuts,
  chainOf,
  isChained,
} from "../lib/studio/chain";
import type { StudioArtifact } from "../lib/studio/types";

function shot(
  id: string,
  overrides: Partial<StudioArtifact> & { createdAt: number },
): StudioArtifact {
  return {
    id,
    kind: "video",
    path: `/gallery/${id}`,
    fileName: id,
    bytes: 1000,
    model: "seedance-2-0-image-to-video",
    prompt: "a shot",
    ...overrides,
  };
}

/** Three shots, each continuing the previous one at 9.5s of a 10s clip. */
const A = shot("a.mp4", { createdAt: 1 });
const B = shot("b.mp4", { createdAt: 2, parentId: "a.mp4", parentHandoffSeconds: 9.5 });
const C = shot("c.mp4", { createdAt: 3, parentId: "b.mp4", parentHandoffSeconds: 9.4 });

describe("chain rebuilding", () => {
  it("returns the whole chain, oldest first, from any of its shots", () => {
    const all = [C, A, B];
    for (const entry of [A, B, C]) {
      expect(chainOf(entry, all).map((shot) => shot.id)).toEqual(["a.mp4", "b.mp4", "c.mp4"]);
    }
  });

  it("is a chain of one for a standalone shot", () => {
    const lone = shot("lone.mp4", { createdAt: 9 });
    expect(chainOf(lone, [lone, A, B]).map((s) => s.id)).toEqual(["lone.mp4"]);
    expect(isChained(lone, [lone, A, B])).toBe(false);
    expect(isChained(A, [A, B])).toBe(true);
    expect(isChained(B, [A, B])).toBe(true);
  });

  it("starts at the oldest shot still on disk when an ancestor was deleted", () => {
    // A is gone: B's parent link dangles, so the chain begins at B.
    expect(chainOf(C, [B, C]).map((s) => s.id)).toEqual(["b.mp4", "c.mp4"]);
  });

  it("follows the most recent branch when a shot was continued twice", () => {
    const older = shot("b-old.mp4", { createdAt: 2, parentId: "a.mp4", parentHandoffSeconds: 9.5 });
    const newer = shot("b-new.mp4", { createdAt: 5, parentId: "a.mp4", parentHandoffSeconds: 9.5 });
    expect(chainOf(A, [A, older, newer]).map((s) => s.id)).toEqual(["a.mp4", "b-new.mp4"]);
  });

  it("cannot hang on a cycle in a corrupted index", () => {
    const loopA = shot("x.mp4", { createdAt: 1, parentId: "y.mp4" });
    const loopB = shot("y.mp4", { createdAt: 2, parentId: "x.mp4" });
    expect(chainOf(loopA, [loopA, loopB]).length).toBeLessThanOrEqual(2);
  });
});

describe("chain cut list", () => {
  it("trims every shot at the point its successor took over", () => {
    const cuts = chainCuts([A, B, C]);
    expect(cuts.map((cut) => cut.outSeconds)).toEqual([9.5, 9.4, undefined]);
  });

  it("leaves a shot whole when the successor is not really its continuation", () => {
    const unrelated = shot("z.mp4", { createdAt: 4, parentId: "other.mp4" });
    expect(chainCuts([A, unrelated])[0].outSeconds).toBeUndefined();
  });

  it("leaves a shot whole when the handoff point was never recorded", () => {
    const noPoint = shot("b2.mp4", { createdAt: 2, parentId: "a.mp4" });
    expect(chainCuts([A, noPoint])[0].outSeconds).toBeUndefined();
  });

  it("anchors on the first shot", () => {
    expect(anchorOf(chainOf(C, [A, B, C]))?.id).toBe("a.mp4");
    expect(anchorOf([])).toBeUndefined();
  });
});

describe("chain totals and branches", () => {
  it("adds up what the chain was quoted, and says when part is unknown", () => {
    const priced = [
      shot("p1.mp4", { createdAt: 1, costCredits: 26.5 }),
      shot("p2.mp4", { createdAt: 2, parentId: "p1.mp4", costCredits: 12.25 }),
    ];
    expect(chainCost(priced)).toEqual({ credits: 38.75, known: 2, total: 2 });

    // A shot from before prices were recorded must not silently vanish from
    // the total's meaning: `known < total` is what makes it "at least".
    const mixed = [...priced, shot("p3.mp4", { createdAt: 3, parentId: "p2.mp4" })];
    expect(chainCost(mixed)).toEqual({ credits: 38.75, known: 2, total: 3 });
    expect(chainCost([])).toEqual({ credits: 0, known: 0, total: 0 });
  });

  it("counts the takes a chain left behind, and only those", () => {
    const kept = shot("kept.mp4", { createdAt: 5, parentId: "a.mp4", parentHandoffSeconds: 9.5 });
    const dropped = shot("drop.mp4", { createdAt: 2, parentId: "a.mp4" });
    const all = [A, kept, dropped];
    const chain = chainOf(A, all);
    expect(chain.map((s) => s.id)).toEqual(["a.mp4", "kept.mp4"]);
    // A is followed by `kept`, so only `dropped` counts as an alternative.
    expect(alternativeCount(A, chain, all)).toBe(1);
    // The last shot of the chain has no continuation at all.
    expect(alternativeCount(kept, chain, all)).toBe(0);
  });
});
