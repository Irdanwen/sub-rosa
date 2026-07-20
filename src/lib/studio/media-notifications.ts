// Local notifications for finished Studio generations. iOS suspends the app
// process in the background, so a multi-minute render cannot progress while the
// app is away; what this gives us is best-effort: the moment a job completes
// (in the foreground, or right after the user reopens the app and the poll
// resumes) we post a local notification so long generations do not require
// babysitting. The notification plugin + permission are already wired
// (see lib.rs / capabilities); this only drives them from the media flow.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { isMobilePlatform } from "../mobile";
import type { PersistedJobKind } from "./async-job";

let permissionRequest: Promise<boolean> | null = null;

/** Ask for notification permission once, memoised. Call it when the user queues
 * a long generation so the iOS prompt appears in a moment that explains itself. */
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

const KIND_TITLE: Record<PersistedJobKind, string> = {
  video: "Your video is ready",
  music: "Your track is ready",
  image: "Your image is ready",
  sfx: "Your sound effect is ready",
};

/** Post a "generation ready" notification, if permission was granted. Silently
 * does nothing on desktop or when permission is missing. */
export async function notifyMediaJobDone(kind: PersistedJobKind, prompt: string): Promise<void> {
  if (!isMobilePlatform()) return;
  const granted = await isPermissionGranted().catch(() => false);
  if (!granted) return;
  const body = prompt.trim().slice(0, 120) || "Tap to see it in your gallery.";
  sendNotification({
    title: KIND_TITLE[kind],
    body,
    group: `subrosa-studio-${kind}`,
    sound: "Ping",
  });
}
