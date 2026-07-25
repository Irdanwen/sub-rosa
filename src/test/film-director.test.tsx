import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  videomakerGates: vi.fn(),
  videomakerBoard: vi.fn(),
  videomakerTranscript: vi.fn(),
  videomakerChat: vi.fn(),
  videomakerGateApprove: vi.fn(),
  videomakerGateReject: vi.fn(),
  videomakerProduce: vi.fn(),
  videomakerShotTakes: vi.fn(),
  videomakerTakeSelect: vi.fn(),
  videomakerShotRetake: vi.fn(),
  videomakerShotRequeue: vi.fn(),
  videomakerShotSkip: vi.fn(),
  videomakerUploadRef: vi.fn(),
  videomakerImproveBrief: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({ ...mocks }));

// readFilmRef reads a File and downscales it through a canvas/Image pipeline
// jsdom can't drive; the component's staging behavior is what this suite
// exercises, so stub it with a deterministic staged ref (refs.ts has its own
// unit test for the read/downscale path).
const refsMocks = vi.hoisted(() => ({ readFilmRef: vi.fn() }));
vi.mock("../lib/films/refs", () => ({ readFilmRef: refsMocks.readFilmRef }));

import { FilmDirectorPanel } from "../components/studio/FilmDirectorPanel";
import {
  filmCrewLabel,
  parseBoard,
  parseCrewEvent,
  parseGates,
  parseStatus,
  parseTakes,
  parseTranscript,
} from "../lib/films";

const project = {
  slug: "slug-a",
  title: "Neon alley duel",
  state: "bible",
  finalMp4: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.videomakerGates.mockResolvedValue({
    gates: [
      { phase: "concept", status: "approved", open: true },
      { phase: "bible", status: null, open: false },
    ],
  });
  mocks.videomakerBoard.mockResolvedValue({ scenes: [], totals: {} });
  mocks.videomakerTranscript.mockResolvedValue({ messages: [] });
});

describe("FilmDirectorPanel", () => {
  it("shows the gate rollup and approves a pending gate", async () => {
    mocks.videomakerGateApprove.mockResolvedValue({ ok: true });
    render(<FilmDirectorPanel project={project} />);
    const approve = await screen.findByRole("button", { name: "Approve" });
    fireEvent.click(approve);
    await waitFor(() =>
      expect(mocks.videomakerGateApprove).toHaveBeenCalledWith({
        slug: "slug-a",
        phase: "bible",
        decisionReason: undefined,
      }),
    );
  });

  it("asks for a reason before rejecting a gate", async () => {
    mocks.videomakerGateReject.mockResolvedValue({ ok: true });
    render(<FilmDirectorPanel project={project} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    fireEvent.change(screen.getByLabelText("Rejection reason"), {
      target: { value: "Wrong tone" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm rejection" }));
    await waitFor(() =>
      expect(mocks.videomakerGateReject).toHaveBeenCalledWith({
        slug: "slug-a",
        phase: "bible",
        decisionReason: "Wrong tone",
      }),
    );
  });

  it("sends a chat turn and appends the studio reply", async () => {
    mocks.videomakerChat.mockResolvedValue({ type: "done", reply: "Bible drafted." });
    render(<FilmDirectorPanel project={project} />);
    const composer = await screen.findByLabelText("Message the studio crew");
    fireEvent.change(composer, { target: { value: "Write the production bible" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(mocks.videomakerChat).toHaveBeenCalledWith("slug-a", "Write the production bible"),
    );
    expect(await screen.findByText("Bible drafted.")).toBeInTheDocument();
  });

  it("develops an empty-transcript draft as a brief and applies it on accept", async () => {
    mocks.videomakerImproveBrief.mockResolvedValue("Logline: sharpened.");
    render(<FilmDirectorPanel project={project} />);
    const composer = await screen.findByLabelText("Message the studio crew");
    fireEvent.change(composer, { target: { value: "two rivals, an alley" } });
    fireEvent.click(screen.getByRole("button", { name: "Improve with AI" }));
    expect(await screen.findByText("Logline: sharpened.")).toBeInTheDocument();
    // First message of a fresh project = the brief; the draft waits for accept.
    expect(mocks.videomakerImproveBrief).toHaveBeenCalledWith({
      brief: "two rivals, an alley",
      title: "Neon alley duel",
      mode: "brief",
    });
    expect(composer).toHaveValue("two rivals, an alley");
    fireEvent.click(screen.getByRole("button", { name: "Use this message" }));
    expect(composer).toHaveValue("Logline: sharpened.");
  });

  it("sharpens a mid-project note in direction mode", async () => {
    mocks.videomakerTranscript.mockResolvedValue({
      messages: [{ role: "assistant", content: "Bible drafted." }],
    });
    mocks.videomakerImproveBrief.mockResolvedValue("Scene 2: colder light.");
    render(<FilmDirectorPanel project={project} />);
    const composer = await screen.findByLabelText("Message the studio crew");
    fireEvent.change(composer, { target: { value: "make it colder" } });
    fireEvent.click(screen.getByRole("button", { name: "Improve with AI" }));
    await waitFor(() =>
      expect(mocks.videomakerImproveBrief).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "direction" }),
      ),
    );
  });

  it("stages an attachment with a role and hands the signed URL to the draft", async () => {
    refsMocks.readFilmRef.mockResolvedValue({
      id: "r1",
      role: "character",
      label: "",
      fileName: "nera.png",
      base64Data: "AQID",
      previewDataUri: "data:image/png;base64,AQID",
    });
    mocks.videomakerUploadRef.mockResolvedValue({
      relative_path: "slug-a/assets/uploads/x.png",
      public_url: "https://studio/assets/x.png?sig=1",
      bytes: 3,
    });
    render(<FilmDirectorPanel project={project} />);
    await screen.findByLabelText("Message the studio crew");
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const file = new File([new Uint8Array([1, 2, 3])], "nera.png", { type: "image/png" });
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    const nameInput = await screen.findByLabelText("Reference name");
    fireEvent.change(nameInput, { target: { value: "Nera" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to message" }));
    await waitFor(() =>
      expect(mocks.videomakerUploadRef).toHaveBeenCalledWith(
        expect.objectContaining({ slug: "slug-a", fileName: "nera.png", base64Data: "AQID" }),
      ),
    );
    expect(screen.getByLabelText("Message the studio crew")).toHaveValue(
      'Reference image (character "Nera"): https://studio/assets/x.png?sig=1',
    );
  });

  it("runs the produce handshake: quote first, then confirm", async () => {
    mocks.videomakerProduce.mockResolvedValueOnce({
      needs_confirmation: true,
      projected_cost_diem: 412.5,
    });
    mocks.videomakerProduce.mockResolvedValueOnce({ started: true });
    render(<FilmDirectorPanel project={project} />);
    fireEvent.click(await screen.findByRole("button", { name: "Get a production quote" }));
    await waitFor(() => expect(mocks.videomakerProduce).toHaveBeenCalledWith("slug-a", undefined));
    const confirm = await screen.findByRole("button", {
      name: "Confirm and produce (412.5 DIEM)",
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.videomakerProduce).toHaveBeenCalledWith("slug-a", 412.5));
  });

  it("turns the studio's review of the cut into retakes", async () => {
    mocks.videomakerShotRetake.mockResolvedValue({ ok: true });
    mocks.videomakerShotTakes.mockResolvedValue({ takes: [] });
    const status = parseStatus({
      film_qa: {
        ok: true,
        narrative_clarity: 7,
        pacing: 4,
        ai_tell_score: 6,
        weakest_shots: ["s01_sh03"],
        notes: "Scene 1 holds too long.",
      },
    });
    render(<FilmDirectorPanel project={project} status={status} />);
    expect(await screen.findByText(/Story 7\/10/)).toBeInTheDocument();
    expect(screen.getByText(/reads as AI 6\/10 \(lower is better\)/)).toBeInTheDocument();
    expect(screen.getByText("Scene 1 holds too long.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retake s01_sh03" }));
    await waitFor(() =>
      expect(mocks.videomakerShotRetake).toHaveBeenCalledWith("slug-a", "s01_sh03"),
    );
  });
});

describe("director payload parsing", () => {
  it("parses the gate rollup", () => {
    const gates = parseGates({
      gates: [
        { phase: "concept", status: "approved", open: true },
        { phase: "final", status: null, open: false, decision_reason: null },
        { not: "a gate" },
      ],
    });
    expect(gates).toHaveLength(2);
    expect(gates[0]).toMatchObject({ phase: "concept", open: true });
  });

  it("parses the transcript keeping only displayable turns", () => {
    const messages = parseTranscript({
      messages: [
        { role: "user", content: "Brief..." },
        { role: "assistant", content: "On it." },
        { role: "system", content: "hidden" },
        { role: "assistant", content: "" },
      ],
    });
    expect(messages).toHaveLength(2);
  });

  it("parses the shot board with nested scenes and shots", () => {
    const board = parseBoard({
      scenes: [
        {
          scene_id: "s1",
          title: "Alley",
          shots: [
            { shot_id: "s01_sh01", status: "done", takes: 2, clip_url: "https://x/clip.mp4" },
            { bad: true },
          ],
        },
      ],
      totals: { shots_done: 1, shots_total: 4, spent_diem: 25.2, eta_seconds: 120 },
      final_url: null,
    });
    expect(board.scenes).toHaveLength(1);
    expect(board.scenes[0].shots).toHaveLength(1);
    expect(board.scenes[0].shots[0]).toMatchObject({ shotId: "s01_sh01", takes: 2 });
    expect(board.totals).toMatchObject({ shotsDone: 1, shotsTotal: 4, etaSeconds: 120 });
  });

  it("reads the crew delegations of a streamed turn", () => {
    const started = parseCrewEvent({
      type: "agent",
      phase: "start",
      role: "asset_builder",
      task_id: 12,
      goal: "Build the character boards",
    });
    expect(started).toMatchObject({
      role: "asset_builder",
      label: "Art department",
      taskId: 12,
      done: false,
      failed: false,
    });
    const ended = parseCrewEvent({
      type: "agent",
      phase: "end",
      role: "asset_builder",
      task_id: 12,
      status: "ok",
      cost_diem: 1.25,
    });
    expect(ended).toMatchObject({ done: true, failed: false, costDiem: 1.25 });
    expect(
      parseCrewEvent({ type: "agent", phase: "end", role: "editor", status: "failed" }),
    ).toMatchObject({ failed: true });
    // Tool boundaries and ad-hoc departments.
    expect(parseCrewEvent({ type: "tool", tool: "save_bible", phase: "start" })).toBeNull();
    expect(filmCrewLabel("adhoc:matte_painter")).toBe("matte painter");
    expect(filmCrewLabel("some_new_role")).toBe("some new role");
  });

  it("parses takes and flags the current one", () => {
    const takes = parseTakes({
      takes: [
        { version: 1, url: "https://x/1.mp4", is_current: false },
        { version: 2, url: "https://x/2.mp4", is_current: true, duration_sec: 8.2 },
      ],
    });
    expect(takes).toHaveLength(2);
    expect(takes[1]).toMatchObject({ version: 2, isCurrent: true, durationSec: 8.2 });
  });
});
