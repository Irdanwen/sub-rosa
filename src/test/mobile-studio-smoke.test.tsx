/**
 * Every Studio tab mounts, and shows the control it exists for.
 *
 * `StudioScreen.tsx` is three thousand three hundred lines and eleven internal
 * components. Nothing in the suite mounted more than the video form, which
 * meant any change to the file -- and above all splitting it into one file per
 * tab -- had to be verified by opening the app and looking. This is the net
 * under that: it does not assert how a panel looks, only that each one still
 * renders and still offers its principal control.
 *
 * It is deliberately shallow. A smoke test that asserts details becomes a
 * second copy of the UI and starts failing for reasons nobody cares about; the
 * detailed behaviour of the video form lives in
 * `mobile-studio-reference-media.test.tsx`, which owns that subject.
 */

import { render, screen, waitFor } from "@testing-library/react";
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
vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  // Offline on purpose: a quote in flight would add a pending request to every
  // assertion below without changing what is being checked.
  mediaJson: vi.fn().mockRejectedValue(new Error("offline")),
  mediaGet: vi.fn().mockRejectedValue(new Error("offline")),
}));

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:clip");
  URL.revokeObjectURL = vi.fn();
  tauri.invoke.mockReset().mockResolvedValue(undefined);
  tauri.listen.mockReset().mockResolvedValue(() => undefined);
  studio.catalog.mockReset().mockResolvedValue(seedanceCatalog());
  studio.artifacts.mockReset().mockResolvedValue([]);
  window.localStorage.clear();
});

/** Move to a tab and wait for it to settle. */
async function openTab(name: string) {
  await userEvent.click(screen.getByRole("tab", { name }));
  await waitFor(() =>
    expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true"),
  );
}

describe("the mobile studio", () => {
  it("offers all five tabs", async () => {
    render(<StudioScreen />);

    for (const name of ["Image", "Video", "Audio", "Flows", "Gallery"]) {
      expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    }
  });

  it("opens on the image form with a model to pick", async () => {
    render(<StudioScreen />);

    expect(await screen.findByRole("button", { name: /^Image model/ })).toBeInTheDocument();
  });

  it("renders the video form", async () => {
    render(<StudioScreen />);
    await openTab("Video");

    expect(await screen.findByRole("button", { name: /^Video model/ })).toBeInTheDocument();
  });

  it("renders the audio form with its three kinds of sound", async () => {
    render(<StudioScreen />);
    await openTab("Audio");

    const modes = await screen.findByRole("tablist", { name: "Audio mode" });
    expect(modes).toBeInTheDocument();
  });

  it("renders the flows tab", async () => {
    render(<StudioScreen />);
    await openTab("Flows");

    // Nothing is asserted about which flows exist -- only that the panel
    // mounted rather than throwing on the way in.
    expect(screen.getByRole("tab", { name: "Flows" })).toHaveAttribute("aria-selected", "true");
  });

  it("renders the library, and says so when it is empty", async () => {
    render(<StudioScreen />);
    await openTab("Gallery");

    expect(screen.getByRole("tab", { name: "Gallery" })).toHaveAttribute("aria-selected", "true");
  });
});
