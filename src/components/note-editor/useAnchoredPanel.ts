import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";

/**
 * Put a floating thing next to a selection and keep it on screen.
 *
 * The toolbar could get away with clamping one axis, because it is one row
 * tall and always fits above the caret. Everything else this editor floats —
 * the rewrite menu, and above all the revision panel, which can be a third of
 * the window — cannot: anchored above a selection near the top of the note,
 * the panel's own height pushes it off the top of the screen and the reader
 * sees its last line and nothing else.
 *
 * So: measure, clamp sideways, and flip below the selection when there is no
 * room above it. Measured rather than assumed, because the panel's height is
 * its content's and the content is a model's reply.
 */

/** Where the selection is, in viewport coordinates. */
export type Anchor = { x: number; top: number; bottom: number };

const MARGIN = 12;
const GAP = 8;

export function useAnchoredPanel(anchor: Anchor, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({
    left: anchor.x,
    top: anchor.top - GAP,
    transform: "translate(-50%, -100%)",
  });

  useLayoutEffect(() => {
    if (!enabled) return;
    const element = ref.current;
    if (!element) return;

    const { offsetWidth: width, offsetHeight: height } = element;
    const half = width / 2;
    const min = half + MARGIN;
    const max = window.innerWidth - half - MARGIN;
    const left = max < min ? window.innerWidth / 2 : Math.min(Math.max(anchor.x, min), max);

    if (anchor.top - height - GAP >= MARGIN) {
      setStyle({ left, top: anchor.top - GAP, transform: "translate(-50%, -100%)" });
      return;
    }
    // No room above: sit under the selection, and never below the fold.
    const below = Math.min(anchor.bottom + GAP, window.innerHeight - height - MARGIN);
    setStyle({ left, top: Math.max(below, MARGIN), transform: "translate(-50%, 0)" });
  }, [anchor.x, anchor.top, anchor.bottom, enabled]);

  return { ref, style };
}
