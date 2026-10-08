import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

/** "What I'm looking at" (ADR-0094): opt-in, read only on a click. */

export type ScreenAwarenessSettings = {
  enabled: boolean;
  /** The person read why a window picture needs Screen Recording and agreed. */
  screenshots: boolean;
};

export type LookingAt = {
  appName: string;
  windowTitle?: string | null;
  selectedText?: string | null;
  accessibility: boolean;
  screenshotPath?: string | null;
  screenshotError?: string | null;
  /** The markdown note to attach (app, window, selection). */
  contextPath?: string | null;
  capturedAt: string;
};

export function screenAwarenessSettings() {
  return invoke<ScreenAwarenessSettings>("screen_awareness_settings");
}

export function saveScreenAwarenessSettings(settings: ScreenAwarenessSettings) {
  return invoke<ScreenAwarenessSettings>("screen_awareness_save_settings", { settings });
}

export function captureLookingAt(screenshot: boolean) {
  return invoke<LookingAt>("screen_awareness_capture", { screenshot });
}

/** Whether a window picture can be taken. `request` shows the system prompt,
 * so call it only after the app's own explanation. */
export function screenRecordingPermission(request: boolean) {
  return invoke<boolean>("screen_awareness_screen_permission", { request });
}

const TITLE_CHARS = 48;

/** The chip's first line: the app, and the window when there is one. */
export function lookingAtChipLabel(value: LookingAt): string {
  const app = value.appName.trim() || t("An app");
  const title = value.windowTitle?.trim();
  if (!title || title === app) return app;
  const clipped = title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1)}…` : title;
  return t("{app}: {title}", { app, title: clipped });
}

/** The chip's second line: what else rides along. */
export function lookingAtChipDetail(value: LookingAt): string {
  const parts: string[] = [];
  const selected = value.selectedText?.trim();
  if (selected) {
    parts.push(
      selected.length === 1
        ? t("1 character selected")
        : t("{count} characters selected", { count: selected.length }),
    );
  } else if (!value.accessibility) {
    parts.push(t("Selected text needs the Accessibility permission"));
  }
  if (value.screenshotPath) parts.push(t("a picture of the window"));
  const notice = screenshotNotice(value);
  if (notice) parts.push(notice);
  return parts.join(", ");
}

/** Why a picture that was asked for did not come. */
export function screenshotNotice(value: LookingAt): string | null {
  switch (value.screenshotError) {
    case null:
    case undefined:
    case "":
      return null;
    case "permission":
      return t("no picture: Screen Recording is not allowed");
    case "no_window":
      return t("no picture: the window could not be found");
    default:
      return t("no picture: the capture failed");
  }
}

/** The files that carry the capture into a message. */
export function lookingAtPaths(value: LookingAt): string[] {
  return [value.contextPath, value.screenshotPath].filter(
    (path): path is string => typeof path === "string" && path.length > 0,
  );
}
