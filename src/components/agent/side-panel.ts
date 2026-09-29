import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
} from "react";

// The chat's right-hand panel width — user-resizable between these bounds (and
// never past roughly half the window), remembered across sessions. The Files
// panel and the Assistants panel are the same slot, one at a time, so they
// share one width. The live value is the --agent-files-w custom property on
// .app-shell, which the panel, the main card's margin, and the composer all
// share.
const AGENT_FILES_WIDTH_KEY = "june:agent:files-panel-width";
const SIDE_PANEL_MIN_W = 300;
const SIDE_PANEL_MAX_W = 600;

export function clampSidePanelWidth(width: number) {
  const viewportCap =
    typeof window === "undefined" ? SIDE_PANEL_MAX_W : Math.round(window.innerWidth * 0.48);
  const max = Math.max(SIDE_PANEL_MIN_W, Math.min(SIDE_PANEL_MAX_W, viewportCap));
  return Math.min(Math.max(Math.round(width), SIDE_PANEL_MIN_W), max);
}

/**
 * Restores the remembered width once per panel mount and returns the
 * pointer-down handler for the panel's left-edge resize handle.
 *
 * The property lives on .app-shell (not the panel) because the main card's
 * slide-over margin and the composer's right inset consume it too. While
 * dragging, the var tracks the cursor with transitions suppressed (the
 * data-files-resizing attribute), and the final width persists on release.
 */
export function useSidePanelResize(panelRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const shell = panelRef.current?.closest(".app-shell");
    if (!(shell instanceof HTMLElement)) return;
    let stored = Number.NaN;
    try {
      stored = Number.parseInt(window.localStorage.getItem(AGENT_FILES_WIDTH_KEY) ?? "", 10);
    } catch {
      // Storage can be unavailable; the default width stands.
    }
    if (Number.isFinite(stored)) {
      shell.style.setProperty("--agent-files-w", `${clampSidePanelWidth(stored)}px`);
    }
  }, [panelRef]);

  return useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const shell = event.currentTarget.closest(".app-shell");
      const startWidth = panelRef.current?.offsetWidth;
      if (!(shell instanceof HTMLElement) || !startWidth) return;
      shell.setAttribute("data-files-resizing", "true");
      const startX = event.clientX;
      const onMove = (move: PointerEvent) => {
        const next = clampSidePanelWidth(startWidth + (startX - move.clientX));
        shell.style.setProperty("--agent-files-w", `${next}px`);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        shell.removeAttribute("data-files-resizing");
        const finalWidth = panelRef.current?.offsetWidth;
        if (finalWidth) {
          try {
            window.localStorage.setItem(AGENT_FILES_WIDTH_KEY, `${finalWidth}`);
          } catch {
            // Not remembered this time; the panel still has its width.
          }
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
    },
    [panelRef],
  );
}
