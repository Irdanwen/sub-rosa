// The zone setting of a retouch step: a rectangle as fractions of the
// picture (ZonePicker writes it, the engine reads it).

/** A zone setting as fractions of the picture, kept inside it; a malformed
 * one is the middle half. */
export function zoneOf(value: unknown): { x: number; y: number; width: number; height: number } {
  const zone = (value ?? {}) as Record<string, unknown>;
  const fraction = (raw: unknown, fallback: number) => {
    const number = Number(raw);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
  };
  const x = fraction(zone.x, 0.25);
  const y = fraction(zone.y, 0.25);
  const width = Math.max(0.01, Math.min(1 - x, fraction(zone.width, 0.5)));
  const height = Math.max(0.01, Math.min(1 - y, fraction(zone.height, 0.5)));
  return { x, y, width, height };
}
