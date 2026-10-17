// The most a canvas run may spend, as the person set it ("Spend ceiling" in
// CONTEXT.md). A preference of this device, kept in local storage: losing it
// only means no ceiling, which is how the canvas has always run.

const KEY = "os-june:workflow-spend-ceiling";

export function readSpendCeiling(): number | undefined {
  try {
    const raw = window.localStorage.getItem(KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeSpendCeiling(ceiling: number | undefined): void {
  try {
    if (ceiling === undefined || !Number.isFinite(ceiling) || ceiling <= 0)
      window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, String(ceiling));
  } catch {
    // Unavailable storage: the ceiling holds for this dialog only.
  }
}
