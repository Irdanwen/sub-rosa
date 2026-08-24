import { describe, expect, it, vi } from "vitest";
import { MediaError } from "../lib/studio/client";
import {
  isTransientSpendFailure,
  placeLines,
  TRANSIENT_WAIT_BUDGET_MS,
  transientDelays,
  withTransientTolerance,
} from "../lib/studio/workflow/engine";

const rail = () =>
  new MediaError("Payment rail cannot cover this request", {
    status: 402,
    code: "PAYMENT_REQUIRED",
  });
const capacity = () => new MediaError("No provider capacity", { status: 503 });

describe("which failures are worth waiting out", () => {
  it("waits out the payment rail and provider capacity, and nothing else", () => {
    // Both come and go in windows of ten or twenty minutes. Treated as node
    // failures they kill a run that already paid for everything before them.
    expect(isTransientSpendFailure(rail())).toBe(true);
    expect(isTransientSpendFailure(capacity())).toBe(true);
    // A bad prompt does not get better in two minutes, and retrying it four
    // times bills it four times.
    expect(isTransientSpendFailure(new MediaError("bad prompt", { status: 400 }))).toBe(false);
    expect(isTransientSpendFailure(new MediaError("gone", { status: 404 }))).toBe(false);
    expect(isTransientSpendFailure(new Error("something else"))).toBe(false);
  });
});

describe("how long it waits", () => {
  it("backs off and stays inside its budget", () => {
    const delays = transientDelays();
    expect(delays.slice(0, 4)).toEqual([15_000, 30_000, 60_000, 120_000]);
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(
      TRANSIENT_WAIT_BUDGET_MS,
    );
  });

  it("waits not at all on a budget of nothing", () => {
    expect(transientDelays(0)).toEqual([]);
    expect(transientDelays(10_000)).toEqual([]);
  });
});

describe("withTransientTolerance", () => {
  it("retries the same work until the rail comes back", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;
    const result = await withTransientTolerance(
      async () => {
        attempts += 1;
        if (attempts < 3) throw rail();
        return "rendered";
      },
      { sleep },
    );
    expect(result).toBe("rendered");
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("says what it is waiting for, so the run does not look hung", async () => {
    const notes: string[] = [];
    let attempts = 0;
    await withTransientTolerance(
      async () => {
        attempts += 1;
        if (attempts === 1) throw capacity();
        return "ok";
      },
      { sleep: vi.fn().mockResolvedValue(undefined), onWait: (note) => notes.push(note) },
    );
    expect(notes[0]).toContain("no provider capacity");
    expect(notes[0]).toContain("15s");
  });

  it("gives up once the budget is spent, with the rail's own message", async () => {
    await expect(
      withTransientTolerance(
        async () => {
          throw rail();
        },
        { sleep: vi.fn().mockResolvedValue(undefined) },
      ),
    ).rejects.toThrow("Payment rail cannot cover this request");
  });

  it("does not retry, and does not sleep, on anything else", async () => {
    const sleep = vi.fn();
    await expect(
      withTransientTolerance(
        async () => {
          throw new MediaError("bad prompt", { status: 400 });
        },
        { sleep },
      ),
    ).rejects.toThrow("bad prompt");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not wait at all when the caller allows no budget", async () => {
    const sleep = vi.fn();
    await expect(
      withTransientTolerance(
        async () => {
          throw rail();
        },
        { sleep, budgetMs: 0 },
      ),
    ).rejects.toThrow();
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("placing dialogue in a cut", () => {
  const line = (atSeconds?: number) => ({
    kind: "audio" as const,
    mimeType: "audio/mpeg",
    src: `asset://line-${atSeconds ?? "auto"}`,
    atSeconds,
  });

  it("leaves a line that says where it belongs", () => {
    // Only the compiler knew which shot it was on. The cut does not overrule
    // that.
    expect(placeLines([line(3), line(9.4)]).map((entry) => entry.atSeconds)).toEqual([3, 9.4]);
  });

  it("lays unplaced lines end to end rather than stacking them at zero", () => {
    const placed = placeLines([line(), line(), line()]).map((entry) => entry.atSeconds);
    expect(placed[0]).toBe(0);
    expect(placed[1]).toBeGreaterThan(placed[0]);
    expect(placed[2]).toBeGreaterThan(placed[1]);
  });

  it("pushes an unplaced line past the placed one before it", () => {
    const placed = placeLines([line(12), line()]).map((entry) => entry.atSeconds);
    expect(placed[1]).toBeGreaterThan(12);
  });

  it("has nothing to place when nobody speaks", () => {
    expect(placeLines([])).toEqual([]);
  });
});
