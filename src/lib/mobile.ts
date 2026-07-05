import { platform } from "@tauri-apps/plugin-os";

let cached: boolean | null = null;

/**
 * Whether the app is running inside the mobile (iOS/Android) shell.
 *
 * Resolved once at startup: the plugin-os `platform()` value is injected by
 * the native layer before the webview loads, so this is synchronous. In a
 * plain browser (vite dev, vitest) the plugin throws; `?mobile=1` forces the
 * mobile shell there so mobile screens can be developed and tested without a
 * simulator (see browser-test-tauri-fe).
 */
export function isMobilePlatform(): boolean {
  if (cached !== null) return cached;
  if (typeof window !== "undefined" && window.location?.search.includes("mobile=1")) {
    cached = true;
    return cached;
  }
  try {
    const value = platform();
    cached = value === "ios" || value === "android";
  } catch {
    cached = false;
  }
  return cached;
}
