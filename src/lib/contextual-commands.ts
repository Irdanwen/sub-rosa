// Commands the screen on display offers to the ⌘K palette: the palette lives
// in the sidebar, the commands belong to whatever is open (the workflow
// canvas offers undo, run, fit view...). A screen sets its list when it
// mounts and clears it when it leaves.

import { useSyncExternalStore } from "react";

export interface ContextualCommand {
  id: string;
  label: string;
  /** The shortcut, as a person reads it ("⌘Z"). */
  shortcut?: string;
  /** Extra words the palette search matches. */
  keywords?: string;
  run: () => void;
}

let current: { owner: string; commands: ContextualCommand[] } | undefined;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Offer `commands` on behalf of `owner`, replacing what it offered before. */
export function setContextualCommands(owner: string, commands: ContextualCommand[]): void {
  current = { owner, commands };
  notify();
}

/** Withdraw `owner`'s commands, unless another screen has taken over since. */
export function clearContextualCommands(owner: string): void {
  if (current?.owner !== owner) return;
  current = undefined;
  notify();
}

const EMPTY: ContextualCommand[] = [];

export function useContextualCommands(): ContextualCommand[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current?.commands ?? EMPTY,
  );
}
