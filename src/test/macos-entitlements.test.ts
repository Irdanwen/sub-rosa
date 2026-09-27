import { describe, expect, it } from "vitest";
import buildScript from "../../src-tauri/build.rs?raw";
import profile from "../../src-tauri/embedded.provisionprofile?raw";
import entitlements from "../../src-tauri/Entitlements.plist?raw";
import helperEntitlements from "../../src-tauri/HelperEntitlements.plist?raw";
import macosConfig from "../../src-tauri/tauri.macos.conf.json";

// Read through Vite (?raw / JSON import), never node:fs: the test tsconfig
// has no @types/node.
//
// A Developer ID app that claims a restricted entitlement (every
// `com.apple.developer.*` key) must embed a provisioning profile granting it.
// Without one, AMFI kills the binary at launch: signing and notarization both
// pass, and the app simply never opens. 1.74.0 shipped exactly that with the
// passkeys' associated domains. The profile only covers the app itself, so
// nothing else in the bundle may carry those keys: Tauri signs every
// externalBin with the app's entitlements (hence the macOS sidecar ships
// through bundle.macOS.files, pre-signed), and build.rs signs the helpers.
const restrictedKeys = (plist: string) =>
  [...plist.matchAll(/<key>(com\.apple\.developer\.[^<]+)<\/key>/g)].map((match) => match[1]);

const bundle = macosConfig.bundle as {
  externalBin?: string[];
  macOS: { files?: Record<string, string> };
};

describe("macOS entitlements", () => {
  const restricted = restrictedKeys(entitlements);

  it("embeds a provisioning profile whenever the app claims a restricted entitlement", () => {
    const embedsProfile = Object.keys(bundle.macOS.files ?? {}).some((target) =>
      target.endsWith("embedded.provisionprofile"),
    );
    if (restricted.length > 0) {
      expect(embedsProfile).toBe(true);
    }
  });

  it("claims only what the embedded profile grants, for the profile's app", () => {
    for (const key of restricted) {
      if (key === "com.apple.developer.team-identifier") continue;
      expect(profile).toContain(`<key>${key}</key>`);
    }
    if (restricted.length > 0) {
      expect(entitlements).toContain("<string>H6N5V777LL.xyz.carpediem.subrosa</string>");
      expect(profile).toContain("<string>H6N5V777LL.xyz.carpediem.subrosa</string>");
    }
  });

  it("keeps restricted entitlements off the sidecar and the helpers", () => {
    expect(restrictedKeys(helperEntitlements)).toEqual([]);
    expect(buildScript).toContain('manifest_dir.join("HelperEntitlements.plist")');
    if (restricted.length > 0) {
      expect(bundle.externalBin ?? []).toEqual([]);
      expect(bundle.macOS.files?.["MacOS/june-api"]).toBe("binaries/june-api-macos");
    }
  });
});
