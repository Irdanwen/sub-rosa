import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FolderScreen } from "../components/mobile/screens/FoldersScreen";
import { NotesScreen } from "../components/mobile/screens/NotesScreen";
import type { FolderDto, NoteListItemDto } from "../lib/tauri";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("../lib/tauri")>("../lib/tauri");
  return {
    ...actual,
    searchEverything: vi.fn(async () => []),
    listActiveIngests: vi.fn(async () => []),
    previewIngestLink: vi.fn(async () => null),
  };
});
vi.mock("../lib/errands", () => ({
  errandCancel: vi.fn(),
  errandList: vi.fn(async () => []),
  errandRequest: vi.fn(),
  errandTargets: vi.fn(async () => []),
  onErrands: vi.fn(() => () => undefined),
}));
vi.mock("../lib/haptics", () => ({
  hapticSelection: vi.fn(),
  hapticNotify: vi.fn(),
  hapticImpact: vi.fn(),
}));

const stamp = "2026-09-20T10:00:00.000Z";
const folders: FolderDto[] = [
  { id: "film", name: "Film", createdAt: stamp, updatedAt: stamp },
  { id: "work", name: "Work", createdAt: stamp, updatedAt: stamp },
  { id: "archive", name: "Archive", createdAt: stamp, updatedAt: stamp },
];
const note = (id: string, title: string, folderIds: string[] = []): NoteListItemDto => ({
  id,
  title,
  preview: "",
  processingStatus: "ready",
  folderIds,
  createdAt: stamp,
  updatedAt: stamp,
});
const notes = [note("a", "Books", ["film"]), note("b", "Project idea"), note("c", "Meeting")];

function renderNotes(overrides: Partial<Parameters<typeof NotesScreen>[0]> = {}) {
  const props = {
    notes,
    folders,
    archiveFolderId: "archive",
    onSelectNote: vi.fn(),
    onRecord: vi.fn(),
    onCreateNote: vi.fn(),
    onImportAudio: vi.fn(),
    onOpenFolder: vi.fn(),
    onOpenDictation: vi.fn(),
    onDeleteNote: vi.fn(),
    onArchiveNote: vi.fn(),
    onMoveNotes: vi.fn(),
    onCreateFolder: vi.fn(async () => undefined),
    onRefresh: vi.fn(async () => undefined),
    ...overrides,
  };
  render(<NotesScreen {...props} />);
  return props;
}

describe("filing notes on the phone", () => {
  it("moves several selected notes into one folder", async () => {
    const props = renderNotes();
    await userEvent.click(screen.getByRole("button", { name: "Select notes" }));
    await userEvent.click(screen.getByRole("button", { name: /Books/ }));
    await userEvent.click(screen.getByRole("button", { name: /Project idea/ }));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));

    const sheet = screen.getByRole("dialog", { name: "Move 2 notes" });
    // The notes come from different places, so nothing is ticked, and the
    // Archive (a state) is not a destination.
    expect(within(sheet).queryByRole("button", { pressed: true })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Archive" })).toBeNull();
    await userEvent.click(within(sheet).getByRole("button", { name: "Work" }));

    expect(props.onMoveNotes).toHaveBeenCalledWith(["a", "b"], "work");
  });

  it("ticks the folder a single note is already in", async () => {
    renderNotes();
    await userEvent.click(screen.getByRole("button", { name: "Select notes" }));
    await userEvent.click(screen.getByRole("button", { name: /Books/ }));
    await userEvent.click(screen.getByRole("button", { name: "Move" }));
    const sheet = screen.getByRole("dialog", { name: "Move to a folder" });
    expect(within(sheet).getByRole("button", { name: "Film", pressed: true })).toBeTruthy();
  });

  it("makes a folder from the chip row", async () => {
    const props = renderNotes();
    await userEvent.click(screen.getByRole("button", { name: "Folder" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Folder name" }), "Clients");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(props.onCreateFolder).toHaveBeenCalledWith("Clients");
  });
});

describe("a folder on the phone", () => {
  function renderFolder(isArchiveFolder = false) {
    const props = {
      folder: folders[0],
      notes: [notes[0]],
      isArchiveFolder,
      onBack: vi.fn(),
      onSelectNote: vi.fn(),
      onCreateNote: vi.fn(),
      onDeleteNote: vi.fn(),
      onRemoveFromFolder: vi.fn(),
      candidates: [notes[1], notes[2]],
      onAddNotes: vi.fn(),
      onRename: vi.fn(),
      onDeleteFolder: vi.fn(),
    };
    render(<FolderScreen {...props} />);
    return props;
  }

  it("can be deleted while keeping its notes", async () => {
    const props = renderFolder();
    await userEvent.click(screen.getByRole("button", { name: "Folder actions" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete folder" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete the folder, keep the notes" }),
    );
    expect(props.onDeleteFolder).toHaveBeenCalledWith(false);
  });

  it("takes notes that already exist", async () => {
    const props = renderFolder();
    await userEvent.click(screen.getByRole("button", { name: "Folder actions" }));
    await userEvent.click(screen.getByRole("button", { name: "Add notes" }));
    const sheet = await screen.findByRole("dialog", { name: "Add to Film" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Meeting" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Add (1)" }));
    expect(props.onAddNotes).toHaveBeenCalledWith(["c"]);
  });

  it("keeps the Archive out of reach of rename and delete", () => {
    renderFolder(true);
    expect(screen.queryByRole("button", { name: "Folder actions" })).toBeNull();
  });
});
