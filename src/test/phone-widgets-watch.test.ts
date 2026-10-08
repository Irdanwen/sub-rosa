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
import xcodeProject from "../../src-tauri/gen/apple/os-june.xcodeproj/project.pbxproj?raw";
import watchScheme from "../../src-tauri/gen/apple/os-june.xcodeproj/xcshareddata/xcschemes/os-june_Watch.xcscheme?raw";
import projectSpec from "../../src-tauri/gen/apple/project.yml?raw";
import releaseLane from "../../.github/workflows/ios-release.yml?raw";
import versionScript from "../../scripts/sync-ios-version.mjs?raw";
import { parseDestination } from "../lib/destinations";

// Every language of the app's catalog, as Apple names its .lproj folders.
const APP_REGIONS = ["en", "fr", "de", "it", "es", "pt-BR"];
const APPLE_STRINGS = import.meta.glob(
  [
    "../../src-tauri/gen/apple/{Widgets,Watch,WatchWidgets}/*.lproj/Localizable.strings",
    "../../src-tauri/gen/apple/Sources/os-june/Intents/*.lproj/*.strings",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;
const ANDROID_STRINGS = import.meta.glob(
  "../../src-tauri/android/src/main/res/values*/strings.xml",
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
) as Record<string, string>;

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
    expect(xcodeProject).toContain("os-june_Widgets.appex in Embed Foundation Extensions");
    expect(xcodeProject).toContain("os-june_WatchWidgets.appex in Embed Foundation Extensions");
  });

  // Tauri builds the app with `-sdk iphoneos` (`iphonesimulator` in dev),
  // which drags every dependency onto the iPhone SDK, where watchOS code does
  // not compile: the 1.89.0 archive failed on the complication. The watch app
  // is built for watchOS by the release lane and put where Xcode would embed
  // a single-target watch app, the iPhone app's Watch folder.
  it("keep the watch app out of Tauri's build, and the lane puts it in the archive", () => {
    expect(targetSection("os-june_iOS")).not.toContain("target: os-june_Watch");
    expect(xcodeProject).not.toContain('dstPath = "$(CONTENTS_FOLDER_PATH)/Watch";');
    expect(xcodeProject).not.toContain("os-june_Watch.app in Embed Dependencies");
    expect(xcodeProject).not.toMatch(/target = 43B02D75B7A298F894A9A778 \/\* os-june_Watch \*\/;/);
    expect(watchScheme).toContain('BlueprintName = "os-june_Watch"');
    expect(targetSection("os-june_Watch")).toContain("SKIP_INSTALL: false");
    expect(targetSection("os-june_WatchWidgets")).toContain("SKIP_INSTALL: true");
    expect(releaseLane).toMatch(
      /-target os-june_Watch -sdk watchos -configuration release install/,
    );
    expect(releaseLane).toContain('"$APP/Watch/SubRosaWatch.app"');
    // Before the bundles without a profile leave, and before the stamp counts them.
    const embed = releaseLane.indexOf("name: Put the watch app in the archive");
    expect(embed).toBeGreaterThan(releaseLane.indexOf("name: Archive via Tauri"));
    expect(embed).toBeLessThan(releaseLane.indexOf("name: Leave out the bundles"));
    expect(embed).toBeLessThan(
      releaseLane.indexOf("name: Stamp the build number into the archive"),
    );
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

  // Buttons that open addresses read nothing the app keeps. Without the app
  // group, the release lane can register their App ID and make their profile
  // through the API alone (scripts/ios-signing.mjs): no portal step.
  it("stay out of the app group, which they do not read", () => {
    expect(targetSection("os-june_Widgets")).not.toContain("entitlements:");
    expect(xcodeProject).not.toContain("Widgets/Widgets.entitlements");
    expect(widgets).not.toMatch(/suiteName|containerURL|securityApplicationGroupIdentifier/);
    expect(widgets).not.toContain(GROUP);
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

  it("speak every language the app speaks", () => {
    const names = (xml: string) => [...xml.matchAll(/<string name="([^"]+)"/g)].map((m) => m[1]);
    const folders = Object.keys(ANDROID_STRINGS).map((path) => path.split("/").at(-2));
    expect(folders.sort()).toEqual(
      ["values", "values-de", "values-es", "values-fr", "values-it", "values-pt-rBR"].sort(),
    );
    for (const [path, xml] of Object.entries(ANDROID_STRINGS)) {
      expect(names(xml).sort(), path).toEqual(names(androidStrings).sort());
      expect(xml, path).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("the native strings in every language", () => {
  it("have one table per language for each widget, the watch and the actions", () => {
    const byTable = new Map<string, string[]>();
    for (const path of Object.keys(APPLE_STRINGS)) {
      const [, table, region] = path.match(/apple\/(.+)\/([\w-]+)\.lproj\/[^/]+$/) ?? [];
      const key = `${table}/${path.split("/").at(-1)}`;
      byTable.set(key, [...(byTable.get(key) ?? []), region]);
    }
    expect(byTable.size).toBe(5);
    for (const [table, regions] of byTable) {
      expect(regions.sort(), table).toEqual([...APP_REGIONS].sort());
    }
  });

  it("translate every key of the English table, keep placeholders and use no dash", () => {
    for (const [path, table] of Object.entries(APPLE_STRINGS)) {
      const english = strings(APPLE_STRINGS[path.replace(/[\w-]+\.lproj/, "en.lproj")]);
      const translated = strings(table);
      expect([...translated.keys()].sort(), path).toEqual([...english.keys()].sort());
      for (const [key, value] of translated) {
        expect(value, path).not.toMatch(/[\u2013\u2014]/);
        expect(value.trim(), path).not.toBe("");
        for (const variable of key.match(/\$\{\w+\}/g) ?? [])
          expect(value, path).toContain(variable);
      }
    }
  });

  it("are declared to the system and the project", () => {
    const declared = (yml: string) =>
      [...yml.matchAll(/CFBundleLocalizations: \[([^\]]+)\]/g)].map((m) => m[1].split(/,\s*/));
    for (const list of declared(projectSpec)) expect(list.sort()).toEqual([...APP_REGIONS].sort());
    for (const region of APP_REGIONS) {
      expect(xcodeProject).toMatch(new RegExp(`knownRegions = \\([^)]*\\b"?${region}"?,`));
    }
  });
});
