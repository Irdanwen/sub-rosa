import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Destination } from "../lib/destinations";

const sources = vi.hoisted(() => ({ handler: null as null | ((d: Destination) => void) }));
const intents = vi.hoisted(() => ({
  takeIntent: vi.fn(),
  takePendingIntents: vi.fn(),
}));
vi.mock("../lib/destinations", () => ({
  subscribeToDestinations: (handle: (d: Destination) => void) => {
    sources.handler = handle;
    return () => undefined;
  },
}));
vi.mock("../lib/intents", () => intents);

import { useDestinationQueue } from "../app/mobile/useDestinationQueue";

beforeEach(() => {
  sources.handler = null;
  intents.takeIntent.mockReset().mockResolvedValue(null);
  intents.takePendingIntents.mockReset().mockResolvedValue([]);
});

describe("destinations that arrive before the shell is ready", () => {
  it("wait, then land once it is", async () => {
    const onDestination = vi.fn();
    const { rerender } = renderHook(
      ({ ready }) => useDestinationQueue({ ready, onDestination, onIntent: vi.fn() }),
      { initialProps: { ready: false } },
    );
    act(() => sources.handler?.({ kind: "record" }));
    expect(onDestination).not.toHaveBeenCalled();

    rerender({ ready: true });
    expect(onDestination).toHaveBeenCalledWith({ kind: "record" });
  });

  it("resolve a Shortcuts request through the inbox, once", async () => {
    const onIntent = vi.fn();
    intents.takeIntent.mockResolvedValueOnce({ id: "i1", action: "dictate", send: false });
    renderHook(() => useDestinationQueue({ ready: true, onDestination: vi.fn(), onIntent }));
    await act(async () => {
      sources.handler?.({ kind: "intent", intentId: "i1" });
    });
    expect(intents.takeIntent).toHaveBeenCalledWith("i1");
    expect(onIntent).toHaveBeenCalledWith({ id: "i1", action: "dictate", send: false });
  });

  it("sweep the inbox when the app comes back, for a request whose address was lost", async () => {
    const onIntent = vi.fn();
    renderHook(() => useDestinationQueue({ ready: true, onDestination: vi.fn(), onIntent }));
    intents.takePendingIntents.mockResolvedValueOnce([{ id: "i2", action: "record", send: false }]);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(onIntent).toHaveBeenCalledWith({ id: "i2", action: "record", send: false });
  });
});
