import { useRef } from "react";
import { hapticImpact } from "./haptics";

/**
 * A press held long enough to mean something, and not a tap or the start of a
 * scroll.
 *
 * Three things have to be true before it fires: the finger stayed down for
 * long enough, it did not travel (or the user was starting to scroll), and no
 * second finger arrived. The haptic is the confirmation -- on a phone that is
 * what tells you the press registered, before anything has drawn.
 */

/** iOS uses half a second; shorter fires while people are still deciding. */
const HOLD_MS = 500;

/** Past this the finger is scrolling, not pressing. */
const SLOP_PX = 10;

export function useLongPress(onLongPress: () => void) {
  const timer = useRef<number | undefined>(undefined);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  function cancel() {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
    origin.current = null;
  }

  return {
    /** True while the press that just ended was a long one, so the row can
     * swallow the click the browser synthesises after it. */
    consumed: () => {
      const was = fired.current;
      fired.current = false;
      return was;
    },
    handlers: {
      onTouchStart: (event: React.TouchEvent) => {
        if (event.touches.length !== 1) return cancel();
        const touch = event.touches[0];
        if (!touch) return;
        origin.current = { x: touch.clientX, y: touch.clientY };
        fired.current = false;
        timer.current = window.setTimeout(() => {
          fired.current = true;
          hapticImpact();
          onLongPress();
          cancel();
        }, HOLD_MS);
      },
      onTouchMove: (event: React.TouchEvent) => {
        const start = origin.current;
        const touch = event.touches[0];
        if (!start || !touch) return;
        const moved =
          Math.abs(touch.clientX - start.x) > SLOP_PX ||
          Math.abs(touch.clientY - start.y) > SLOP_PX;
        if (moved) cancel();
      },
      onTouchEnd: cancel,
      onTouchCancel: cancel,
      // A desktop browser has no touch events; the mobile shell runs in one
      // during development and the gesture should still be reachable there.
      onContextMenu: (event: React.MouseEvent) => {
        event.preventDefault();
        fired.current = true;
        onLongPress();
      },
    },
  };
}
