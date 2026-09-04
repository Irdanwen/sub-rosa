import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

/**
 * Keyboard and focus for anything modal, once.
 *
 * A dialog, a sheet, a palette, an answer panel: each of them used to carry
 * its own copy of the same four rules, or a subset, and the subsets were
 * where the keyboard got stuck. The rules are:
 *
 * 1. Opening moves focus inside (the first focusable, or the surface
 *    itself), and closing gives it back to where it was.
 * 2. Tab and Shift+Tab stay inside.
 * 3. Escape closes.
 * 4. When two surfaces are open at once (the palette under the answer it
 *    opened), only the top one listens. A stack of tokens says which one
 *    is on top; the others wait their turn.
 *
 * Nothing here knows what the surface looks like. The surface passes its
 * ref and, optionally, what to focus first and whether the page behind it
 * should stop scrolling.
 */

export const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const stack: symbol[] = [];

/** True when `token` is the modal surface on top. */
function isOnTop(token: symbol) {
  return stack.length > 0 && stack[stack.length - 1] === token;
}

/** How many modal surfaces are open (for tests and for debugging). */
export function openModalCount() {
  return stack.length;
}

export type ModalFocusOptions = {
  /** Whether the surface is open; the hook does nothing while it is not. */
  open?: boolean;
  /** Called on Escape (only when this surface is on top). */
  onClose?: () => void;
  /** Selector inside the surface to focus first; the first focusable otherwise. */
  initialFocusSelector?: string;
  /** Stop the page behind from scrolling while open. */
  lockScroll?: boolean;
  /** Give focus back to where it was when the surface closes. */
  restoreFocus?: boolean;
};

export function useModalFocus<T extends HTMLElement>(
  ref: RefObject<T | null>,
  {
    open = true,
    onClose,
    initialFocusSelector,
    lockScroll = false,
    restoreFocus = true,
  }: ModalFocusOptions = {},
) {
  // The latest onClose without re-running the effect: re-running it would
  // restore and re-take focus on every parent render, mid-typing.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Where focus was before the surface took it, captured before the first
  // focus move (a layout effect runs before the listeners are installed).
  const previousRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const token = Symbol("modal");
    stack.push(token);

    function onKey(event: KeyboardEvent) {
      if (!isOnTop(token)) return;
      if (event.key === "Escape") {
        if (!onCloseRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !ref.current) return;
      const focusables = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) {
        // Nothing to cycle through: keep focus on the surface itself.
        event.preventDefault();
        ref.current.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && ref.current.contains(active);
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    }
    // Capture, so a surface that stops propagation for its own reasons
    // (an editor swallowing keys) still lets the top modal see Escape.
    window.addEventListener("keydown", onKey, true);

    const previousOverflow = document.body.style.overflow;
    if (lockScroll) document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (lockScroll) document.body.style.overflow = previousOverflow;
      const at = stack.indexOf(token);
      if (at !== -1) stack.splice(at, 1);
      if (restoreFocus) previousRef.current?.focus?.();
    };
  }, [open, lockScroll, restoreFocus, ref]);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    previousRef.current = document.activeElement as HTMLElement | null;
    const target = initialFocusSelector
      ? ref.current.querySelector<HTMLElement>(initialFocusSelector)
      : ref.current.querySelector<HTMLElement>(FOCUSABLE);
    (target ?? ref.current).focus();
  }, [open, initialFocusSelector, ref]);
}
