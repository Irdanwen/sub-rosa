// iOS privacy usage descriptions are load-bearing, not paperwork: the system
// terminates the app the instant it touches a protected resource without the
// matching key. A missing one is a crash on tap, not a denied permission — the
// camera key was absent, so "take a photo" in the chat killed the app.
//
// They have to be in TWO places. `Info.plist` is what ships; `project.yml` is
// what XcodeGen regenerates that plist from, so a key present only in the
// plist disappears the next time anyone runs `tauri ios init` / `xcodegen`.
// This test pins both halves.

import { describe, expect, it } from "vitest";
// `?raw` (the pattern the CSS tests use) rather than fs: it resolves through
// vite, so the paths stay correct wherever the runner is invoked from.
import infoPlist from "../../src-tauri/gen/apple/os-june_iOS/Info.plist?raw";
import projectSpec from "../../src-tauri/gen/apple/project.yml?raw";

/** Each protected resource the app actually reaches for, and what reaches it. */
const REQUIRED_USAGE_KEYS: Array<{ key: string; reachedBy: string }> = [
  { key: "NSMicrophoneUsageDescription", reachedBy: "recording a note or a dictation" },
  {
    key: "NSAudioCaptureUsageDescription",
    reachedBy: "the microphone plus system audio source",
  },
  {
    key: "NSCameraUsageDescription",
    reachedBy: 'the chat attachment picker and Studio\'s capture="environment" button',
  },
  {
    key: "NSPhotoLibraryAddUsageDescription",
    reachedBy: "saving a Studio generation to the photo library",
  },
];

describe("iOS privacy usage descriptions", () => {
  for (const { key, reachedBy } of REQUIRED_USAGE_KEYS) {
    it(`declares ${key} in the shipped plist (${reachedBy})`, () => {
      expect(infoPlist).toContain(`<key>${key}</key>`);
    });

    it(`declares ${key} in project.yml so regenerating the project keeps it`, () => {
      expect(projectSpec).toContain(`${key}:`);
    });
  }

  it("keeps the background modes in both files", () => {
    // Same trap, same consequence: losing these silently downgrades every
    // durable queue to "only makes progress while the app is on screen".
    for (const mode of ["audio", "processing", "fetch"]) {
      expect(infoPlist).toContain(`<string>${mode}</string>`);
    }
    expect(projectSpec).toContain("UIBackgroundModes:");
    expect(projectSpec).toContain("BGTaskSchedulerPermittedIdentifiers:");
  });

  it("keeps the deep-link scheme in both files", () => {
    expect(infoPlist).toContain("<string>subrosa</string>");
    expect(projectSpec).toContain("CFBundleURLTypes:");
  });

  it("keeps the two files from disagreeing about the version", () => {
    // Neither value ships — `tauri ios build` stamps the real one from
    // tauri.conf.json — but they drifted thirty minor versions apart, which
    // is how a regeneration silently hands a build the wrong era. Pin them
    // to each other: cheap, and it never needs touching at bump time.
    const plistVersion = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(
      infoPlist,
    )?.[1];
    const specVersion = /CFBundleShortVersionString:\s*([^\s]+)/.exec(projectSpec)?.[1];
    expect(plistVersion).toBeDefined();
    expect(specVersion).toBeDefined();
    expect(plistVersion).toBe(specVersion);
  });
});
