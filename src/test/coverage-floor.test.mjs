import { describe, expect, it } from "vitest";
import {
  compare,
  frontendLinePercent,
  raised,
  readPercent,
  rustLinePercent,
} from "../../scripts/coverage-floor.mjs";

describe("reading a measurement", () => {
  it("reads vitest's json-summary total", () => {
    expect(frontendLinePercent({ total: { lines: { pct: 61.42 } } })).toBe(61.42);
  });

  it("reads cargo llvm-cov's summary total", () => {
    expect(rustLinePercent({ data: [{ totals: { lines: { percent: 58.1 } } }] })).toBe(58.1);
  });

  it("refuses a report without a total, rather than treating it as zero", () => {
    expect(() => frontendLinePercent({})).toThrow(/total\.lines\.pct/);
    expect(() => rustLinePercent({ data: [] })).toThrow(/totals\.lines\.percent/);
    expect(() => readPercent("other", {})).toThrow(/unknown coverage kind/);
  });
});

describe("the floor", () => {
  it("passes when the measurement clears it, and says both numbers", () => {
    const result = compare("frontend", { frontend: 60 }, 61.5);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("61.50%");
    expect(result.message).toContain("60.00%");
  });

  it("fails below the floor and tells the author what to do", () => {
    const result = compare("frontend", { frontend: 60 }, 59.99);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/below the floor/);
    expect(result.message).toMatch(/coverage-floor\.json/);
  });

  it("passes when no floor is recorded yet", () => {
    expect(compare("rust", {}, 12).ok).toBe(true);
  });

  it("only rises, and only by a real step", () => {
    const floors = { frontend: 60, rust: 50 };
    expect(raised("frontend", floors, 59)).toBe(floors);
    expect(raised("frontend", floors, 60.05)).toBe(floors);
    expect(raised("frontend", floors, 60.2)).toEqual({ frontend: 60.2, rust: 50 });
    expect(raised("rust", {}, 51.239)).toEqual({ rust: 51.23 });
  });
});
