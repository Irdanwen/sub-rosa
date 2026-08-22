/**
 * Web-Mercator math for the places card: fit a set of pins into a viewport
 * and place their DOM markers over the static map Rust rendered. Mirrors the
 * projection in src-tauri/src/map_render.rs (256px tile grid) — the two must
 * agree or pins drift off their buildings.
 */

export type LatLng = { lat: number; lng: number };

const TILE_SIZE = 256;
export const MIN_MAP_ZOOM = 2;
export const MAX_MAP_ZOOM = 17;
/** Zoom for a single pin, where bounds carry no scale of their own. */
const SINGLE_PIN_ZOOM = 15;

/** World-pixel projection at `zoom`. */
export function project(point: LatLng, zoom: number): { x: number; y: number } {
  const world = TILE_SIZE * 2 ** zoom;
  const x = ((point.lng + 180) / 360) * world;
  const latRad = (point.lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * world;
  return { x, y };
}

/**
 * The integer zoom + center that fit every point into `width`×`height` with
 * `padding` px kept clear on each side (so pins never sit on the card edge).
 */
export function fitBounds(
  points: LatLng[],
  width: number,
  height: number,
  padding = 28,
): { center: LatLng; zoom: number } {
  if (points.length === 0) {
    return { center: { lat: 0, lng: 0 }, zoom: MIN_MAP_ZOOM };
  }
  const lats = points.map((point) => point.lat);
  const lngs = points.map((point) => point.lng);
  const center = {
    lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
  };
  if (points.length === 1) {
    return { center, zoom: SINGLE_PIN_ZOOM };
  }
  const innerWidth = Math.max(1, width - padding * 2);
  const innerHeight = Math.max(1, height - padding * 2);
  for (let zoom = MAX_MAP_ZOOM; zoom >= MIN_MAP_ZOOM; zoom -= 1) {
    const projected = points.map((point) => project(point, zoom));
    const xs = projected.map((p) => p.x);
    const ys = projected.map((p) => p.y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    if (spanX <= innerWidth && spanY <= innerHeight) {
      return { center, zoom };
    }
  }
  return { center, zoom: MIN_MAP_ZOOM };
}

/** Inverse of {@link project}: world pixels at `zoom` back to lat/lng. */
export function unproject(x: number, y: number, zoom: number): LatLng {
  const world = TILE_SIZE * 2 ** zoom;
  const lng = (x / world) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / world;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

/**
 * The center after dragging the viewport content by (dxPx, dyPx): the map
 * follows the pointer, so the center moves the opposite way. Latitude clamps
 * to the renderable Mercator band, longitude wraps.
 */
export function panCenter(center: LatLng, zoom: number, dxPx: number, dyPx: number): LatLng {
  const origin = project(center, zoom);
  const next = unproject(origin.x - dxPx, origin.y - dyPx, zoom);
  return {
    lat: Math.max(-85, Math.min(85, next.lat)),
    lng: ((next.lng + 540) % 360) - 180,
  };
}

/**
 * CSS offset of `point` inside a `width`×`height` viewport whose middle shows
 * `center` at `zoom`. Values can fall outside [0, width/height] for a point
 * out of view; callers clamp or hide.
 */
export function pixelOffset(
  point: LatLng,
  center: LatLng,
  zoom: number,
  width: number,
  height: number,
): { left: number; top: number } {
  const projected = project(point, zoom);
  const origin = project(center, zoom);
  return {
    left: width / 2 + (projected.x - origin.x),
    top: height / 2 + (projected.y - origin.y),
  };
}
