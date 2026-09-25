import { describe, expect, it } from "vitest";
import { applyAgentLiteDelta } from "../lib/agent-lite-delta";

describe("applyAgentLiteDelta", () => {
  it("appends a fragment", () => {
    expect(applyAgentLiteDelta("Hel", { taskId: "t", text: "lo" })).toBe("Hello");
  });

  it("takes back exactly what a broken attempt showed before its replay", () => {
    // An earlier iteration's text stays; the broken attempt's "café 😀" (seven
    // UTF-16 units, as the native side counts them) goes.
    const shown = applyAgentLiteDelta("Searching. ", { taskId: "t", text: "café 😀" });
    const retracted = applyAgentLiteDelta(shown, { taskId: "t", text: "", retract: 7 });
    expect(retracted).toBe("Searching. ");
    expect(applyAgentLiteDelta(retracted, { taskId: "t", text: "Lisbon" })).toBe(
      "Searching. Lisbon",
    );
  });

  it("never takes back more than is shown", () => {
    expect(applyAgentLiteDelta("ab", { taskId: "t", text: "", retract: 10 })).toBe("");
  });
});
