import { invoke } from "@tauri-apps/api/core";

// The agent HUD's window drag (agent_hud.rs). Kept out of lib/tauri.ts, which
// the file-size ratchet holds at its recorded size.

export async function agentHudStartDrag() {
  return invoke<void>("agent_hud_start_drag");
}

export async function agentHudEndDrag() {
  return invoke<void>("agent_hud_end_drag");
}
