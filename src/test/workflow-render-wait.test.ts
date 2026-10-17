/**
 * Waiting on renders and handing them to the queue (ADR-0114): a render is
 * heard settling through the row event, a refusal the provider will lift on
 * its own is queued again under a new id, and paid submissions never leave
 * more than two at a time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: [] as Array<(event: { payload: unknown }) => void>,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
    bridge.listeners.push(handler);
    return () => {
      bridge.listeners = bridge.listeners.filter((entry) => entry !== handler);
    };
  }),
}));

import {
  resetSubmissionSlotsForTests,
  SUBMISSION_SLOTS,
  waitForSettledJob,
  withSubmissionSlot,
} from "../lib/studio/workflow/render-wait";

const emit = (payload: unknown) => {
  for (const listener of [...bridge.listeners]) listener({ payload });
};

beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.listeners = [];
  resetSubmissionSlotsForTests();
});
afterEach(() => vi.useRealTimers());

describe("waiting on a render", () => {
  it("hears it settle through the row event, without reading the table again", async () => {
    bridge.invoke.mockResolvedValue([{ id: "j", status: "processing" }]);
    const wait = waitForSettledJob("j");
    await vi.waitFor(() => expect(bridge.listeners).toHaveLength(1));
    await vi.waitFor(() => expect(bridge.invoke).toHaveBeenCalledTimes(1));
    emit({ id: "other", status: "completed" });
    emit({ id: "j", status: "completed", artifactPath: "/a.mp4" });
    await expect(wait).resolves.toMatchObject({ id: "j", artifactPath: "/a.mp4" });
    expect(bridge.invoke).toHaveBeenCalledTimes(1);
    expect(bridge.listeners).toHaveLength(0);
  });

  it("resolves at once for a render that settled before the wait began", async () => {
    bridge.invoke.mockResolvedValue([{ id: "j", status: "failed", error: "No." }]);
    await expect(waitForSettledJob("j")).resolves.toMatchObject({ status: "failed" });
  });

  it("reads the rows again on a slow timer, in case an event was missed", async () => {
    vi.useFakeTimers();
    bridge.invoke.mockResolvedValueOnce([{ id: "j", status: "queued" }]);
    const wait = waitForSettledJob("j");
    await vi.advanceTimersByTimeAsync(0);
    bridge.invoke.mockResolvedValueOnce([{ id: "j", status: "completed" }]);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(wait).resolves.toMatchObject({ status: "completed" });
  });

  it("says so when the row is gone, and stops on cancel", async () => {
    bridge.invoke.mockResolvedValue([]);
    await expect(waitForSettledJob("j")).rejects.toThrow("job row is gone");
    bridge.invoke.mockResolvedValue([{ id: "j", status: "processing" }]);
    const controller = new AbortController();
    const wait = waitForSettledJob("j", controller.signal);
    controller.abort();
    await expect(wait).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("submission slots", () => {
  it("lets two paid submissions out at a time and hands each freed slot on", async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const submit = () =>
      withSubmissionSlot(
        () =>
          new Promise<void>((resolve) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            releases.push(() => {
              inFlight -= 1;
              resolve();
            });
          }),
      );
    const all = Promise.all([submit(), submit(), submit(), submit(), submit()]);
    await vi.waitFor(() => expect(releases).toHaveLength(SUBMISSION_SLOTS));
    // A newcomer while full waits too.
    const late = submit();
    while (releases.length > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await all;
    await late;
    expect(peak).toBe(SUBMISSION_SLOTS);
  });
});
