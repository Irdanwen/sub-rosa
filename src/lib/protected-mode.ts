/**
 * Protected mode (ADR-0084), the Tauri side.
 *
 * Kept out of `tauri.ts` (at its size ceiling). The guards themselves live in
 * Rust (`src-tauri/src/protected_mode/`): the catalogs leave adult families
 * out, the media proxy forces `safe_mode` and refuses adult models, and both
 * chat prompts carry a protective block. The webview only shows the switch,
 * asks for the PIN, and filters what it adds to a catalog itself.
 */

import { invoke } from "@tauri-apps/api/core";
import { dispatchProviderModelSettingsChanged } from "./model-privacy";
import { resetMediaCatalogCache } from "./studio/catalog";

/** A daily window, in minutes after local midnight; the end is not in it,
 * and an end before the start runs over midnight. Mirrors Rust's
 * `restrictions::QuietHours`. */
export type QuietHours = { startMinute: number; endMinute: number };

/** The parental-control switches behind the PIN (ADR-0084 addendum). Each
 * `...Off` is a feature turned off; all are enforced in Rust. */
export type ProtectedRestrictions = {
  quietHours?: QuietHours;
  memoryOff: boolean;
  mediaOff: boolean;
  /** Reserved for the voice mode: stored, enforced by nothing yet. */
  voiceOff: boolean;
  pastChatsOff: boolean;
};

export const NO_RESTRICTIONS: ProtectedRestrictions = {
  memoryOff: false,
  mediaOff: false,
  voiceOff: false,
  pastChatsOff: false,
};

export type ProtectedModeStatus = {
  enabled: boolean;
  restrictions?: ProtectedRestrictions;
  /** Quiet hours are on right now. */
  quietNow?: boolean;
};

/** "21:30" from 1290, the value an `<input type="time">` takes. */
export function minuteToTime(minute: number): string {
  const bounded = ((Math.round(minute) % 1440) + 1440) % 1440;
  const hours = Math.floor(bounded / 60);
  return `${String(hours).padStart(2, "0")}:${String(bounded % 60).padStart(2, "0")}`;
}

/** 1290 from "21:30"; undefined for anything else. */
export function timeToMinute(value: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

/** Mirrors `pin::validate` in Rust: four to six digits. */
export const PIN_PATTERN = /^\d{4,6}$/;

export function isValidPin(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

export { ADULT_MARKERS, isAdultModel, withoutAdultModels } from "./adult-models";

export function protectedModeStatus() {
  return invoke<ProtectedModeStatus>("protected_mode_status");
}

export async function protectedModeEnable(pin: string) {
  const status = await invoke<ProtectedModeStatus>("protected_mode_enable", { request: { pin } });
  refreshModelLists();
  return status;
}

export async function protectedModeDisable(pin: string) {
  const status = await invoke<ProtectedModeStatus>("protected_mode_disable", { request: { pin } });
  refreshModelLists();
  return status;
}

/** Changes the switches. Takes the PIN while protected mode is on. */
export async function protectedModeSetRestrictions(
  pin: string,
  restrictions: ProtectedRestrictions,
) {
  const status = await invoke<ProtectedModeStatus>("protected_mode_set_restrictions", {
    request: { pin, restrictions },
  });
  // Studio and the memory screens read their state again: a switch may hide
  // what they show.
  refreshModelLists();
  return status;
}

export function protectedModeVerify(pin: string) {
  return invoke<ProtectedModeStatus>("protected_mode_verify", { request: { pin } });
}

/** The pickers cache their catalogs: drop the Studio cache and tell the chat
 * pickers to reload, so a switch takes effect without a restart. */
function refreshModelLists() {
  resetMediaCatalogCache();
  dispatchProviderModelSettingsChanged({ mode: "generation", modelId: "" });
}
