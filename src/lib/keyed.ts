// Stable React keys for a list whose items can repeat (the same picture
// twice in a list): what the item is, and which occurrence of it.

export function keyed<T>(
  values: readonly T[],
  name: (value: T) => string,
): Array<{ key: string; value: T }> {
  const seen = new Map<string, number>();
  return values.map((value) => {
    const base = name(value);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return { key: `${base}:${occurrence}`, value };
  });
}
