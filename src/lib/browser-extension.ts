import { invoke } from "@tauri-apps/api/core";

/**
 * Settings › Browser extension (ADR-0100). The extension reaches the app
 * through native messaging: "Connect a browser" registers the app as the
 * host for each browser found and shows a pairing code; the extension
 * trades the code for a token. Desktop only.
 */

export type ExtensionBrowserId = "chrome" | "edge" | "brave" | "firefox";

export type ExtensionBrowser = {
  id: ExtensionBrowserId;
  /** A brand name, shown as is. */
  label: string;
  /** Installed and opened at least once for this user. */
  found: boolean;
  /** The app is registered as this browser's host. */
  registered: boolean;
};

export type PairedBrowser = {
  id: string;
  /** What the extension said it runs in: "chrome", "edge", "firefox"... */
  browser: string;
  pairedAt: string;
  lastSeenAt: string;
};

export type BrowserExtensionStatus = {
  browsers: ExtensionBrowser[];
  paired: PairedBrowser[];
  pairing: { code: string; expiresAt: string } | null;
  listening: boolean;
};

/** Sent when a browser pairs or is forgotten from the extension. */
export const BROWSER_EXTENSION_CHANGED_EVENT = "browser-extension://changed";

export function browserExtensionStatus() {
  return invoke<BrowserExtensionStatus>("browser_extension_status");
}

/** Registers with every browser found (or the ones named) and shows a code. */
export function connectBrowserExtension(browsers?: ExtensionBrowserId[]) {
  return invoke<BrowserExtensionStatus>("browser_extension_connect", {
    browsers: browsers ?? null,
  });
}

export function cancelBrowserExtensionPairing() {
  return invoke<BrowserExtensionStatus>("browser_extension_cancel_pairing");
}

export function forgetPairedBrowser(id: string) {
  return invoke<BrowserExtensionStatus>("browser_extension_forget", { id });
}

/** Removes every registration and every pairing. */
export function disconnectBrowserExtension() {
  return invoke<BrowserExtensionStatus>("browser_extension_disconnect");
}

/** "123456" as the screen shows it: two groups of three. */
export function formatPairingCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** The brand name for what an extension reported it runs in. */
export function pairedBrowserName(browser: string): string {
  switch (browser) {
    case "chrome":
      return "Google Chrome";
    case "edge":
      return "Microsoft Edge";
    case "brave":
      return "Brave";
    case "firefox":
      return "Firefox";
    default:
      return browser;
  }
}
