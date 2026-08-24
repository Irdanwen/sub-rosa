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
  videomakerSetAutonomous: vi.fn(),
  videomakerListRuns: vi.fn(),
  videomakerCancelRun: vi.fn(),
  videomakerProduce: vi.fn(),
  videomakerBringHome: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({ ...mocks }));

// GalleryStrip talks to the artifact commands; keep the suite focused on the
// film flow.
vi.mock("../components/studio/GalleryStrip", () => ({
  GalleryStrip: () => null,
}));

// The rescue indexes files Rust already wrote; the gallery index itself is not
// what this suite is about.
vi.mock("../lib/studio/artifacts", () => ({
  registerDownloadedArtifact: vi.fn(),
}));

import { FilmStudio } from "../components/studio/FilmStudio";
import {
  buildRefsManifest,
  filmRunSummary,
  isRunStalled,
  parseProduceOutcome,
  parseProjectList,
  parseRuns,
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
  mocks.videomakerListRuns.mockResolvedValue({ runs: [] });
  mocks.createNote.mockResolvedValue({ id: "note-1" });
  mocks.updateNote.mockResolvedValue({ id: "note-1" });
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

  it("refuses to start a new film, and says where film production went", async () => {
    // R0 freeze: the remote studio is on its way out, so nothing new starts
    // here. The old creation test is gone on purpose - asserting a path the
    // product no longer offers is how a dead feature stays alive in CI.
    render(<FilmStudio />);
    fireEvent.change(await screen.findByLabelText("Film title"), {
      target: { value: "Neon alley duel" },
    });
    fireEvent.change(screen.getByLabelText("Film brief"), {
      target: { value: "Two rivals in the rain." },
    });
    expect(screen.getByRole("button", { name: "Produce the film" })).toBeDisabled();
    expect(screen.getByRole("status").textContent).toContain("No new film starts here");
    expect(mocks.videomakerCreateProject).not.toHaveBeenCalled();
    expect(mocks.videomakerStartRun).not.toHaveBeenCalled();
  });

  it("brings an existing film home into a note before the surface goes", async () => {
    mocks.videomakerListProjects.mockResolvedValue({ projects: [project()] });
    mocks.videomakerBringHome.mockResolvedValue({
      slug: "ab12cd34ef56-neon-alley-duel",
      title: "Neon alley duel",
      brief: "Two rivals in the rain.",
      state: "production",
      createdAt: "2026-07-12",
      spentDiem: 40,
      pieces: [{ path: "/g/a.mp4", fileName: "a.mp4", bytes: 12, kind: "master" }],
      transcript: [],
      problems: [],
    });
    render(<FilmStudio />);
    fireEvent.click(await screen.findByRole("button", { name: "Bring it home" }));
    await waitFor(() => expect(mocks.createNote).toHaveBeenCalledTimes(1));
    expect(mocks.videomakerBringHome).toHaveBeenCalledWith("ab12cd34ef56-neon-alley-duel");
    expect(mocks.updateNote).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: "note-1", title: "Neon alley duel" }),
    );
    // Once home, the action stays available so a partial rescue can be retried
    // while the studio is still up.
    expect(await screen.findByRole("button", { name: "Fetch it again" })).toBeEnabled();
  });

  it("empties the studio in one action, and does not stop at the first failure", async () => {
    mocks.videomakerListProjects.mockResolvedValue({
      projects: [project(), project({ slug: "zz99-second-film", title: "Second film" })],
    });
    mocks.videomakerBringHome.mockImplementation(async (slug: string) => {
      if (slug === "zz99-second-film") throw new Error("the master has expired");
      return {
        slug,
        title: "Neon alley duel",
        brief: null,
        state: null,
        createdAt: null,
        spentDiem: null,
        pieces: [{ path: "/g/a.mp4", fileName: "a.mp4", bytes: 12, kind: "master" }],
        transcript: [],
        problems: [],
      };
    });
    render(<FilmStudio />);
    fireEvent.click(await screen.findByRole("button", { name: "Bring every film home" }));

    // One film failing must not strand the other: after the removal there is
    // no second attempt, so the rescue saves everything it can.
    await waitFor(() => expect(mocks.videomakerBringHome).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/1 brought home/)).toBeInTheDocument();
    expect(screen.getByText(/the master has expired/)).toBeInTheDocument();
  });

  it("surfaces a run that stopped and resumes it from the last saved phase", async () => {
    mocks.videomakerListProjects.mockResolvedValue({ projects: [project({ slug: "paused" })] });
    mocks.videomakerProjectStatus.mockResolvedValue({
      daemon: "idle",
      queue: { queued: 0, running: 0, blocked_quota: 0, done: 4, failed: 0 },
      cost: { spent_diem: 18, pending_diem: 0, projected_diem: 18, ceiling_diem: 300 },
    });
    mocks.videomakerListRuns.mockResolvedValue({
      runs: [{ id: "run-9", status: "paused_gate", detail: "gate en attente: storyboard" }],
    });
    mocks.videomakerStartRun.mockResolvedValue({ run: { id: "run-10", status: "running" } });
    render(<FilmStudio />);
    expect(await screen.findByText("Paused for your approval")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume production" }));
    await waitFor(() =>
      expect(mocks.videomakerStartRun).toHaveBeenCalledWith({
        slug: "paused",
        brief: "",
        maxCostDiem: 300,
        budgetDiem: 300,
        produce: true,
      }),
    );
  });

  it("asks for a cost decision when the run stopped on the production quote", async () => {
    mocks.videomakerListProjects.mockResolvedValue({ projects: [project({ slug: "quoted" })] });
    mocks.videomakerListRuns.mockResolvedValue({
      runs: [
        {
          id: "run-3",
          status: "awaiting_confirmation",
          detail: JSON.stringify({
            projected_cost_diem: 512,
            max_cost_diem: 300,
            message: "devis production au-dessus du plafond",
          }),
        },
      ],
    });
    mocks.videomakerProduce.mockResolvedValue({
      needs_confirmation: true,
      projected_cost_diem: 512,
    });
    render(<FilmStudio />);
    expect(await screen.findByText("Waiting for your go-ahead on the cost")).toBeInTheDocument();
    // A cost stop is a decision, not a resume.
    expect(screen.queryByRole("button", { name: "Resume production" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review the production cost" }));
    await waitFor(() => expect(mocks.videomakerProduce).toHaveBeenCalledWith("quoted", undefined));
    expect(
      await screen.findByRole("button", { name: "Confirm and produce (512 DIEM)" }),
    ).toBeInTheDocument();
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
    // The studio wraps its refusals in `detail`; a payload that still carries
    // that envelope must not read as "nothing to confirm".
    expect(
      parseProduceOutcome({ detail: { needs_confirmation: true, projected_cost_diem: 88 } }),
    ).toEqual({ started: false, needsConfirmation: true, projectedCostDiem: 88 });
  });

  it("parses runs and says what each stopped state means", () => {
    const runs = parseRuns({
      runs: [{ id: "r2", status: "running", detail: "phase: storyboard" }, { not: "a run" }],
    });
    expect(runs).toHaveLength(1);
    expect(filmRunSummary(runs[0]).headline).toBe("The crew is working");
    expect(filmRunSummary(runs[0]).hint).toBe("Phase: storyboard");
    expect(isRunStalled(runs[0])).toBe(false);

    const [exhausted] = parseRuns({
      runs: [
        {
          id: "r3",
          status: "awaiting_confirmation",
          detail: JSON.stringify({
            reason: "run_budget_exhausted",
            budget_diem: 120,
            spent_diem: 120.4,
          }),
        },
      ],
    });
    expect(exhausted.outcome.reason).toBe("run_budget_exhausted");
    const summary = filmRunSummary(exhausted);
    expect(summary.headline).toBe("Run budget spent");
    expect(summary.hint).toContain("120 DIEM");
    expect(isRunStalled(exhausted)).toBe(true);

    const [failed] = parseRuns({
      runs: [{ id: "r4", status: "failed", detail: "aucun progres apres 5 etapes" }],
    });
    expect(filmRunSummary(failed)).toEqual({
      headline: "The run stopped early",
      hint: "aucun progres apres 5 etapes",
    });
  });

  it("parses the studio's review of the finished cut", () => {
    const status = parseStatus({
      film_qa: {
        ok: true,
        narrative_clarity: 7,
        pacing: 5,
        visual_identity: 8,
        emotional_payoff: 6,
        ai_tell_score: 4,
        weakest_shots: ["s01_sh03", ""],
        notes: "The middle act drags.",
      },
      shots_to_review: [{ shot_id: "s02_sh01" }],
    });
    expect(status.review).toMatchObject({
      pacing: 5,
      aiTellScore: 4,
      weakestShots: ["s01_sh03"],
      notes: "The middle act drags.",
    });
    expect(status.shotsToReview).toEqual(["s02_sh01"]);
    // A judge that could not see the film reports no scores, never fake ones.
    expect(parseStatus({ film_qa: { ok: false, skipped: true } }).review).toBeUndefined();
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
