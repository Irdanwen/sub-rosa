// The phones' system surfaces (ADR-0095): iOS widgets, the Apple Watch app
// and its complication, the Android widget and share target. They are Swift
// and Kotlin built only by the release lanes, so the wiring that would only
// fail there (or, worse, only on a device) is pinned here.

import { describe, expect, it } from "vitest";
import shareReceiver from "../../src-tauri/android/src/main/java/xyz/carpediem/subrosa/nativebridge/ShareReceiverActivity.kt?raw";
import askWidgetProvider from "../../src-tauri/android/src/main/java/xyz/carpediem/subrosa/nativebridge/AskWidgetProvider.kt?raw";
import androidManifest from "../../src-tauri/android/src/main/AndroidManifest.xml?raw";
import androidStringsFr from "../../src-tauri/android/src/main/res/values-fr/strings.xml?raw";
import androidStrings from "../../src-tauri/android/src/main/res/values/strings.xml?raw";
import watchContent from "../../src-tauri/gen/apple/Watch/ContentView.swift?raw";
import watchEn from "../../src-tauri/gen/apple/Watch/en.lproj/Localizable.strings?raw";
import watchFr from "../../src-tauri/gen/apple/Watch/fr.lproj/Localizable.strings?raw";
import watchInfo from "../../src-tauri/gen/apple/Watch/Info.plist?raw";
import complication from "../../src-tauri/gen/apple/WatchWidgets/SubRosaWatchWidgets.swift?raw";
import complicationEn from "../../src-tauri/gen/apple/WatchWidgets/en.lproj/Localizable.strings?raw";
import complicationFr from "../../src-tauri/gen/apple/WatchWidgets/fr.lproj/Localizable.strings?raw";
import widgetsEn from "../../src-tauri/gen/apple/Widgets/en.lproj/Localizable.strings?raw";
import widgetsFr from "../../src-tauri/gen/apple/Widgets/fr.lproj/Localizable.strings?raw";
import widgets from "../../src-tauri/gen/apple/Widgets/SubRosaWidgets.swift?raw";
import widgetsEntitlements from "../../src-tauri/gen/apple/Widgets/Widgets.entitlements?raw";
import xcodeProject from "../../src-tauri/gen/apple/os-june.xcodeproj/project.pbxproj?raw";
import projectSpec from "../../src-tauri/gen/apple/project.yml?raw";
import versionScript from "../../scripts/sync-ios-version.mjs?raw";
import { parseDestination } from "../lib/destinations";

const APP_ID = "xyz.carpediem.subrosa";
const GROUP = "group.xyz.carpediem.subrosa";

function strings(table: string) {
  const entries = new Map<string, string>();
  for (const match of table.matchAll(/^"(.*)"\s*=\s*"(.*)";$/gm)) entries.set(match[1], match[2]);
  return entries;
}

/** The literal strings a SwiftUI view shows, which SwiftUI looks up. */
function shownLiterals(source: string) {
  const patterns = [
    /\bText\("([^"]+)"\)/g,
    /\bLabel\("([^"]+)"/g,
    /\bTextField\("([^"]+)"/g,
    /\.configurationDisplayName\("([^"]+)"\)/g,
    /\.description\("([^"]+)"\)/g,
    /title: "([^"]+)"/g,
  ];
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  // The product's name is the same in every language.
  found.delete("Sub Rosa");
  return [...found];
}

function targetSection(name: string) {
  return projectSpec.split(`  ${name}:\n`)[1]?.split(/\n {2}\S/)[0] ?? "";
}

describe("the iOS widgets and the Apple Watch app", () => {
  it("are targets of the committed project, embedded where iOS looks", () => {
    for (const target of ["os-june_Widgets", "os-june_Watch", "os-june_WatchWidgets"]) {
      expect(projectSpec).toContain(`  ${target}:\n`);
      expect(xcodeProject).toMatch(
        new RegExp(`/\\* ${target} \\*/ = \\{\\s*isa = PBXNativeTarget`),
      );
    }
    // A single-target watch app lives in the iPhone app's Watch folder.
    expect(xcodeProject).toContain('dstPath = "$(CONTENTS_FOLDER_PATH)/Watch";');
    expect(xcodeProject).toContain("os-june_Watch.app in Embed Dependencies");
    expect(xcodeProject).toContain("os-june_Widgets.appex in Embed Foundation Extensions");
    expect(xcodeProject).toContain("os-june_WatchWidgets.appex in Embed Foundation Extensions");
  });

  it("carry bundle ids that extend the app's, as the system requires", () => {
    expect(targetSection("os-june_Widgets")).toContain(
      `PRODUCT_BUNDLE_IDENTIFIER: ${APP_ID}.widgets`,
    );
    expect(targetSection("os-june_Watch")).toContain(
      `PRODUCT_BUNDLE_IDENTIFIER: ${APP_ID}.watchkitapp`,
    );
    expect(targetSection("os-june_WatchWidgets")).toContain(
      `PRODUCT_BUNDLE_IDENTIFIER: ${APP_ID}.watchkitapp.widgets`,
    );
    expect(watchInfo).toMatch(
      new RegExp(`<key>WKCompanionAppBundleIdentifier</key>\\s*<string>${APP_ID}</string>`),
    );
    expect(watchInfo).toMatch(/<key>WKApplication<\/key>\s*<true\/>/);
  });

  it("share the app group with the app, the share extension and the actions", () => {
    expect(widgetsEntitlements).toContain(`<string>${GROUP}</string>`);
    expect(targetSection("os-june_Widgets")).toContain(
      `        com.apple.security.application-groups:\n          - ${GROUP}`,
    );
  });

  it("open addresses the app answers, at the place they name", () => {
    const urls = [...widgets.matchAll(/URL\(string: "([^"]+)"\)/g)].map((match) => match[1]);
    expect(urls.map((url) => parseDestination(url))).toEqual([
      { kind: "chat", sessionId: undefined, query: undefined },
      { kind: "dictation", start: true },
      { kind: "record" },
    ]);
  });

  it("speak French wherever they speak English", () => {
    for (const [source, en, fr] of [
      [widgets, widgetsEn, widgetsFr],
      [watchContent, watchEn, watchFr],
      [complication, complicationEn, complicationFr],
    ]) {
      const english = strings(en);
      const french = strings(fr);
      expect([...french.keys()].sort()).toEqual([...english.keys()].sort());
      for (const literal of shownLiterals(source)) expect(english.has(literal)).toBe(true);
      for (const value of french.values()) expect(value).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("ship with the app's version, stamped by the same script", () => {
    for (const path of ["Widgets/Info.plist", "Watch/Info.plist", "WatchWidgets/Info.plist"]) {
      expect(versionScript).toContain(`"src-tauri/gen/apple/${path}"`);
    }
  });
});

describe("the Android widget and share target", () => {
  it("are declared in the native library's manifest", () => {
    expect(androidManifest).toContain("android.intent.action.SEND");
    expect(androidManifest).toContain("android.intent.action.SEND_MULTIPLE");
    expect(androidManifest).toContain("nativebridge.ShareReceiverActivity");
    expect(androidManifest).toContain("nativebridge.AskWidgetProvider");
    expect(androidManifest).toContain('android:resource="@xml/subrosa_widget_info"');
  });

  it("open the same addresses as the iPhone widgets", () => {
    const urls = [...askWidgetProvider.matchAll(/= "(subrosa:\/\/[^"]+)"/g)].map((m) => m[1]);
    expect(urls.map((url) => parseDestination(url)?.kind)).toEqual(["chat", "dictation", "record"]);
    expect(shareReceiver).toContain('Uri.parse("subrosa://share/$id")');
    expect(parseDestination("subrosa://share/3f2c1a9e-aa10-4b6e-9d1c-0f1e2d3c4b5a")?.kind).toBe(
      "share",
    );
  });

  it("speak French wherever they speak English", () => {
    const names = (xml: string) => [...xml.matchAll(/<string name="([^"]+)"/g)].map((m) => m[1]);
    expect(names(androidStringsFr).sort()).toEqual(names(androidStrings).sort());
    expect(androidStringsFr).not.toMatch(/[\u2013\u2014]/);
  });
});
