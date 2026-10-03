/**
 * The gallery as a person uses it: narrowing by kind, a long press for what
 * can be done to one item, favourites, hiding, folders made from a selection,
 * and a delete that says it reaches the other devices (ADR-0073).
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioGallery } from "../components/mobile/screens/studio/StudioGallery";
import type { StudioArtifact } from "../lib/studio/types";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

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
    posterVersion: 1,
  };
}
const ITEMS = [
  item(1, "image", "A lighthouse"),
  item(2, "video", "A tram"),
  item(3, "music", "A waltz"),
];

let library: { collections: unknown[]; marks: unknown[] };
beforeEach(() => {
  library = { collections: [], marks: [] };
  tauri.invoke
    .mockReset()
    .mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "studio_library_list") return library;
      if (command === "studio_collection_save") {
        return { id: uuid(90), name: args?.name, createdAt: "now", updatedAt: "now" };
      }
      return undefined;
    });
  window.localStorage.clear();
});

function renderGallery(onChanged = vi.fn()) {
  return render(<StudioGallery items={ITEMS} onOpen={vi.fn()} onChanged={onChanged} />);
}

describe("the gallery", () => {
  it("narrows by kind", async () => {
    renderGallery();
    expect(screen.getAllByRole("button", { name: /A (lighthouse|tram|waltz)/ })).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "Videos" }));
    expect(screen.getAllByRole("button", { name: /A (lighthouse|tram|waltz)/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Sounds" }));
    expect(screen.getByRole("button", { name: "A waltz" })).toBeTruthy();
  });

  it("favourites an item from its long-press menu, and keeps it under Favourites", async () => {
    renderGallery();
    const tile = screen.getByRole("button", { name: "A lighthouse" });
    tile.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    const sheet = await screen.findByRole("dialog");
    await userEvent.click(within(sheet).getByRole("button", { name: "Add to favorites" }));
    expect(tauri.invoke).toHaveBeenCalledWith("studio_library_mark", {
      request: { ids: [ITEMS[0].fileName], favorite: true },
    });
    await userEvent.click(screen.getByRole("button", { name: "Favorites" }));
    expect(screen.getAllByRole("button", { name: /A (lighthouse|tram|waltz)/ })).toHaveLength(1);
  });

  it("keeps hidden items out of the gallery until asked for", async () => {
    library.marks = [
      { id: "m2", fileId: uuid(2), collectionId: null, favorite: false, hidden: true },
    ];
    renderGallery();
    await screen.findByRole("button", { name: "1 hidden item" });
    expect(screen.queryByRole("button", { name: "A tram" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "1 hidden item" }));
    expect(screen.getByRole("button", { name: "A tram" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "A lighthouse" })).toBeNull();
  });

  it("files a selection into a new folder", async () => {
    renderGallery();
    await userEvent.click(screen.getByRole("button", { name: "Select" }));
    await userEvent.click(screen.getByRole("button", { name: "A lighthouse" }));
    await userEvent.click(screen.getByRole("button", { name: "A tram" }));
    expect(screen.getByText("2 selected")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Add to a folder" }));
    await userEvent.click(await screen.findByRole("button", { name: "New folder" }));
    await userEvent.type(await screen.findByRole("textbox"), "Storyboard");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith("studio_library_mark", {
        request: {
          ids: [ITEMS[0].fileName, ITEMS[1].fileName],
          collectionId: uuid(90),
        },
      }),
    );
  });

  it("asks before deleting, and says it reaches the other devices", async () => {
    const onChanged = vi.fn();
    renderGallery(onChanged);
    screen
      .getByRole("button", { name: "A waltz" })
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    const menu = await screen.findByRole("dialog");
    await userEvent.click(within(menu).getByRole("button", { name: "Delete" }));
    expect(
      await screen.findByText(
        "They are deleted from this device and from your other synced devices.",
      ),
    ).toBeTruthy();
    expect(tauri.invoke).not.toHaveBeenCalledWith(
      "carpe_diem_media_delete_artifact",
      expect.anything(),
    );
    const confirm = screen.getAllByRole("dialog").at(-1) as HTMLElement;
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(tauri.invoke).toHaveBeenCalledWith("carpe_diem_media_delete_artifact", {
      request: { path: ITEMS[2].path },
    });
  });
});
