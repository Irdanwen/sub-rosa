import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const entitlements = readFileSync(resolve(root, "src-tauri/Entitlements.plist"), "utf8");
const macosConfig = JSON.parse(
  readFileSync(resolve(root, "src-tauri/tauri.macos.conf.json"), "utf8"),
) as { bundle?: { macOS?: { files?: Record<string, string> } } };

// A Developer ID app that claims a restricted entitlement (every
// `com.apple.developer.*` key) must embed a provisioning profile granting it.
// Without one, AMFI kills the binary at launch: signing and notarization both
// pass, and the app simply never opens. 1.74.0 shipped exactly that with the
// passkeys' associated domains. The same plist also signs the helper apps.
describe("macOS entitlements", () => {
  it("claims no restricted entitlement unless a provisioning profile is embedded", () => {
    const restricted = [
      ...entitlements.matchAll(/<key>(com\.apple\.developer\.[^<]+)<\/key>/g),
    ].map((match) => match[1]);
    const embedsProfile = Object.keys(macosConfig.bundle?.macOS?.files ?? {}).some((target) =>
      target.endsWith("embedded.provisionprofile"),
    );
    if (!embedsProfile) {
      expect(restricted).toEqual([]);
    }
  });
});
