/**
 * Shared motion constants — the JS mirror of the tokens in
 * `src/styles/tokens.css`. framer-motion's built-in `"easeOut"` keyword is a
 * materially weaker curve than the app's `--ease-out`, so JS-driven motion
 * read flatter than CSS motion in the same view; every framer `transition`
 * should use these instead of easing strings.
 *
 * Keep the values in lockstep with tokens.css:
 *   --ease-out:    cubic-bezier(0.22, 1, 0.36, 1)
 *   --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1)
 *   --ease-spring: cubic-bezier(0.32, 0.72, 0, 1)
 */
export const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];
export const EASE_IN_OUT: [number, number, number, number] = [0.65, 0, 0.35, 1];
export const EASE_SPRING: [number, number, number, number] = [0.32, 0.72, 0, 1];

/** CSS string forms, for WAAPI `element.animate` and inline styles. */
export const EASE_OUT_CSS = "cubic-bezier(0.22, 1, 0.36, 1)";
export const EASE_SPRING_CSS = "cubic-bezier(0.32, 0.72, 0, 1)";

/**
 * Progressive resistance past a drag boundary (Apple's rubber-band): the
 * further past the edge, the less the surface follows — real things slow
 * down before they stop, they don't hit invisible walls.
 *
 * @param overshoot px dragged past the boundary
 * @param dimension the relevant surface dimension (asymptotic ceiling)
 * @param constant  resistance strength (Apple uses ~0.55)
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/**
 * Velocity gate for momentum dismissal (px/ms): a quick flick should commit
 * a swipe even when the distance threshold wasn't crossed.
 */
export const FLICK_VELOCITY = 0.11;
