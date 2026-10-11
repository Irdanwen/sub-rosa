import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { check, googleScheme, overlay, review } from "../../scripts/connector-clients.mjs";

const GOOGLE = "1234567890-abc123def.apps.googleusercontent.com";
const MS = "0b5c2a8e-1f3d-4c6b-9a7e-2d4f6b8c0e1a";
const GITHUB = "Ov23liAbCdEfGhIjKlMn";
const FULL = {
  SUBROSA_GOOGLE_CLIENT_ID: GOOGLE,
  SUBROSA_MS_CLIENT_ID: MS,
  SUBROSA_GITHUB_CLIENT_ID: GITHUB,
};
const deepLink = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).plugins["deep-link"];

describe("connector clients in a release build", () => {
  it("names every connector an empty build leaves out, and never a value", () => {
    const annotations = review({}, "macos");
    expect(annotations.map((a) => a.level)).toEqual(["warning", "warning", "warning"]);
    expect(annotations.map((a) => a.message).join("\n")).toMatch(
      /Google[\s\S]*Microsoft[\s\S]*GitHub/,
    );
    const malformed = review({ ...FULL, SUBROSA_MS_CLIENT_ID: "secret-looking-thing" }, "ios");
    expect(malformed).toHaveLength(1);
    expect(malformed[0].message).not.toContain("secret-looking-thing");
  });

  it("is quiet when the build carries every id", () => {
    expect(review(FULL, "macos")).toEqual([]);
    expect(review(FULL, "ios")).toEqual([]);
  });

  it("says why Google is absent where it cannot sign in, without warning", () => {
    for (const platform of ["windows", "android"]) {
      const annotations = review(FULL, platform);
      expect(annotations).toHaveLength(1);
      expect(annotations[0].level).toBe("notice");
      expect(annotations[0].message).toContain("Google is not offered");
    }
  });

  it("checks presence and shape strictly", () => {
    expect(check(FULL)).toEqual([]);
    expect(check({ ...FULL, SUBROSA_GITHUB_CLIENT_ID: " " })).toEqual([
      "SUBROSA_GITHUB_CLIENT_ID is missing.",
    ]);
    expect(check({ ...FULL, SUBROSA_GOOGLE_CLIENT_ID: "1234.apps.example.com" })[0]).toMatch(
      /SUBROSA_GOOGLE_CLIENT_ID is not/,
    );
    expect(check({ ...FULL, SUBROSA_GITHUB_CLIENT_ID: "0123456789abcdef0123" })).toEqual([]);
  });

  it("derives Google's scheme the way the app derives its redirect", () => {
    expect(googleScheme(GOOGLE)).toBe("com.googleusercontent.apps.1234567890-abc123def");
    expect(googleScheme("nope")).toBeNull();
    expect(googleScheme(".apps.googleusercontent.com")).toBeNull();
    const rust = readFileSync("src-tauri/src/connectors/build_clients.rs", "utf8");
    expect(rust).toContain('format!("com.googleusercontent.apps.{prefix}:/oauth2redirect")');
  });

  it("registers Google's scheme next to the app's own on Apple builds only", () => {
    const apple = overlay(FULL, "ios", deepLink).plugins["deep-link"];
    const scheme = googleScheme(GOOGLE);
    expect(apple.desktop.schemes).toEqual(["subrosa", scheme]);
    expect(apple.mobile[0].scheme).toEqual(["subrosa", scheme]);
    expect(apple.mobile[0].appLink).toBe(false);
    expect(overlay(FULL, "windows", deepLink)).toEqual({});
    expect(overlay(FULL, "android", deepLink)).toEqual({});
    expect(overlay({}, "macos", deepLink)).toEqual({});
  });
});
