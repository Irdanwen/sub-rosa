// Notification permission for work that finishes while the app is away.
//
// The notifications themselves are posted from Rust (`carpe_diem::jobs`,
// `dictation_mobile`, `agent_lite`), because the whole point is to reach the
// user while the app is *not* on screen — a moment when this webview is frozen
// and could not post anything. What stays here is the permission request, which
// has to happen in the foreground.
//
// It is deliberately asked in context rather than at launch: the call sites are
// the three places where the user starts something that can outlive the
// foreground session (a Studio generation, a dictation, a chat turn), so the
// iOS prompt appears in a moment that explains itself. The promise is memoised,
// so at most one prompt is ever shown.
//
// Desktop is deliberately left alone: it has never prompted for notification
// permission, and work finishing there is visible in the window anyway.

import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { isMobilePlatform } from "./mobile";

let permissionRequest: Promise<boolean> | null = null;

/** Ask for notification permission once, memoised. Call it when the user starts
 * something that can finish while they are in another app. */
export function ensureNotificationPermission(): Promise<boolean> {
  if (!isMobilePlatform()) return Promise.resolve(false);
  permissionRequest ??= (async () => {
    let granted = await isPermissionGranted().catch(() => false);
    if (!granted) {
      const permission = await requestPermission().catch(() => "denied" as const);
      granted = permission === "granted";
    }
    return granted;
  })();
  return permissionRequest;
}
