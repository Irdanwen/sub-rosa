import { describe, expect, it } from "vitest";
import { formatThinkingElapsed } from "../components/agent/AgentWorkspace";

describe("the clock beside Thinking", () => {
  it("makes a long wait look long", () => {
    // The failure this exists for: a provider failing and retrying for six
    // minutes, with a shimmering word that reads the same at four seconds.
    expect(formatThinkingElapsed(6 * 60_000)).toBe("6 min");
    expect(formatThinkingElapsed(12_000)).toBe("12s");
    expect(formatThinkingElapsed(90 * 60_000)).toBe("1 h 30");
  });

  it("counts in seconds while seconds still mean something", () => {
    expect(formatThinkingElapsed(59_000)).toBe("59s");
    expect(formatThinkingElapsed(60_000)).toBe("1 min");
  });
});
