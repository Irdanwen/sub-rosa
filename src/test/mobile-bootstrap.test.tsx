import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileBootstrap } from "../app/mobile/useMobileBootstrap";
import { bootstrapApp, type BootstrapResponse } from "../lib/tauri";

vi.mock("../lib/tauri", () => ({ bootstrapApp: vi.fn() }));
const payload: BootstrapResponse = {
  notes: [],
  folders: [],
  activeRecoveries: [],
  providerConfigured: true,
};
beforeEach(() => vi.mocked(bootstrapApp).mockReset());

describe("mobile startup", () => {
  it("keeps the failure visible and retries the read before showing an empty notes list", async () => {
    vi.mocked(bootstrapApp)
      .mockRejectedValueOnce({ message: "Notes temporarily unavailable" })
      .mockResolvedValueOnce(payload);
    const dispatch = vi.fn();
    const { result } = renderHook(() => useMobileBootstrap(false, dispatch));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.error).toBe("Notes temporarily unavailable"));
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    act(() => result.current.retry());
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: "bootstrapLoaded", payload }),
    );
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(bootstrapApp).toHaveBeenCalledTimes(2);
  });

  it("waits for configuration and does not overwrite loaded notes when the gate reopens", async () => {
    vi.mocked(bootstrapApp).mockResolvedValue(payload);
    const dispatch = vi.fn();
    const { rerender } = renderHook(({ blocked }) => useMobileBootstrap(blocked, dispatch), {
      initialProps: { blocked: true },
    });
    expect(bootstrapApp).not.toHaveBeenCalled();
    rerender({ blocked: false });
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    rerender({ blocked: true });
    rerender({ blocked: false });
    expect(bootstrapApp).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale read when the gate closes while it is in flight", async () => {
    let resolve: (payload: BootstrapResponse) => void = () => {};
    vi.mocked(bootstrapApp)
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValueOnce(payload);
    const dispatch = vi.fn();
    const { rerender } = renderHook(({ blocked }) => useMobileBootstrap(blocked, dispatch), {
      initialProps: { blocked: false },
    });
    rerender({ blocked: true });
    await act(async () => resolve(payload));
    expect(dispatch).not.toHaveBeenCalled();
    rerender({ blocked: false });
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(bootstrapApp).toHaveBeenCalledTimes(2);
  });
});
