/**
 * The model switch of an open desktop chat, asked of protected mode first
 * (ADR-0084 addendum).
 *
 * That switch goes from the webview to the runtime's gateway (`config.set`,
 * ADR-0080), past every Rust command, so the filtered picker was its only
 * guard. Rust answers here instead; its refusal is final and the switch is
 * never sent. Any other failure (no native shell, as in a browser preview)
 * lets the switch go: the chat proxy still refuses an adult model on every
 * request that follows, so this is the early, clear refusal, not the only one.
 */

import { invoke } from "@tauri-apps/api/core";
import { errorCode } from "./errors";

export async function guardSessionModel(model: string): Promise<void> {
  try {
    await invoke("protected_mode_check_model", { model });
  } catch (error) {
    if (errorCode(error) === "protected_mode_model") throw error;
  }
}
