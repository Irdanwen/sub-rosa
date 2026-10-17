// The workflows open as tabs on the canvas: which ones, in what order, and
// what opening or closing one does. Remembered per window as a convenience
// (local storage), never as a record: a tab whose workflow is gone simply
// is not shown.

const KEY = "os-june:studio-workflow-tabs";
/** Beyond this, opening a workflow lets the oldest idle tab go. */
export const MAX_TABS = 8;

export function readTabs(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function writeTabs(tabs: readonly string[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(tabs));
  } catch {
    // Without storage the tabs last as long as the window.
  }
}

/** The tabs once `id` is open: added at the end if new. Past the limit the
 * oldest tab that is neither running nor the one being opened goes. */
export function openTab(
  tabs: readonly string[],
  id: string,
  busy: (id: string) => boolean,
): string[] {
  if (tabs.includes(id)) return [...tabs];
  const next = [...tabs, id];
  while (next.length > MAX_TABS) {
    const idle = next.findIndex((tab) => tab !== id && !busy(tab));
    if (idle < 0) break;
    next.splice(idle, 1);
  }
  return next;
}

/** The tabs once `id` is closed, and the tab to show next when it was the
 * one on screen: its right neighbour, else its left, else none. */
export function closeTab(
  tabs: readonly string[],
  id: string,
  active: string | undefined,
): { tabs: string[]; next: string | undefined } {
  const at = tabs.indexOf(id);
  const remaining = tabs.filter((tab) => tab !== id);
  if (at < 0 || id !== active) return { tabs: remaining, next: active };
  return { tabs: remaining, next: remaining[at] ?? remaining[at - 1] };
}
