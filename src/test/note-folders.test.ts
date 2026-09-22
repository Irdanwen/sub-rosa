import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  assignNoteToFolder: vi.fn(),
  removeNoteFromFolder: vi.fn(),
}));
vi.mock("../lib/tauri", () => bridge);

import { moveNoteToFolder, noteFolderId } from "../lib/note-folders";

beforeEach(() => {
  bridge.assignNoteToFolder.mockReset().mockImplementation(async (id, folderId) => ({
    id,
    folderIds: [folderId],
  }));
  bridge.removeNoteFromFolder.mockReset().mockImplementation(async (id) => ({ id, folderIds: [] }));
});

describe("moveNoteToFolder", () => {
  it("leaves a note in exactly the folder it was moved to", async () => {
    await moveNoteToFolder({ id: "n", folderIds: ["a", "b"] }, "c");
    expect(bridge.removeNoteFromFolder.mock.calls).toEqual([
      ["n", "a"],
      ["n", "b"],
    ]);
    expect(bridge.assignNoteToFolder).toHaveBeenCalledWith("n", "c");
  });

  it("keeps the folders it is told to keep", async () => {
    await moveNoteToFolder({ id: "n", folderIds: ["archive", "a"] }, "c", { keep: ["archive"] });
    expect(bridge.removeNoteFromFolder.mock.calls).toEqual([["n", "a"]]);
  });

  it("takes a note out of every folder when moved to none", async () => {
    await moveNoteToFolder({ id: "n", folderIds: ["a"] }, undefined);
    expect(bridge.removeNoteFromFolder).toHaveBeenCalledWith("n", "a");
    expect(bridge.assignNoteToFolder).not.toHaveBeenCalled();
  });

  it("does nothing when the note is already where it is going", async () => {
    const result = await moveNoteToFolder({ id: "n", folderIds: ["a"] }, "a");
    expect(result).toBeUndefined();
    expect(bridge.removeNoteFromFolder).not.toHaveBeenCalled();
    expect(bridge.assignNoteToFolder).not.toHaveBeenCalled();
  });
});

describe("noteFolderId", () => {
  it("names the project, not the archive", () => {
    expect(noteFolderId({ id: "n", folderIds: ["archive", "a"] }, ["archive"])).toBe("a");
  });
});
