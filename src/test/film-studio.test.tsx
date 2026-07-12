import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  videomakerGetSettings: vi.fn(),
  videomakerListProjects: vi.fn(),
  videomakerProjectStatus: vi.fn(),
  videomakerCreateProject: vi.fn(),
  videomakerStartRun: vi.fn(),
  videomakerExportFilm: vi.fn(),
  videomakerDeleteProject: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  videomakerGetSettings: mocks.videomakerGetSettings,
  videomakerListProjects: mocks.videomakerListProjects,
  videomakerProjectStatus: mocks.videomakerProjectStatus,
  videomakerCreateProject: mocks.videomakerCreateProject,
  videomakerStartRun: mocks.videomakerStartRun,
  videomakerExportFilm: mocks.videomakerExportFilm,
  videomakerDeleteProject: mocks.videomakerDeleteProject,
}));

// GalleryStrip talks to the artifact commands; keep the suite focused on the
// film flow.
vi.mock("../components/studio/GalleryStrip", () => ({
  GalleryStrip: () => null,
}));

import { FilmStudio } from "../components/studio/FilmStudio";
import { parseProduceOutcome, parseProjectList, parseStatus } from "../lib/films";

const project = (over: Record<string, unknown> = {}) => ({
  slug: "ab12cd34ef56-neon-alley-duel",
  title: "Neon alley duel",
  state: "production",
  final_mp4: false,
  updated_at: "2026-07-12T08:00:00Z",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.videomakerGetSettings.mockResolvedValue({
    baseUrl: "https://studio.furetier.com",
    defaultBaseUrl: "https://studio.furetier.com",
    activated: true,
    hasCarpeDiemKey: true,
  });
  mocks.videomakerListProjects.mockResolvedValue({ projects: [] });
  mocks.videomakerProjectStatus.mockResolvedValue({});
});

describe("FilmStudio", () => {
  it("points to Settings when film production is not activated", async () => {
    mocks.videomakerGetSettings.mockResolvedValue({
      baseUrl: "https://studio.furetier.com",
      defaultBaseUrl: "https://studio.furetier.com",
      activated: false,
      hasCarpeDiemKey: false,
    });
    render(<FilmStudio />);
    expect(await screen.findByText("Film production is not activated")).toBeInTheDocument();
    expect(mocks.videomakerListProjects).not.toHaveBeenCalled();
  });

  it("creates an autonomous project and hands the brief to a run", async () => {
    mocks.videomakerCreateProject.mockResolvedValue({
      project: project({ state: "new" }),
    });
    mocks.videomakerStartRun.mockResolvedValue({ run: { id: "r1", status: "running" } });
    render(<FilmStudio />);
    fireEvent.change(await screen.findByLabelText("Film title"), {
      target: { value: "Neon alley duel" },
    });
    fireEvent.change(screen.getByLabelText("Film brief"), {
      target: { value: "Two rivals in the rain." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Produce the film" }));
    await waitFor(() => expect(mocks.videomakerStartRun).toHaveBeenCalledTimes(1));
    expect(mocks.videomakerCreateProject).toHaveBeenCalledWith(
      expect.objectContaining({ autonomous: true, budgetCeilingDiem: 300 }),
    );
    expect(mocks.videomakerStartRun).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "ab12cd34ef56-neon-alley-duel",
        brief: "Two rivals in the rain.",
        maxCostDiem: 300,
        produce: true,
      }),
    );
  });

  it("offers the gallery download only once the final cut exists", async () => {
    mocks.videomakerListProjects.mockResolvedValue({
      projects: [project(), project({ slug: "done-slug", title: "Done film", final_mp4: true })],
    });
    mocks.videomakerExportFilm.mockResolvedValue({
      path: "/gallery/film.mp4",
      fileName: "film.mp4",
      bytes: 42,
    });
    render(<FilmStudio />);
    const download = await screen.findByRole("button", { name: "Save to gallery" });
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(2);
    fireEvent.click(download);
    await waitFor(() => expect(mocks.videomakerExportFilm).toHaveBeenCalledWith("done-slug"));
  });
});

describe("films payload parsing", () => {
  it("parses Videomaker project lists defensively", () => {
    const projects = parseProjectList({
      projects: [project(), { not: "a project" }, project({ slug: "b", title: null })],
    });
    expect(projects).toHaveLength(2);
    expect(projects[0].title).toBe("Neon alley duel");
    expect(projects[1].title).toBe("b");
  });

  it("parses a status rollup with snake_case fields", () => {
    const status = parseStatus({
      daemon: "running",
      queue: { queued: 3, running: 1, blocked_quota: 0, done: 7, failed: 1 },
      cost: { spent_diem: 12.5, pending_diem: 4, projected_diem: 16.5, ceiling_diem: 300 },
      wallet_empty: false,
    });
    expect(status.queue.done).toBe(7);
    expect(status.cost.ceilingDiem).toBe(300);
    expect(status.walletEmpty).toBe(false);
  });

  it("reads the flattened produce handshake", () => {
    expect(parseProduceOutcome({ needs_confirmation: true, projected_cost_diem: 412.5 })).toEqual({
      started: false,
      needsConfirmation: true,
      projectedCostDiem: 412.5,
    });
    expect(parseProduceOutcome({ started: true })).toEqual({
      started: true,
      needsConfirmation: false,
      projectedCostDiem: undefined,
    });
  });
});
