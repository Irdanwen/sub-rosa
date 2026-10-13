import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isStudioOwned, useRunningMediaJobs } from "../lib/studio/media-jobs-live";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

const job = (id: string, status: string, source?: string) => ({
  id,
  kind: "video",
  model: "m",
  prompt: "p",
  status,
  source,
  createdAt: `2026-10-12T10:00:0${id}Z`,
});

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.listen.mockReset();
});

describe("the renders in flight", () => {
  it("reads the running rows once, then follows the job events", async () => {
    let emit: (payload: unknown) => void = () => undefined;
    tauri.listen.mockImplementation(async (_event: string, handler: (event: unknown) => void) => {
      emit = (payload) => handler({ payload });
      return () => undefined;
    });
    tauri.invoke.mockResolvedValue([job("1", "processing"), job("2", "completed")]);
    const { result } = renderHook(() => useRunningMediaJobs());
    await act(async () => undefined);
    expect(result.current.map((row) => row.id)).toEqual(["1"]);
    act(() => emit(job("3", "queued")));
    expect(result.current.map((row) => row.id)).toEqual(["3", "1"]);
    act(() => emit(job("1", "completed")));
    expect(result.current.map((row) => row.id)).toEqual(["3"]);
  });

  it("reports nothing, and throws nothing, without a native bridge", async () => {
    tauri.listen.mockRejectedValue(
      new TypeError("Cannot read properties of undefined (reading 'transformCallback')"),
    );
    tauri.invoke.mockRejectedValue(new Error("no bridge"));
    const { result, unmount } = renderHook(() => useRunningMediaJobs());
    await act(async () => undefined);
    expect(result.current).toEqual([]);
    unmount();
  });

  it("keeps to the renders queued by hand", () => {
    expect(isStudioOwned({ source: undefined })).toBe(true);
    expect(isStudioOwned({ source: "studio" })).toBe(true);
    expect(isStudioOwned({ source: "workflow" } as never)).toBe(false);
  });
});
