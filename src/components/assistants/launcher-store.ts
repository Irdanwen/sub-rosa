import { useSyncExternalStore } from "react";

// Keep a cold-launch destination until the shell is ready to mount its host.
// Buttons and notification taps share one modal, including on mobile stacks.
//
// On desktop the chat can host the library as its right-hand panel. While it
// is mounted it registers itself here, and "open my assistants" lands in that
// panel beside the conversation instead of covering it. Creating or editing an
// assistant needs the width of the full surface, so those always open the
// modal, even from the panel.
type Selection = {
  taskId?: string;
  editId?: string;
  create?: string;
  request: number;
} | null;
type PanelHost = (taskId?: string) => void;
let selection: Selection = null;
let request = 0;
let closures = 0;
let panelHost: PanelHost | null = null;
const listeners = new Set<() => void>();
function notify() {
  for (const listener of listeners) listener();
}
export function openAssistants(taskId?: string) {
  if (panelHost) {
    panelHost(taskId);
    return;
  }
  selection = { taskId, request: ++request };
  notify();
}
/** Opens the full surface on the editor: an existing assistant, or a new one
 * seeded with an idea (possibly empty). */
export function openAssistantEditor(target: { editId: string } | { create: string }) {
  selection = { ...target, request: ++request };
  notify();
}
export function closeAssistants() {
  selection = null;
  closures += 1;
  notify();
}
/** The chat's panel claims "open my assistants" while it is mounted. */
export function registerAssistantsPanelHost(host: PanelHost) {
  panelHost = host;
  return () => {
    if (panelHost === host) panelHost = null;
  };
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** Counts closings of the full surface, so a view of the library elsewhere
 * can reload after an assistant was created, edited or deleted there. */
export function useAssistantsModalClosures() {
  return useSyncExternalStore(subscribe, () => closures);
}
export function useAssistantsSelection() {
  return useSyncExternalStore(subscribe, () => selection);
}
