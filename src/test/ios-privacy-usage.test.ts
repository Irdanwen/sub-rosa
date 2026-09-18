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
import shareExtensionPlist from "../../src-tauri/gen/apple/ShareExtension/Info.plist?raw";
import tauriConfig from "../../src-tauri/tauri.conf.json";

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
  // Two keys, one resource: iOS 17 renamed it, the deployment target is 15,
  // so the app has to satisfy both systems (crate::calendar asks with
  // whichever selector the OS answers to).
  { key: "NSCalendarsUsageDescription", reachedBy: "reading the day a recording belongs to" },
  {
    key: "NSCalendarsFullAccessUsageDescription",
    reachedBy: "the same read on iOS 17+, which renamed the key",
  },
  // Same two-key dance for reminders, reached only when the user taps to
  // accept a follow-up the assistant proposed (crate::actions).
  { key: "NSRemindersUsageDescription", reachedBy: "accepting a proposed reminder" },
  {
    key: "NSRemindersFullAccessUsageDescription",
    reachedBy: "the same write on iOS 17+, which renamed the key",
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

  it("gives every iOS bundle the version the app ships", () => {
    // `tauri ios build` stamps the app from tauri.conf.json and leaves the
    // share extension alone, so the extension shipped 1.63.0 inside a 1.65.2
    // app and App Store Connect answered ITMS-90473. Pin the version a person
    // reads to the one source; `pnpm ios:version` rewrites them.
    const shortVersions = [
      ...infoPlist.matchAll(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/g),
      ...shareExtensionPlist.matchAll(
        /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/g,
      ),
      ...projectSpec.matchAll(/CFBundleShortVersionString:\s*"?([\d.]+)"?/g),
    ].map((match) => match[1]);
    expect(shortVersions.length).toBeGreaterThanOrEqual(3);
    expect([...new Set(shortVersions)]).toEqual([tauriConfig.version]);
  });

  it("gives every iOS bundle one build number", () => {
    // CFBundleVersion is a counter Apple requires to be unique and rising, so
    // it is not the app version: a delivery rejected for signing could never be
    // sent again under its own version. CI stamps the run number into all three
    // at once, and they are worthless unless they agree with each other.
    const buildNumbers = [
      ...infoPlist.matchAll(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/g),
      ...shareExtensionPlist.matchAll(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/g),
      ...projectSpec.matchAll(/CFBundleVersion:\s*"?([\d.]+)"?/g),
    ].map((match) => match[1]);
    expect(buildNumbers.length).toBeGreaterThanOrEqual(3);
    expect(new Set(buildNumbers).size).toBe(1);
  });
});
