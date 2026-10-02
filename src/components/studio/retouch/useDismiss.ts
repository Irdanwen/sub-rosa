// A small menu that is not modal (spec/modal-focus.md, exceptions) closes the
// way a menu does: a press anywhere outside it, or Escape.

import { type RefObject, useEffect } from "react";

export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && ref.current.contains(event.target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Ours to take: nothing else should also act on this Escape.
      event.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [ref, open, close]);
}
