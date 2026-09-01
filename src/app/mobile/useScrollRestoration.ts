import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * Remember where each screen was scrolled to, and put it back.
 *
 * The mobile shell remounts `.mobile-screen` on every push, pop and tab switch
 * -- it is keyed by tab and depth, which is what makes the stack transitions
 * work and what throws the scroll position away with them. Coming back to a
 * list you had read halfway lands you at the top again. It is the first thing
 * an iPhone user notices, usually without being able to name it.
 *
 * Keeping the screens mounted under the stack would also fix it, and would cost
 * far more than it looks: every screen left alive keeps its effects running and
 * its data in memory on a device that suspends the whole process (ADR-0018).
 * So nothing survives its own dismissal here. Only a number does.
 *
 * Restoring is not one assignment. A list mounts empty and fills from SQLite a
 * frame or several later, and a scroller with no content cannot be scrolled --
 * setting `scrollTop` then clamps silently to zero. The offset is therefore
 * replayed while the content grows, for a short window, and abandoned the
 * moment a finger touches the screen: restoring under someone's thumb is worse
 * than not restoring at all.
 */

/** How long to keep trying before accepting that the content is not coming. */
const RESTORE_WINDOW_MS = 1200;

/** Below this, the screen was at the top and there is nothing worth replaying. */
const MIN_RESTORABLE = 4;

/**
 * The scroller is a descendant, not the screen wrapper: every screen owns its
 * own `*-scroll` element. Found by what it does rather than by class name, so
 * a new screen is covered the day it is written.
 */
function findScroller(host: HTMLElement): HTMLElement | null {
  for (const element of host.querySelectorAll<HTMLElement>("*")) {
    const overflow = getComputedStyle(element).overflowY;
    if (overflow === "auto" || overflow === "scroll") return element;
  }
  return null;
}

export function useScrollRestoration(
  /** Where in the navigation we are; the same key must come back on the way back. */
  key: string,
  host: RefObject<HTMLElement | null>,
  /** False for screens that place their own scroll, like the chat pinning to
   * its last message. Two things setting `scrollTop` in the same frame is a
   * fight the user watches. */
  enabled = true,
) {
  const positions = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;

    let scroller = findScroller(element);
    let frame = 0;

    if (enabled) {
      const target = positions.current.get(key) ?? 0;
      if (target >= MIN_RESTORABLE) {
        const deadline = performance.now() + RESTORE_WINDOW_MS;
        const abandon = () => cancelAnimationFrame(frame);
        element.addEventListener("touchstart", abandon, { passive: true, once: true });

        const replay = () => {
          scroller ??= findScroller(element);
          // Wait for the content: assigning into a short scroller clamps to 0
          // and the position is lost for good.
          if (scroller && scroller.scrollHeight - scroller.clientHeight >= target) {
            scroller.scrollTop = target;
            element.removeEventListener("touchstart", abandon);
            return;
          }
          if (performance.now() < deadline) frame = requestAnimationFrame(replay);
          else element.removeEventListener("touchstart", abandon);
        };
        frame = requestAnimationFrame(replay);
      }
    }

    return () => {
      cancelAnimationFrame(frame);
      // Read at teardown, which is the last moment the outgoing screen still
      // knows where it was.
      const outgoing = scroller ?? findScroller(element);
      positions.current.set(key, outgoing?.scrollTop ?? 0);
    };
  }, [key, host, enabled]);
}
