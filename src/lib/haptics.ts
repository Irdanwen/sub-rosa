import {
  impactFeedback,
  notificationFeedback,
  selectionFeedback,
} from "@tauri-apps/plugin-haptics";
import { isMobilePlatform } from "./mobile";

/**
 * Haptic feedback, mobile-only and always best-effort: a missing engine
 * (simulator, desktop, browser preview) must never surface as an error.
 */
export function hapticImpact(style: "light" | "medium" | "heavy" = "light") {
  if (!isMobilePlatform()) return;
  void impactFeedback(style).catch(() => undefined);
}

export function hapticSelection() {
  if (!isMobilePlatform()) return;
  void selectionFeedback().catch(() => undefined);
}

export function hapticNotify(kind: "success" | "warning" | "error") {
  if (!isMobilePlatform()) return;
  void notificationFeedback(kind).catch(() => undefined);
}
