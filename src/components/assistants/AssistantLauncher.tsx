import { useSyncExternalStore } from "react";
import { AssistantsDialog } from "./AssistantsDialog";

// Keep a cold-launch destination until the shell is ready to mount its host.
// Buttons and notification taps share one modal, including on mobile stacks.
type Selection = { taskId?: string; request: number } | null;
let selection: Selection = null;
let request = 0;
const listeners = new Set<() => void>();
export function openAssistants(taskId?: string) {
  selection = { taskId, request: ++request };
  for (const listener of listeners) listener();
}
function closeAssistants() {
  selection = null;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function AssistantLauncher() {
  const current = useSyncExternalStore(subscribe, () => selection);
  return (
    <AssistantsDialog
      open={current !== null}
      initialTaskId={current?.taskId}
      key={current?.request ?? "closed"}
      onClose={closeAssistants}
    />
  );
}
