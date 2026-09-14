import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAccountLibrarySync } from "../app/useAccountLibrarySync";
const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  unlisten: vi.fn(),
  listNotes: vi.fn(),
  listFolders: vi.fn(),
  getNote: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../lib/tauri", () => ({
  listNotes: mocks.listNotes,
  listFolders: mocks.listFolders,
  getNote: mocks.getNote,
}));
let notify: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listen.mockImplementation(async (_: string, callback: () => void) => {
    notify = callback;
    return mocks.unlisten;
  });
  mocks.listNotes.mockResolvedValue({ items: [{ id: "note" }] });
  mocks.listFolders.mockResolvedValue([{ id: "folder" }]);
  mocks.getNote.mockResolvedValue({ id: "note", editedContent: "received" });
});
describe("native sync arrivals", () => {
  it("refreshes committed notes and folders without bootstrapping or resetting recording", async () => {
    const dispatch = vi.fn();
    renderHook(() => useAccountLibrarySync(dispatch, "note"));
    await act(async () => notify());
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({
        type: "noteLoaded",
        note: { id: "note", editedContent: "received" },
      }),
    );
    expect(dispatch).toHaveBeenCalledWith({ type: "notesRefreshed", notes: [{ id: "note" }] });
    expect(dispatch).toHaveBeenCalledWith({ type: "foldersLoaded", folders: [{ id: "folder" }] });
    expect(
      dispatch.mock.calls.every(
        ([action]) => !["bootstrapLoaded", "recordingStatusCleared"].includes(action.type),
      ),
    ).toBe(true);
  });
  it("does not overwrite a note selected after an arrival read started", async () => {
    let resolve: (value: { id: string }) => void = () => {};
    mocks.getNote.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const dispatch = vi.fn();
    const { rerender } = renderHook(({ id }) => useAccountLibrarySync(dispatch, id), {
      initialProps: { id: "note" },
    });
    act(() => notify());
    rerender({ id: "other" });
    await act(async () => resolve({ id: "note" }));
    expect(dispatch.mock.calls.some(([action]) => action.type === "noteLoaded")).toBe(false);
  });
  it("ignores late results after the shell unmounts", async () => {
    let resolve: (value: { items: never[] }) => void = () => {};
    mocks.listNotes.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const dispatch = vi.fn();
    const { unmount } = renderHook(() => useAccountLibrarySync(dispatch));
    act(() => notify());
    unmount();
    await act(async () => resolve({ items: [] }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(mocks.unlisten).toHaveBeenCalled();
  });
});
