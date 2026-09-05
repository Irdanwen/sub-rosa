import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDesktopBootstrap } from "../app/useDesktopBootstrap";
import {
  type BootstrapResponse,
  type NoteDto,
  bootstrapApp,
  createNote,
  getNote,
} from "../lib/tauri";

vi.mock("../lib/tauri", () => ({ bootstrapApp: vi.fn(), createNote: vi.fn(), getNote: vi.fn() }));
const empty: BootstrapResponse = {
  notes: [],
  folders: [],
  activeRecoveries: [],
  providerConfigured: true,
};
const note: NoteDto = {
  id: "note-1",
  title: "My note",
  preview: "",
  generatedContent: "",
  editedContent: "",
  processingStatus: "draft",
  folderIds: [],
  createdAt: "2026-09-05",
  updatedAt: "2026-09-05",
};
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.removeItem("os-june:dev:fake-recovery");
});

describe("desktop startup", () => {
  it("retries failed note loading and only commits a complete startup", async () => {
    vi.mocked(bootstrapApp).mockResolvedValue({ ...empty, notes: [note] });
    vi.mocked(getNote)
      .mockRejectedValueOnce(new Error("Read unavailable"))
      .mockResolvedValueOnce(note);
    const dispatch = vi.fn();
    const showNotes = vi.fn();
    const { result } = renderHook(() => useDesktopBootstrap(false, dispatch, showNotes));
    await waitFor(() => expect(result.current.bootstrapError).toBe("Read unavailable"));
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.current.bootstrapped).toBe(false);
    await act(async () => result.current.retryBootstrap());
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    expect(result.current.bootstrapError).toBeNull();
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual([
      "bootstrapLoaded",
      "noteLoaded",
    ]);
    expect(createNote).not.toHaveBeenCalled();
    expect(bootstrapApp).toHaveBeenCalledTimes(2);
  });

  it("creates only one initial note across StrictMode's effect replay", async () => {
    vi.mocked(bootstrapApp).mockResolvedValue(empty);
    vi.mocked(createNote).mockResolvedValue(note);
    const dispatch = vi.fn();
    const showNotes = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useDesktopBootstrap(false, dispatch, showNotes), {
      wrapper,
    });
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    expect(bootstrapApp).toHaveBeenCalledTimes(1);
    expect(createNote).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("waits for the gate and does not replace active work after a sidecar restart", async () => {
    vi.mocked(bootstrapApp).mockResolvedValue({ ...empty, notes: [note] });
    vi.mocked(getNote).mockResolvedValue(note);
    const dispatch = vi.fn();
    const showNotes = vi.fn();
    const { result, rerender } = renderHook(
      ({ blocked }) => useDesktopBootstrap(blocked, dispatch, showNotes),
      {
        initialProps: { blocked: true },
      },
    );
    expect(bootstrapApp).not.toHaveBeenCalled();
    rerender({ blocked: false });
    await waitFor(() => expect(result.current.bootstrapped).toBe(true));
    rerender({ blocked: true });
    rerender({ blocked: false });
    expect(bootstrapApp).toHaveBeenCalledTimes(1);
  });
});
