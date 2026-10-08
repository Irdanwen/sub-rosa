// Health's native halves (ADR-0099) are declarations as much as code: a
// permission missing from the manifest, a measure the bridge does not map,
// or a language without its rationale is a store rejection or a silent
// empty chart, never a red build. This pins them to each other.

import { describe, expect, it } from "vitest";
import healthBridge from "../../src-tauri/native/health-kit/HealthBridge.m?raw";
import androidManifest from "../../src-tauri/android/src/main/AndroidManifest.xml?raw";
import healthConnect from "../../src-tauri/android/src/main/java/xyz/carpediem/subrosa/nativebridge/HealthConnect.kt?raw";
import plugin from "../../src-tauri/android/src/main/java/xyz/carpediem/subrosa/nativebridge/SubRosaPlugin.kt?raw";
import gradle from "../../src-tauri/android/build.gradle.kts?raw";
import entitlements from "../../src-tauri/gen/apple/os-june_iOS/os-june_iOS.entitlements?raw";
import projectSpec from "../../src-tauri/gen/apple/project.yml?raw";
import pbxproj from "../../src-tauri/gen/apple/os-june.xcodeproj/project.pbxproj?raw";
import { HEALTH_METRICS } from "../lib/health";

const androidStrings = import.meta.glob(
  "../../src-tauri/android/src/main/res/values*/strings.xml",
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
) as Record<string, string>;
const infoPlistStrings = import.meta.glob(
  "../../src-tauri/gen/apple/os-june_iOS/*.lproj/InfoPlist.strings",
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
) as Record<string, string>;

const ANDROID_PERMISSIONS = [
  "READ_STEPS",
  "READ_SLEEP",
  "READ_HEART_RATE",
  "READ_RESTING_HEART_RATE",
  "READ_EXERCISE",
  "READ_WEIGHT",
];

describe("Health on the iPhone", () => {
  it("maps every measure the app offers", () => {
    for (const metric of HEALTH_METRICS) {
      expect(healthBridge).toContain(`@"${metric}"`);
    }
  });

  it("asks to read only", () => {
    expect(healthBridge).toContain("requestAuthorizationToShareTypes:nil");
  });

  it("carries the HealthKit entitlement in the file and in project.yml, and links the framework", () => {
    expect(entitlements).toContain("<key>com.apple.developer.healthkit</key>");
    expect(projectSpec).toContain("com.apple.developer.healthkit: true");
    expect(projectSpec).toContain("- sdk: HealthKit.framework");
    expect(pbxproj).toContain("HealthKit.framework in Frameworks");
    expect(pbxproj).toContain("InfoPlist.strings in Resources");
  });

  it("explains itself in every language the app speaks", () => {
    const languages = Object.keys(infoPlistStrings).map((path) => path.split("/").at(-2));
    expect(languages.sort()).toEqual(
      ["de.lproj", "en.lproj", "es.lproj", "fr.lproj", "it.lproj", "pt-BR.lproj"].sort(),
    );
    for (const text of Object.values(infoPlistStrings)) {
      expect(text).toMatch(/"NSHealthShareUsageDescription" = ".+";/);
      expect(text).not.toMatch(/[–—]/);
    }
  });
});

describe("Health on Android", () => {
  it("declares only read permissions, one per measure", () => {
    for (const permission of ANDROID_PERMISSIONS) {
      expect(androidManifest).toContain(`android.permission.health.${permission}`);
    }
    expect(androidManifest).not.toMatch(/android\.permission\.health\.WRITE_/);
    for (const metric of HEALTH_METRICS) {
      expect(healthConnect).toContain(`"${metric}" to HealthPermission.getReadPermission`);
    }
  });

  it("offers the permission rationale Health Connect requires, before and after Android 14", () => {
    expect(androidManifest).toContain("androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE");
    expect(androidManifest).toContain("android.intent.action.VIEW_PERMISSION_USAGE");
    expect(androidManifest).toContain("android.intent.category.HEALTH_PERMISSIONS");
    expect(androidManifest).toContain("com.google.android.apps.healthdata");
    expect(Object.keys(androidStrings).length).toBe(6);
    for (const strings of Object.values(androidStrings)) {
      expect(strings).toContain('name="subrosa_health_rationale_title"');
      expect(strings).toContain('name="subrosa_health_rationale_body"');
    }
  });

  it("exposes the three commands Rust calls and builds against Health Connect", () => {
    for (const command of ["healthAvailability", "healthRequest", "healthDaily"]) {
      expect(plugin).toContain(`fun ${command}(`);
    }
    expect(gradle).toContain("androidx.health.connect:connect-client");
  });
});
