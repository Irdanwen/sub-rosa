/**
 * Renders in flight, shown where their result will land: a cell in Recent
 * under the tab that queued them, a section at the top of the gallery. Read
 * off the durable rows, never written to the gallery (ADR-0020), and never
 * for a row another surface owns (a retouch files its own versions).
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
vi.mock("../lib/studio/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/studio/client")>()),
  mediaJson: vi.fn().mockRejectedValue(new Error("offline")),
  mediaGet: vi.fn().mockRejectedValue(new Error("offline")),
}));

function row(id: string, kind: string, source?: string) {
  return {
    id,
    kind,
    model: "seedance-2-5-text-to-video-basic",
    prompt: "a harbour",
    extension: kind === "video" ? "mp4" : "png",
    status: "processing",
    source,
    createdAt: new Date(Date.now() - 30_000).toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  tauri.invoke.mockReset().mockResolvedValue(undefined);
  tauri.listen.mockReset().mockResolvedValue(() => undefined);
  studio.catalog.mockReset().mockResolvedValue(seedanceCatalog());
  studio.artifacts.mockReset().mockResolvedValue([]);
  window.localStorage.clear();
});

describe("renders in flight", () => {
  it("take their cell in Recent under their tab, and a section in the gallery", async () => {
    tauri.invoke.mockImplementation(async (command: string) =>
      command === "media_job_list"
        ? [row("v1", "video"), row("r1", "image", "retouch:root")]
        : undefined,
    );
    render(<StudioScreen />);
    // The image tab queued nothing of its own: the retouch row is the
    // retouch's, and the video row belongs to the video tab.
    await screen.findByRole("button", { name: /^Image model/ });
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("media_job_list"));
    expect(screen.queryByRole("region", { name: "Recent" })).toBeNull();

    await userEvent.click(screen.getByRole("tab", { name: "Video" }));
    const recent = await screen.findByRole("region", { name: "Recent" });
    expect(recent.querySelectorAll(".mobile-studio-cell-pending")).toHaveLength(1);

    await userEvent.click(screen.getByRole("tab", { name: "Gallery" }));
    const section = await screen.findByRole("region", { name: "In progress" });
    expect(section.querySelectorAll(".mobile-studio-cell-pending")).toHaveLength(1);
    expect(within(section).getByText("Rendering")).toBeTruthy();
  });

  it("show nothing when nothing is running", async () => {
    render(<StudioScreen />);
    await screen.findByRole("button", { name: /^Image model/ });
    await userEvent.click(screen.getByRole("tab", { name: "Gallery" }));
    expect(screen.getByText("Nothing generated yet")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "In progress" })).toBeNull();
  });
});
