import { describe, expect, it } from "vitest";
import { countByRule, lowered, regressions } from "../../scripts/biome-ratchet.mjs";

const report = {
  diagnostics: [
    { severity: "warning", category: "lint/a11y/useSemanticElements" },
    { severity: "warning", category: "lint/a11y/useSemanticElements" },
    { severity: "warning", category: "lint/correctness/useExhaustiveDependencies" },
    { severity: "error", category: "lint/correctness/noUnusedImports" },
    { severity: "information", category: "lint/style/useTemplate" },
  ],
};

describe("the Biome warnings ratchet", () => {
  it("counts warnings per rule and nothing else", () => {
    expect(countByRule(report)).toEqual({
      "lint/a11y/useSemanticElements": 2,
      "lint/correctness/useExhaustiveDependencies": 1,
    });
  });

  it("reports only the rules whose count went up", () => {
    const recorded = { "lint/a11y/useSemanticElements": 2 };
    const current = {
      "lint/a11y/useSemanticElements": 2,
      "lint/correctness/useExhaustiveDependencies": 1,
    };
    expect(regressions(recorded, current)).toEqual([
      "lint/correctness/useExhaustiveDependencies: 1 warnings, 0 allowed",
    ]);
    expect(
      regressions({ "lint/a11y/useSemanticElements": 5 }, { "lint/a11y/useSemanticElements": 3 }),
    ).toEqual([]);
  });

  it("only lowers the recorded counts, and drops a rule at zero", () => {
    const recorded = { a: 5, b: 2, c: 1 };
    const current = { a: 7, b: 1 };
    expect(lowered(recorded, current)).toEqual({ a: 5, b: 1 });
  });
});
