import { invoke } from "@tauri-apps/api/core";

/**
 * What an iPhone Shortcuts action asked for.
 *
 * The action (Swift, `Sources/os-june/Intents`) writes a small manifest in the
 * app group and opens `subrosa://intent/<id>`; Rust validates it and hands it
 * over once (`intent_inbox.rs`). Unlike an address, which any page can open,
 * only the app and its extension can write there, so this is the one route
 * allowed to send a message without a tap.
 */
export type IntentRequest = {
  id: string;
  action: "record" | "dictate" | "ask";
  query?: string;
  send?: boolean;
};

/** One request by id, consumed. None when unknown, stale, or already taken. */
export async function takeIntent(id: string): Promise<IntentRequest | null> {
  return invoke<IntentRequest | null>("take_intent", { id }).catch(() => null);
}

/** Every request still waiting, consumed: a cold start can lose the URL that
 * was meant to deliver one, but not the manifest. */
export async function takePendingIntents(): Promise<IntentRequest[]> {
  return invoke<IntentRequest[] | null>("take_pending_intents").then(
    (requests) => (Array.isArray(requests) ? requests : []),
    () => [],
  );
}

/** The Shortcuts app, where the actions live (iPhone only). */
export async function openShortcutsApp(): Promise<void> {
  await invoke("open_shortcuts_app");
}
