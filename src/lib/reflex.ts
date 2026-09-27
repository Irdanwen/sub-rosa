import { invoke } from "@tauri-apps/api/core";

/**
 * Reflexes (ADR-0064): quick typed decisions from a decision model, used to
 * screen search results and memories for relevance. On by default; the
 * request leaves the Carpe Diem enclave for the model's operator,
 * anonymized, which is why the switch lives in Settings › Privacy.
 */
export type ReflexSettingsDto = { enabled: boolean };

export async function reflexSettings(): Promise<ReflexSettingsDto> {
  return invoke<ReflexSettingsDto>("reflex_settings");
}

export async function setReflexSettings(settings: ReflexSettingsDto): Promise<ReflexSettingsDto> {
  return invoke<ReflexSettingsDto>("set_reflex_settings", { request: settings });
}
