import { platform } from "@tauri-apps/plugin-os";

/**
 * Dynamic Type bridge: WKWebView resolves the `-apple-system-body` font
 * keyword to the user's preferred iOS text size (17px at the default setting,
 * larger/smaller as the user scales). Measuring it once at boot gives a
 * factor the mobile type tokens multiply into (see `--dynamic-type` in
 * mobile.css), so the whole shell honors the system text-size setting.
 *
 * iOS-only on purpose: other engines drop the unknown keyword and the probe
 * would just read the inherited size, skewing the factor.
 */
export function initDynamicType() {
  try {
    if (platform() !== "ios") return;
  } catch {
    return;
  }
  try {
    const probe = document.createElement("div");
    probe.style.font = "-apple-system-body";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.textContent = "probe";
    document.body.appendChild(probe);
    const size = Number.parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    if (!Number.isFinite(size) || size <= 0) return;
    // Clamp: tiny sizes stay legible, huge accessibility sizes scale the type
    // without exploding fixed chrome (which stays px-bound by design).
    const factor = Math.min(1.4, Math.max(0.9, size / 17));
    document.documentElement.style.setProperty("--dynamic-type", String(factor));
  } catch {
    // A failed probe simply leaves the default scale in place.
  }
}
