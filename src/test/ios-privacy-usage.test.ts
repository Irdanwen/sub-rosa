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
import xcodeProject from "../../src-tauri/gen/apple/os-june.xcodeproj/project.pbxproj?raw";
import projectSpec from "../../src-tauri/gen/apple/project.yml?raw";
import shareExtensionPlist from "../../src-tauri/gen/apple/ShareExtension/Info.plist?raw";
import watchPlist from "../../src-tauri/gen/apple/Watch/Info.plist?raw";
import watchWidgetsPlist from "../../src-tauri/gen/apple/WatchWidgets/Info.plist?raw";
import widgetsPlist from "../../src-tauri/gen/apple/Widgets/Info.plist?raw";
import macosInfoPlist from "../../src-tauri/Info.plist?raw";
import tauriConfig from "../../src-tauri/tauri.conf.json";
import macosConfig from "../../src-tauri/tauri.macos.conf.json";
import { SUPPORTED_LOCALES } from "../lib/i18n";

/** The usage descriptions per language, one `InfoPlist.strings` per `.lproj`. */
const USAGE_STRINGS = import.meta.glob(
  "../../src-tauri/gen/apple/os-june_iOS/*.lproj/InfoPlist.strings",
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/** Every bundle inside the app, whose versions must match the app's. */
const extensionPlists = [shareExtensionPlist, widgetsPlist, watchPlist, watchWidgetsPlist];

/** Each protected resource the app actually reaches for, and what reaches it. */
const REQUIRED_USAGE_KEYS: Array<{ key: string; reachedBy: string }> = [
  {
    key: "NSMicrophoneUsageDescription",
    reachedBy: "recording a note or a dictation, and the voice conversation",
  },
  {
    key: "NSAudioCaptureUsageDescription",
    reachedBy: "the microphone plus system audio source",
  },
  {
    key: "NSCameraUsageDescription",
    reachedBy:
      "the chat attachment picker, Studio's capture=\"environment\" button, the document scanner (VisionKit) and the voice conversation's camera",
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

  it("answers the export compliance question in the bundle", () => {
    // Without it App Store Connect holds every build as "missing compliance"
    // and TestFlight never hands it to a tester: builds 1.63.0 through 1.65.64
    // all sat VALID and undelivered. The answer matches the one already given
    // by hand for every build up to 1.62.0.
    expect(infoPlist).toMatch(/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<(true|false)\/>/);
  });

  it("gives every iOS bundle the version the app ships", () => {
    // `tauri ios build` stamps the app from tauri.conf.json and leaves the
    // share extension alone, so the extension shipped 1.63.0 inside a 1.65.2
    // app and App Store Connect answered ITMS-90473. Pin the version a person
    // reads to the one source; `pnpm ios:version` rewrites them.
    const shortVersions = [
      ...[infoPlist, ...extensionPlists].flatMap((plist) => [
        ...plist.matchAll(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/g),
      ]),
      ...projectSpec.matchAll(/CFBundleShortVersionString:\s*"?([\d.]+)"?/g),
    ].map((match) => match[1]);
    // The app, its share extension, its widgets, the watch app and its
    // complication, each in its plist and in project.yml.
    expect(shortVersions.length).toBeGreaterThanOrEqual(10);
    expect([...new Set(shortVersions)]).toEqual([tauriConfig.version]);
  });

  it("gives every iOS bundle one build number", () => {
    // CFBundleVersion is a counter Apple requires to be unique and rising, so
    // it is not the app version: a delivery rejected for signing could never be
    // sent again under its own version. CI stamps the run number into all three
    // at once, and they are worthless unless they agree with each other.
    const buildNumbers = [
      ...[infoPlist, ...extensionPlists].flatMap((plist) => [
        ...plist.matchAll(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/g),
      ]),
      ...projectSpec.matchAll(/CFBundleVersion:\s*"?([\d.]+)"?/g),
    ].map((match) => match[1]);
    expect(buildNumbers.length).toBeGreaterThanOrEqual(10);
    expect(new Set(buildNumbers).size).toBe(1);
  });
});

/** `"key" = "value";` lines of a .strings table. */
function stringsTable(source: string): Map<string, string> {
  return new Map(
    [...source.matchAll(/^"([^"]+)"\s*=\s*"((?:[^"\\]|\\.)*)";$/gm)].map((match) => [
      match[1],
      match[2],
    ]),
  );
}

/** Every usage description a plist declares, with its English text. */
function usageDescriptions(plist: string): Map<string, string> {
  return new Map(
    [...plist.matchAll(/<key>(NS\w+UsageDescription)<\/key>\s*<string>([^<]*)<\/string>/g)].map(
      (match) => [match[1], match[2]],
    ),
  );
}

// The prompt is the one sentence of the app a person reads before the app has
// any say in its language: the system shows it in the system's language, and
// until these tables existed that was English for everyone (ADR-0047).
describe("usage descriptions in every language", () => {
  const tables = new Map(
    Object.entries(USAGE_STRINGS).map(([path, source]) => [
      path.match(/([\w-]+)\.lproj\/InfoPlist\.strings$/)?.[1] ?? path,
      stringsTable(source),
    ]),
  );
  const english = usageDescriptions(infoPlist);

  it("has one table per language of the app", () => {
    expect([...tables.keys()].sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it("translates every usage key the iPhone and the Mac declare", () => {
    const declared = new Set([...english.keys(), ...usageDescriptions(macosInfoPlist).keys()]);
    for (const { key } of REQUIRED_USAGE_KEYS) expect(declared).toContain(key);
    for (const [region, table] of tables) {
      for (const key of declared) {
        const value = table.get(key) ?? "";
        expect(value.trim(), `${region} ${key}`).not.toBe("");
        expect(value, `${region} ${key}`).not.toMatch(/[\u2013\u2014]/);
        if (region !== "en") expect(value, `${region} ${key}`).not.toBe(english.get(key));
      }
    }
  });

  it("keeps the English table equal to the plist it falls back to", () => {
    const table = tables.get("en");
    for (const [key, value] of english) expect(table?.get(key), key).toBe(value);
  });

  it("ships the tables in the iPhone app", () => {
    for (const region of SUPPORTED_LOCALES) {
      const path = region.includes("-")
        ? `path = "${region}.lproj/InfoPlist.strings"`
        : `path = ${region}.lproj/InfoPlist.strings`;
      expect(xcodeProject).toContain(path);
    }
    expect(xcodeProject).toContain("/* InfoPlist.strings in Resources */,");
  });

  it("ships the same tables in the Mac app", () => {
    const files = (macosConfig.bundle.macOS as { files: Record<string, string> }).files;
    for (const region of SUPPORTED_LOCALES) {
      expect(files[`Resources/${region}.lproj/InfoPlist.strings`]).toBe(
        `gen/apple/os-june_iOS/${region}.lproj/InfoPlist.strings`,
      );
    }
    expect(macosInfoPlist).toContain("<key>CFBundleLocalizations</key>");
  });
});
