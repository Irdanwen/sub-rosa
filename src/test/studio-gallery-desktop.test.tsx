/**
 * The desktop gallery: every Studio file in one place, with the phone's
 * folders, favourites and hidden items (ADR-0073 marks), and a file filed in
 * a folder kept out of the kind views.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioGalleryDesktop } from "../components/studio/StudioGalleryDesktop";
import type { StudioArtifact } from "../lib/studio/types";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
const files = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
  exportCopy: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, convertFileSrc: (p: string) => p }));
vi.mock("../lib/studio/artifacts", () => ({
  listArtifacts: files.list,
  deleteArtifact: files.remove,
  exportArtifact: files.exportCopy,
  artifactSrc: (artifact: { path: string }) => artifact.path,
}));
vi.mock("../lib/artifact-media", () => ({ useArtifactThumbnail: () => null }));

const uuid = (n: number) => `0192f1a0-7c3e-7d4b-9a10-2f9f5b8e4c${String(n).padStart(2, "0")}`;
function item(n: number, kind: StudioArtifact["kind"], prompt: string): StudioArtifact {
  const ext = kind === "image" ? "png" : kind === "video" ? "mp4" : "mp3";
  return {
    id: `${uuid(n)}.${ext}`,
    kind,
    path: `/gallery/${uuid(n)}.${ext}`,
    fileName: `${uuid(n)}.${ext}`,
    bytes: 10,
    model: "m",
    prompt,
    createdAt: Date.now() - n * 1000,
  };
}
const ITEMS = [
  item(1, "image", "A lighthouse"),
  item(2, "video", "A tram"),
  item(3, "music", "A waltz"),
];

let library: { collections: unknown[]; marks: unknown[] };
beforeEach(() => {
  library = {
    collections: [{ id: "board", name: "Storyboard", createdAt: "", updatedAt: "" }],
    marks: [{ id: "m2", fileId: uuid(2), collectionId: "board", favorite: false, hidden: false }],
  };
  files.list.mockReset().mockResolvedValue(ITEMS);
  files.remove.mockReset().mockResolvedValue(undefined);
  files.exportCopy.mockReset().mockResolvedValue(undefined);
  tauri.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "studio_library_list") return library;
    return undefined;
  });
});

const card = (name: string) => screen.queryByRole("button", { name: `Open ${name}` });

describe("the desktop gallery", () => {
  it("shows what is in no folder, by day, and narrows by kind", async () => {
    render(<StudioGalleryDesktop />);
    expect(await screen.findByRole("button", { name: "Open A lighthouse" })).toBeInTheDocument();
    expect(card("A waltz")).toBeInTheDocument();
    expect(card("A tram")).toBeNull();
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Images", pressed: false }));
    expect(card("A lighthouse")).toBeInTheDocument();
    expect(card("A waltz")).toBeNull();
  });

  it("finds a filed file by search, and inside its folder", async () => {
    render(<StudioGalleryDesktop />);
    await screen.findByRole("button", { name: "Open A lighthouse" });
    await userEvent.type(screen.getByRole("searchbox", { name: "Search the gallery" }), "tram");
    expect(card("A tram")).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("searchbox", { name: "Search the gallery" }));

    await userEvent.click(screen.getByRole("button", { name: "Folders", pressed: false }));
    await userEvent.click(screen.getByRole("button", { name: /Storyboard/ }));
    expect(card("A tram")).toBeInTheDocument();
    expect(card("A lighthouse")).toBeNull();
  });

  it("favourites a file and files it into a folder", async () => {
    render(<StudioGalleryDesktop />);
    await screen.findByRole("button", { name: "Open A lighthouse" });
    const lighthouse = screen
      .getByRole("button", { name: "Open A lighthouse" })
      .closest("figure") as HTMLElement;

    await userEvent.click(within(lighthouse).getByRole("button", { name: "Add to favorites" }));
    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith("studio_library_mark", {
        request: { ids: [ITEMS[0].fileName], favorite: true },
      }),
    );

    await userEvent.click(within(lighthouse).getByRole("button", { name: "Add to a folder" }));
    const dialog = await screen.findByRole("dialog", { name: "Add to a folder" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Storyboard" }));
    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith("studio_library_mark", {
        request: { ids: [ITEMS[0].fileName], collectionId: "board" },
      }),
    );
    // Filed, it leaves All.
    expect(card("A lighthouse")).toBeNull();
  });

  it("asks before deleting a file", async () => {
    render(<StudioGalleryDesktop />);
    await screen.findByRole("button", { name: "Open A waltz" });
    const waltz = screen
      .getByRole("button", { name: "Open A waltz" })
      .closest("figure") as HTMLElement;
    await userEvent.click(within(waltz).getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete this item?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(files.remove).toHaveBeenCalledWith(ITEMS[2]));
  });
});
