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
}));

vi.mock("../lib/tauri", () => ({ ...mocks }));

import { FilmDirectorPanel } from "../components/studio/FilmDirectorPanel";
import { parseBoard, parseGates, parseTakes, parseTranscript } from "../lib/films";

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
