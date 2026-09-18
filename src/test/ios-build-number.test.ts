import { describe, expect, it } from "vitest";
import { iosBuildNumber } from "../../scripts/ios-build-number.mjs";

describe("the iOS build number", () => {
  it("stays on the app version when no counter is given", () => {
    // A local build and the committed files want one readable value.
    expect(iosBuildNumber("1.65.2", undefined)).toBe("1.65.2");
    expect(iosBuildNumber("1.65.2", "")).toBe("1.65.2");
  });

  it("rises above the version it ships under", () => {
    // App Store Connect answered 409 against previousBundleVersion "1.65.2"
    // when the counter went out bare as "62": a plain integer is not read as
    // higher than a three-part version.
    expect(iosBuildNumber("1.65.2", "62")).toBe("1.65.62");
    expect(iosBuildNumber("1.65.2", "63")).toBe("1.65.63");
  });

  it("keeps every train above the one before it", () => {
    const order = (a: string) => a.split(".").map(Number);
    const previous = order(iosBuildNumber("1.65.2", "200"));
    const next = order(iosBuildNumber("1.66.0", "201"));
    expect(next[0] * 1e6 + next[1] * 1e3 + next[2]).toBeGreaterThan(
      previous[0] * 1e6 + previous[1] * 1e3 + previous[2],
    );
  });

  it("refuses a counter or a version it cannot place", () => {
    expect(() => iosBuildNumber("1.65.2", "1.2")).toThrow(/counter/);
    expect(() => iosBuildNumber("1.65", "62")).toThrow(/version/);
  });
});
