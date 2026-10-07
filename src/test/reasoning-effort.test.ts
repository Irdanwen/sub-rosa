import { afterEach, describe, expect, it } from "vitest";
import { applyLocale } from "../lib/i18n";
import {
  effortForModel,
  parseReasoningEffort,
  REASONING_EFFORTS,
  reasoningEffortLabel,
  storedReasoningEffort,
  storeReasoningEffort,
  supportsReasoningEffort,
} from "../lib/reasoning-effort";

describe("reasoning effort", () => {
  afterEach(() => {
    applyLocale("en");
    localStorage.clear();
  });

  it("reads the capability from either catalog shape", () => {
    expect(supportsReasoningEffort({ supportsReasoningEffort: true })).toBe(true);
    expect(supportsReasoningEffort({ capabilities: ["supportsReasoningEffort"] })).toBe(true);
    // Reasoning is not the same as honouring an effort.
    expect(supportsReasoningEffort({ capabilities: ["supportsReasoning"] })).toBe(false);
    expect(supportsReasoningEffort({})).toBe(false);
    expect(supportsReasoningEffort(undefined)).toBe(false);
    // The provider list sometimes prefixes the capability name.
    expect(
      supportsReasoningEffort({ capabilities: ["capabilities.supportsReasoningEffort"] }),
    ).toBe(true);
  });

  it("sends an effort only to a model that honours one", () => {
    expect(effortForModel({ supportsReasoningEffort: true }, "high")).toBe("high");
    expect(effortForModel({ supportsReasoningEffort: false }, "high")).toBeUndefined();
    expect(effortForModel(undefined, "low")).toBeUndefined();
    expect(effortForModel({ supportsReasoningEffort: true }, undefined)).toBeUndefined();
  });

  it("reads stored or received values strictly", () => {
    expect(REASONING_EFFORTS).toEqual(["low", "medium", "high"]);
    for (const effort of REASONING_EFFORTS) expect(parseReasoningEffort(effort)).toBe(effort);
    for (const value of ["", "max", "HIGH", null, 2]) {
      expect(parseReasoningEffort(value)).toBeUndefined();
    }
  });

  it("remembers the choice and forgets the default", () => {
    storeReasoningEffort("effort-key", "medium");
    expect(storedReasoningEffort("effort-key")).toBe("medium");
    storeReasoningEffort("effort-key", undefined);
    expect(localStorage.getItem("effort-key")).toBeNull();
    localStorage.setItem("effort-key", "extreme");
    expect(storedReasoningEffort("effort-key")).toBeUndefined();
  });

  it("names every choice in full, in both languages", () => {
    // One set of names for both shells.
    expect([undefined, ...REASONING_EFFORTS].map(reasoningEffortLabel)).toEqual([
      "Default effort",
      "Low effort",
      "Medium effort",
      "High effort",
    ]);
    applyLocale("fr");
    // "Medium" alone is a shot size in the catalog; the effort must not read as one.
    expect(reasoningEffortLabel("medium")).toBe("Effort moyen");
  });
});
