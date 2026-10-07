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

export type ProtectedModeStatus = { enabled: boolean };

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

export function protectedModeVerify(pin: string) {
  return invoke<ProtectedModeStatus>("protected_mode_verify", { request: { pin } });
}

/** The pickers cache their catalogs: drop the Studio cache and tell the chat
 * pickers to reload, so a switch takes effect without a restart. */
function refreshModelLists() {
  resetMediaCatalogCache();
  dispatchProviderModelSettingsChanged({ mode: "generation", modelId: "" });
}
