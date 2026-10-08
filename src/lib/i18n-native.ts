import { invoke } from "@tauri-apps/api/core";
import type { Locale } from "./i18n";

/**
 * Tells Rust the language the webview resolved, so the notifications it
 * posts by itself (moments, assignments, research, Studio) speak it too
 * (ADR-0047 addendum). Rust keeps it on disk for a launch that posts before
 * the webview loads. Best-effort: outside the app shell, or on failure,
 * Rust keeps the language it had.
 */
export function tellNativeLocale(locale: Locale): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.resolve();
  }
  return invoke("i18n_set_locale", { locale }).then(
    () => undefined,
    () => undefined,
  );
}
