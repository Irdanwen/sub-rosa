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
// The desktop asks too, but only for the one kind of work that is long
// enough to leave the window for: a Studio render or a workflow run. A chat
// turn and a dictation finish in front of you there. Rust then posts the
// notification only if the window is not in front and the wait was long
// (`carpe_diem::jobs::desktop_should_notify`), so the prompt is asked at the
// moment it explains itself and the notification arrives only when it helps.

import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { isMobilePlatform } from "./mobile";

let permissionRequest: Promise<boolean> | null = null;

/** What the user just started; decides whether the desktop asks at all. */
export type NotificationReason = "studio" | "dictation" | "chat";

/** Ask for notification permission once, memoised. Call it when the user starts
 * something that can finish while they are in another app. */
export function ensureNotificationPermission(
  reason: NotificationReason = "chat",
): Promise<boolean> {
  if (!isMobilePlatform() && reason !== "studio") return Promise.resolve(false);
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
