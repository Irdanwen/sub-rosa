import { describe, expect, it } from "vitest";
import appEntitlements from "../../src-tauri/gen/apple/os-june_iOS/os-june_iOS.entitlements?raw";
import shareEntitlements from "../../src-tauri/gen/apple/ShareExtension/ShareExtension.entitlements?raw";
import projectSpec from "../../src-tauri/gen/apple/project.yml?raw";
import xcodeProject from "../../src-tauri/gen/apple/os-june.xcodeproj/project.pbxproj?raw";
import shareController from "../../src-tauri/gen/apple/ShareExtension/ShareViewController.swift?raw";
import shareInbox from "../../src-tauri/src/share_inbox.rs?raw";

const group = "group.xyz.carpediem.subrosa";
const entitlement = "com.apple.security.application-groups";

describe("iOS share inbox access", () => {
  it("links Rust without copying static libraries into the app resources", () => {
    expect(xcodeProject).toContain("libapp.a in Frameworks");
    expect(xcodeProject).not.toContain("libapp.a in Resources");
    expect(projectSpec).not.toMatch(/^\s*- path: Externals\s*$/m);
    expect(projectSpec).toContain("- framework: libapp.a");
  });

  for (const [target, plist] of [
    ["os-june_iOS", appEntitlements],
    ["os-june_Share", shareEntitlements],
  ]) {
    it(`grants ${target} the shared container used by the writer and reader`, () => {
      const xml = new DOMParser().parseFromString(plist, "application/xml");
      expect(xml.querySelector("parsererror")).toBeNull();
      const key = Array.from(xml.querySelectorAll("dict > key")).find(
        (node) => node.textContent === entitlement,
      );
      expect(key?.nextElementSibling?.tagName).toBe("array");
      const groups = Array.from(key?.nextElementSibling?.querySelectorAll("string") ?? []).map(
        (node) => node.textContent,
      );
      expect(groups).toEqual([group]);
      expect(shareController).toContain(`appGroup = "${group}"`);
      expect(shareInbox).toContain(`APP_GROUP: &str = "${group}"`);
    });

    it(`retains ${target}'s access when XcodeGen regenerates entitlements`, () => {
      const targetSection = projectSpec.split(`  ${target}:\n`)[1]?.split(/\n {2}\S/)[0];
      const block = targetSection?.match(/ {4}entitlements:\n([\s\S]*?)(?=\n {4}\S|$)/)?.[1];
      expect(block).toBeDefined();
      expect(block).toContain("      properties:\n");
      expect(block).toContain(`        ${entitlement}:\n          - ${group}`);
    });
  }
});
