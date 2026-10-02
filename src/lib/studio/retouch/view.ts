// Zooming into the picture: a scale and a translation of the frame, around
// its centre. Pure, so the arithmetic that keeps a pinched point under the
// fingers is tested without a touch screen.

export interface View {
  scale: number;
  /** Translation of the frame's centre, in CSS pixels. */
  x: number;
  y: number;
}

export const FIT: View = { scale: 1, x: 0, y: 0 };
export const MAX_SCALE = 6;
/** Where a double tap zooms to. */
export const TAP_SCALE = 2.5;

interface Box {
  width: number;
  height: number;
}

/** Keep the picture over the room: no zooming out past fit, and no panning
 * an edge further in than the room's own edge. */
export function clampView(view: View, frame: Box): View {
  const scale = Math.min(MAX_SCALE, Math.max(1, view.scale));
  const limitX = (frame.width * (scale - 1)) / 2;
  const limitY = (frame.height * (scale - 1)) / 2;
  return {
    scale,
    x: Math.min(limitX, Math.max(-limitX, view.x)),
    y: Math.min(limitY, Math.max(-limitY, view.y)),
  };
}

/** Zoom by `factor` keeping `point` still. `point` is relative to the frame's
 * untransformed centre, in CSS pixels. */
export function zoomAt(
  view: View,
  factor: number,
  point: { x: number; y: number },
  frame: Box,
): View {
  const scale = Math.min(MAX_SCALE, Math.max(1, view.scale * factor));
  const ratio = scale / view.scale;
  return clampView(
    {
      scale,
      x: point.x - (point.x - view.x) * ratio,
      y: point.y - (point.y - view.y) * ratio,
    },
    frame,
  );
}

export function panBy(view: View, dx: number, dy: number, frame: Box): View {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, frame);
}

/** A double tap: in to TAP_SCALE on the tapped point, or back out to fit. */
export function toggleZoom(view: View, point: { x: number; y: number }, frame: Box): View {
  return view.scale > 1.01 ? FIT : zoomAt(view, TAP_SCALE / view.scale, point, frame);
}
