/**
 * The image panel on the stage: an empty scene before anything is made, the
 * veil over it while a render runs (with a pending cell in Recent), and the
 * result landing on it with a reveal and a remembered duration.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioScreen } from "../components/mobile/screens/StudioScreen";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
const studio = vi.hoisted(() => ({
  catalog: vi.fn(),
  artifacts: vi.fn(),
  generate: vi.fn(),
  save: vi.fn(),
  remember: vi.fn(),
}));

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
  saveArtifactFromBase64: studio.save,
}));
vi.mock("../lib/studio/generate-image", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/generate-image")>()),
  generateImages: studio.generate,
}));
vi.mock("../lib/studio/render-eta", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/render-eta")>()),
  rememberRenderMs: studio.remember,
}));
vi.mock("../lib/carpe-diem-credits", () => ({ useCarpeDiemCredits: () => null }));
vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  mediaJson: vi.fn().mockRejectedValue(new Error("offline")),
  mediaGet: vi.fn().mockRejectedValue(new Error("offline")),
}));

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function catalog() {
  return {
    backend: "carpe-diem" as const,
    priceMultiplier: 1,
    models: [
      {
        id: "chroma",
        name: "Chroma",
        mediaType: "image" as const,
        offline: false,
        constraints: { aspectRatios: ["1:1", "16:9"] },
      },
    ],
  };
}

beforeEach(() => {
  tauri.invoke.mockReset().mockResolvedValue(undefined);
  tauri.listen.mockReset().mockResolvedValue(() => undefined);
  studio.catalog.mockReset().mockResolvedValue(catalog());
  studio.artifacts.mockReset().mockResolvedValue([]);
  studio.save.mockReset().mockResolvedValue({ id: "a1", path: "a1.png" });
  studio.remember.mockReset();
  window.localStorage.clear();
});

describe("the image panel on the stage", () => {
  it("shows an empty scene, then the veil, then the result with a reveal", async () => {
    render(<StudioScreen />);
    await screen.findByRole("button", { name: /^Image model/ });
    const scene = screen.getByRole("region", { name: "Latest result" });
    expect(scene.textContent).toContain("Nothing rendered yet.");
    // Nothing to send yet, and the hint says why.
    const send = screen.getByRole("button", { name: "Generate" });
    expect(send.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Describe the image to generate it.")).toBeTruthy();

    // A render that takes a while.
    let finish: (images: string[]) => void = () => undefined;
    studio.generate.mockImplementation(
      () => new Promise<string[]>((resolve) => (finish = resolve)),
    );
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }), "a quiet harbour");
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));

    // The veil is on the scene, with the phase word, and Recent shows the
    // cell the result will take.
    await waitFor(() => expect(scene.querySelector(".stage-veil")).toBeTruthy());
    expect(scene.textContent).toContain("Rendering");
    expect(document.querySelector(".mobile-studio-cell-pending")).toBeTruthy();

    await act(async () => {
      finish([PNG]);
    });
    await waitFor(() => expect(scene.querySelector(".stage-veil")).toBeNull());
    const picture = scene.querySelector("img.stage-reveal") as HTMLImageElement;
    expect(picture).toBeTruthy();
    expect(picture.src).toContain("data:image/png;base64,");
    // Held invisible until decoded, then wiped in.
    expect(picture.getAttribute("data-reveal")).toBe("waiting");
    await act(async () => {
      picture.dispatchEvent(new Event("load"));
    });
    expect(picture.getAttribute("data-reveal")).toBe("true");
    // The duration is remembered for the next estimate.
    expect(studio.remember).toHaveBeenCalledWith("image:chroma", expect.any(Number));
    // Recent no longer shows a pending cell.
    expect(document.querySelector(".mobile-studio-cell-pending")).toBeNull();
  });
});
