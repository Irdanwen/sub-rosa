/**
 * The mobile video form's Generate button, against a model that will not
 * start without an opening frame.
 *
 * The button used to stay enabled while the request body refused to build,
 * so a tap did nothing and nothing said why. It now follows the body, as the
 * desktop's does, and the hint under it names the missing frame - with a tap
 * to add one, and a tap to the same vendor's family that runs from
 * references alone.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioScreen } from "../components/mobile/screens/StudioScreen";
import { seedanceCatalog } from "./fixtures/seedance-catalog";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
const studio = vi.hoisted(() => ({ catalog: vi.fn(), artifacts: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("../lib/studio/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/catalog")>()),
  fetchMediaCatalog: studio.catalog,
}));
vi.mock("../lib/studio/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/artifacts")>()),
  listArtifacts: studio.artifacts,
}));
vi.mock("../lib/carpe-diem-credits", () => ({ useCarpeDiemCredits: () => null }));
vi.mock("../lib/studio/downscale", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/downscale")>()),
  // jsdom decodes no image, so the real measurement never resolves. The
  // size gate it feeds stays real and sees a photo every model accepts.
  imageSize: vi.fn().mockResolvedValue({ width: 1024, height: 1024 }),
}));
vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  mediaJson: vi.fn().mockRejectedValue(new Error("offline")),
  mediaGet: vi.fn().mockRejectedValue(new Error("offline")),
}));

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function openVideoTab() {
  render(<StudioScreen />);
  await userEvent.click(screen.getByRole("tab", { name: "Video" }));
  return await screen.findByRole("button", { name: /^Video model/ });
}

async function chooseFamily(picker: HTMLElement, query: string, name: string) {
  await userEvent.click(picker);
  await userEvent.type(await screen.findByPlaceholderText("Search models"), query);
  await userEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
  await waitFor(() => expect(screen.queryByPlaceholderText("Search models")).toBeNull());
}

/** Add one reference photo through the hidden file input of the named picker. */
async function addReferencePhoto() {
  await userEvent.click(screen.getByRole("button", { name: "More options" }));
  const picker = screen
    .getByRole("button", { name: "Add reference photos" })
    .closest(".mobile-reference") as HTMLElement;
  const input = picker.querySelector('input[type="file"]:not([capture])') as HTMLInputElement;
  const bytes = Uint8Array.from(atob(PNG.split(",")[1]), (char) => char.charCodeAt(0));
  await userEvent.upload(input, new File([bytes], "ref.png", { type: "image/png" }));
  await waitFor(() => expect(within(picker).getByAltText("Reference 1")).toBeTruthy());
}

const generate = () => screen.getByRole("button", { name: /^Generate/ });

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:ref");
  URL.revokeObjectURL = vi.fn();
  tauri.invoke.mockReset().mockResolvedValue(undefined);
  tauri.listen.mockReset().mockResolvedValue(() => undefined);
  studio.catalog.mockReset().mockResolvedValue(seedanceCatalog());
  studio.artifacts.mockReset().mockResolvedValue([]);
  window.localStorage.clear();
});

describe("a reference model that insists on an opening frame", () => {
  it("disables Generate, names the frame, and offers the frame-free family", async () => {
    const picker = await openVideoTab();
    await chooseFamily(picker, "kling v3", "Kling V3 4K");
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }), "the room at dusk");
    // Text to video so far: the button is live.
    expect(generate().hasAttribute("disabled")).toBe(false);

    await addReferencePhoto();
    // References resolve to the reference variant, which cannot build a body
    // without the frame: the button follows, and the hint says why.
    await waitFor(() => expect(generate().hasAttribute("disabled")).toBe(true));
    expect(screen.getByText("Add an opening frame: Kling V3 4K starts from one.")).toBeTruthy();
    expect(
      screen.getByText("Opening frame required: Kling V3 4K starts from this photo."),
    ).toBeTruthy();
    // The red paragraph is gone; the hint carries it.
    expect(document.querySelector(".mobile-dictation-error")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Use Kling O3 4K instead" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Video model/ }).textContent).toContain(
        "Kling O3 4K",
      ),
    );
    // Kling O3 renders from references alone: the body builds, the button is back.
    await waitFor(() => expect(generate().hasAttribute("disabled")).toBe(false));
    expect(screen.queryByText(/Add an opening frame:/)).toBeNull();
  });

  it("opens the opening-frame picker from the hint", async () => {
    const picker = await openVideoTab();
    await chooseFamily(picker, "kling v3", "Kling V3 4K");
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }), "the room at dusk");
    await addReferencePhoto();
    await userEvent.click(await screen.findByRole("button", { name: "Add an opening frame" }));
    // On a desktop test runner there is one source besides the gallery (no
    // camera), so the picker opens the file input directly rather than a
    // sheet; either way nothing is left dead. With gallery images the sheet
    // would show. Here: the slot scrolled into view and no error was thrown.
    expect(screen.getByRole("button", { name: "Opening frame" })).toBeTruthy();
  });

  it("shows a render in flight as the veil over the scene", async () => {
    tauri.invoke.mockImplementation(async (command: string) =>
      command === "media_job_list"
        ? [
            {
              id: "j1",
              kind: "video",
              model: "kling-o3-4k-reference-to-video",
              prompt: "the room at dusk",
              extension: "mp4",
              status: "processing",
              createdAt: new Date(Date.now() - 42_000).toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ]
        : undefined,
    );
    await openVideoTab();
    const scene = screen.getByRole("region", { name: "Latest result" });
    await waitFor(() => expect(scene.querySelector(".stage-veil")).toBeTruthy());
    expect(scene.textContent).toContain("Rendering");
    // The round send button is held while the render runs.
    expect(generate().hasAttribute("disabled")).toBe(true);
  });
});
