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
  videomakerUploadRef: vi.fn(),
  videomakerImproveBrief: vi.fn(),
  videomakerUpdateBudget: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  videomakerGetSettings: mocks.videomakerGetSettings,
  videomakerListProjects: mocks.videomakerListProjects,
  videomakerProjectStatus: mocks.videomakerProjectStatus,
  videomakerCreateProject: mocks.videomakerCreateProject,
  videomakerStartRun: mocks.videomakerStartRun,
  videomakerExportFilm: mocks.videomakerExportFilm,
  videomakerDeleteProject: mocks.videomakerDeleteProject,
  videomakerUploadRef: mocks.videomakerUploadRef,
  videomakerImproveBrief: mocks.videomakerImproveBrief,
  videomakerUpdateBudget: mocks.videomakerUpdateBudget,
}));

// GalleryStrip talks to the artifact commands; keep the suite focused on the
// film flow.
vi.mock("../components/studio/GalleryStrip", () => ({
  GalleryStrip: () => null,
}));

import { FilmStudio } from "../components/studio/FilmStudio";
import {
  buildRefsManifest,
  parseProduceOutcome,
  parseProjectList,
  parseStatus,
  parseUploadedRef,
} from "../lib/films";

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

  it("develops the brief with AI and only applies it on accept", async () => {
    mocks.videomakerImproveBrief.mockResolvedValue("Logline: two rivals, one alley.");
    render(<FilmStudio />);
    const briefInput = await screen.findByLabelText("Film brief");
    fireEvent.change(briefInput, { target: { value: "Two rivals in the rain." } });
    fireEvent.click(screen.getByRole("button", { name: "Improve with AI" }));
    expect(await screen.findByText("Logline: two rivals, one alley.")).toBeInTheDocument();
    // The draft is untouched until the user accepts the preview.
    expect(briefInput).toHaveValue("Two rivals in the rain.");
    fireEvent.click(screen.getByRole("button", { name: "Use this brief" }));
    expect(briefInput).toHaveValue("Logline: two rivals, one alley.");
    expect(mocks.videomakerImproveBrief).toHaveBeenCalledWith(
      expect.objectContaining({ brief: "Two rivals in the rain.", targetDurationSeconds: 60 }),
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

  it("raises the budget ceiling on an over-budget project", async () => {
    mocks.videomakerListProjects.mockResolvedValue({ projects: [project({ slug: "over" })] });
    mocks.videomakerProjectStatus.mockResolvedValue({
      daemon: "idle",
      queue: { queued: 0, running: 0, blocked_quota: 0, done: 6, failed: 2 },
      cost: { spent_diem: 46.6, pending_diem: 0, projected_diem: 46.6, ceiling_diem: 40 },
      wallet_empty: false,
    });
    mocks.videomakerUpdateBudget.mockResolvedValue({ settings: { budget_ceiling_diem: 60 } });
    render(<FilmStudio />);
    // Over-budget notice appears (spent >= ceiling).
    expect(await screen.findByText(/Over the .* budget ceiling/)).toBeInTheDocument();
    const input = screen.getByLabelText("New budget ceiling for Neon alley duel");
    fireEvent.change(input, { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Raise ceiling" }));
    await waitFor(() =>
      expect(mocks.videomakerUpdateBudget).toHaveBeenCalledWith({ slug: "over", ceilingDiem: 60 }),
    );
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

  it("parses an uploaded reference and rejects incomplete payloads", () => {
    expect(
      parseUploadedRef({
        relative_path: "slug/assets/uploads/a.png",
        public_url: "https://studio.furetier.com/assets/slug/assets/uploads/a.png?sig=x",
        bytes: 42,
      }),
    ).toEqual({
      publicUrl: "https://studio.furetier.com/assets/slug/assets/uploads/a.png?sig=x",
      relativePath: "slug/assets/uploads/a.png",
    });
    expect(parseUploadedRef({ bytes: 42 })).toBeNull();
    expect(parseUploadedRef("nope")).toBeNull();
  });

  it("builds a refs manifest the crew can anchor on", () => {
    expect(buildRefsManifest([])).toBe("");
    const manifest = buildRefsManifest([
      { role: "character", label: "Nera", url: "https://s/1.png" },
      { role: "style", label: "  ", url: "https://s/2.png" },
    ]);
    expect(manifest).toContain('- Reference image 1 (character "Nera"): https://s/1.png');
    expect(manifest).toContain("- Reference image 2 (style): https://s/2.png");
    expect(manifest.startsWith("Reference images (already uploaded")).toBe(true);
  });
});
