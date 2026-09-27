import { invoke } from "@tauri-apps/api/core";

/**
 * Reflexes (ADR-0064): quick typed decisions from a decision model, used to
 * screen search results and memories for relevance. On by default; the
 * request leaves the Carpe Diem enclave for the model's operator,
 * anonymized, which is why the switch lives in Settings › Privacy.
 */
export type ReflexSettingsDto = { enabled: boolean; noticeSeen?: boolean };

/** A change to the settings: only what is named changes. */
export type ReflexSettingsChange = { enabled?: boolean; noticeSeen?: boolean };

export async function reflexSettings(): Promise<ReflexSettingsDto> {
  return invoke<ReflexSettingsDto>("reflex_settings");
}

export async function setReflexSettings(
  settings: ReflexSettingsChange,
): Promise<ReflexSettingsDto> {
  return invoke<ReflexSettingsDto>("set_reflex_settings", { request: settings });
}

/** The part of a memory a change touched, before or after. */
export type ReflexMemoryState = { text: string; disabled: boolean };

/**
 * Something the app changed on its own after a reflex decided (ADR-0065),
 * with what an undo restores.
 */
export type AutonomousChangeDto = {
  id: string;
  kind: "memory_update" | "memory_same" | "memory_forget" | string;
  subjectId: string;
  before: ReflexMemoryState;
  after: ReflexMemoryState;
  probability: number;
  createdAt: string;
  undoneAt: string | null;
};

export async function reflexJournal(): Promise<AutonomousChangeDto[]> {
  return invoke<AutonomousChangeDto[]>("reflex_journal");
}

export async function reflexUndo(changeId: string): Promise<AutonomousChangeDto> {
  return invoke<AutonomousChangeDto>("reflex_undo", { request: { changeId } });
}
