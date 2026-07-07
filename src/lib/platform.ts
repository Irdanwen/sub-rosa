import { platform as osPlatform } from "@tauri-apps/plugin-os";

let cachedMacDesktop: boolean | null = null;

/**
 * True only on the macOS desktop shell (not iOS, not Windows). Used to gate
 * macOS-only affordances such as copying a file to the NSPasteboard. Resolved
 * from plugin-os `platform()`, which the native layer injects before the
 * webview loads; in a plain browser (vitest) the plugin throws and we treat
 * the platform as non-macOS.
 */
export function isMacDesktopPlatform(): boolean {
  if (cachedMacDesktop !== null) return cachedMacDesktop;
  try {
    cachedMacDesktop = osPlatform() === "macos";
  } catch {
    cachedMacDesktop = false;
  }
  return cachedMacDesktop;
}

export function isMacLikePlatform() {
  const platform =
    typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`;
  if (/Windows|Win32|Win64|Linux|Android/i.test(platform)) {
    return false;
  }
  return true;
}

export function primaryShortcutLabel(key: string) {
  // No space after the ⌘ glyph (it reads tight), but keep one after the
  // "Ctrl" word so Windows labels don't run together as "CtrlN".
  return isMacLikePlatform() ? `⌘${key}` : `Ctrl ${key}`;
}

export function primaryShiftShortcutLabel(key: string) {
  return isMacLikePlatform() ? `⌘⇧${key}` : `Ctrl Shift ${key}`;
}

export function isPrimaryShortcut(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
) {
  if (event.altKey || event.shiftKey) return false;
  if (isMacLikePlatform()) {
    return event.metaKey && !event.ctrlKey;
  }
  return event.ctrlKey && !event.metaKey;
}
