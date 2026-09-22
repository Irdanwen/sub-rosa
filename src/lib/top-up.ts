import { invoke } from "@tauri-apps/api/core";

/**
 * The "Top up" tab of the Sub Rosa account site, in the browser. It explains
 * the credits and hands over to Carpe Diem's deposit page; the app sells
 * nothing itself. Rejects with the reason when the link could not be opened,
 * so a button can say so instead of doing nothing.
 */
export async function openTopUp(): Promise<void> {
  await invoke("carpe_diem_open_top_up");
}
