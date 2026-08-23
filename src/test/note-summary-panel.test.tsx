import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteSummaryDto, NoteSummaryPlan } from "../lib/tauri";

const listeners: Array<(event: { payload: NoteSummaryDto }) => void> = [];

/** Deliver one summary row to everything listening, the way the Rust side
 * emits it. */
function emitSummary(payload: NoteSummaryDto) {
  for (const handler of listeners) {
    handler({ payload });
  }
}

const mocks = vi.hoisted(() => ({
  noteSummary: vi.fn(),
  noteSummaryPlan: vi.fn(),
  summarizeNoteLongform: vi.fn(),
  forgetNoteSummary: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_event: string, handler: (event: { payload: NoteSummaryDto }) => void) => {
    listeners.push(handler);
    return Promise.resolve(() => {});
  },
}));

vi.mock("../lib/tauri", () => ({
  NOTE_SUMMARY_EVENT: "june://note-summary",
  noteSummary: (...args: unknown[]) => mocks.noteSummary(...args),
  noteSummaryPlan: (...args: unknown[]) => mocks.noteSummaryPlan(...args),
  summarizeNoteLongform: (...args: unknown[]) => mocks.summarizeNoteLongform(...args),
  forgetNoteSummary: (...args: unknown[]) => mocks.forgetNoteSummary(...args),
}));

import { NoteSummaryPanel } from "../components/note-editor/NoteSummaryPanel";

function summary(overrides: Partial<NoteSummaryDto> = {}): NoteSummaryDto {
  return {
    noteId: "note-1",
    status: "ready",
    shortSummary: "A talk about pricing.",
    detailedSummary: "## [01:05] The pricing question\nThey argued about tiers.",
    transcriptChars: 90_000,
    chunkCount: 4,
    chunksDone: 4,
    model: "test-model",
    promptVersion: "longform-v1",
    lastError: null,
    createdAt: "2026-08-23T09:00:00Z",
    updatedAt: "2026-08-23T09:10:00Z",
    ...overrides,
  };
}

function plan(overrides: Partial<NoteSummaryPlan> = {}): NoteSummaryPlan {
  return {
    noteId: "note-1",
    transcriptChars: 90_000,
    chunkCount: 4,
    modelCalls: 7,
    summarizable: true,
    reason: null,
    ...overrides,
  };
}

beforeEach(() => {
  listeners.length = 0;
  mocks.noteSummary.mockReset().mockResolvedValue(null);
  mocks.noteSummaryPlan.mockReset().mockResolvedValue(plan());
  mocks.summarizeNoteLongform.mockReset();
  mocks.forgetNoteSummary.mockReset().mockResolvedValue(undefined);
});

describe("NoteSummaryPanel", () => {
  it("states what a run will cost before anything is spent", async () => {
    render(<NoteSummaryPanel noteId="note-1" />);

    // The user is paying per call, so the count is on the button's own card.
    expect(await screen.findByText(/7 model calls/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /summarize/i })).toBeTruthy();
    expect(mocks.summarizeNoteLongform).not.toHaveBeenCalled();
  });

  it("never starts a run on its own", async () => {
    render(<NoteSummaryPanel noteId="note-1" />);
    await screen.findByRole("button", { name: /summarize/i });

    expect(mocks.summarizeNoteLongform).not.toHaveBeenCalled();
  });

  it("says why when a recording is too short to be worth reading", async () => {
    mocks.noteSummaryPlan.mockResolvedValue(
      plan({ summarizable: false, reason: "This recording is too short." }),
    );

    render(<NoteSummaryPanel noteId="note-1" />);

    expect(await screen.findByText("This recording is too short.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /summarize/i })).toBeNull();
  });

  it("follows a run through the event, without polling", async () => {
    mocks.summarizeNoteLongform.mockResolvedValue(
      summary({ status: "running", chunksDone: 0, shortSummary: null, detailedSummary: null }),
    );
    render(<NoteSummaryPanel noteId="note-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /summarize/i }));

    expect(await screen.findByText(/Reading part 1 of 4/)).toBeTruthy();

    // A provisional paragraph lands after the first pass, long before the end.
    emitSummary(
      summary({
        status: "running",
        chunksDone: 1,
        shortSummary: "Early read: a talk about pricing.",
        detailedSummary: null,
      }),
    );
    expect(await screen.findByText("Early read: a talk about pricing.")).toBeTruthy();

    emitSummary(summary());
    await waitFor(() => expect(screen.getByText(/The pricing question/)).toBeTruthy());
    // Only one fetch on mount: the run reports itself.
    expect(mocks.noteSummary).toHaveBeenCalledTimes(1);
  });

  it("offers a way to stop a run, because the user is paying for it", async () => {
    mocks.summarizeNoteLongform.mockResolvedValue(
      summary({ status: "running", chunksDone: 0, shortSummary: null, detailedSummary: null }),
    );
    render(<NoteSummaryPanel noteId="note-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /summarize/i }));

    await userEvent.click(await screen.findByRole("button", { name: /^stop$/i }));

    // Dropping the row is the cancel: the run notices at the next boundary.
    expect(mocks.forgetNoteSummary).toHaveBeenCalledWith("note-1");
  });

  it("says the merge is happening instead of freezing on the last part", async () => {
    mocks.noteSummary.mockResolvedValue(
      summary({ status: "running", chunksDone: 4, chunkCount: 4, detailedSummary: null }),
    );

    render(<NoteSummaryPanel noteId="note-1" />);

    expect(await screen.findByText("Putting it together")).toBeTruthy();
    expect(screen.queryByText(/Reading part/)).toBeNull();
  });

  it("offers the chapters the summary wrote, and jumps on a click", async () => {
    const jumps: number[] = [];
    mocks.noteSummary.mockResolvedValue(
      summary({
        detailedSummary: [
          "## [00:00] Opening",
          "Body.",
          "",
          "## [12:30] The pricing question",
          "Body.",
        ].join("\n"),
      }),
    );

    render(<NoteSummaryPanel noteId="note-1" onJumpToTime={(ms) => jumps.push(ms)} />);

    await userEvent.click(await screen.findByRole("button", { name: /The pricing question/ }));
    expect(jumps).toEqual([750_000]);
  });

  it("shows no chapter list for an untimed summary", async () => {
    // A transcript with no turn bounds yields untimed headings on purpose, and
    // an empty navigation strip would be worse than none.
    mocks.noteSummary.mockResolvedValue(
      summary({ detailedSummary: "## Opening\nBody.\n\n## Closing\nBody." }),
    );

    render(<NoteSummaryPanel noteId="note-1" />);

    await screen.findByText(/Opening/);
    expect(screen.queryByRole("navigation", { name: /chapters/i })).toBeNull();
  });

  it("ignores another note's progress", async () => {
    render(<NoteSummaryPanel noteId="note-1" />);
    await screen.findByRole("button", { name: /summarize/i });

    emitSummary(summary({ noteId: "note-2", shortSummary: "Someone else's talk." }));

    await waitFor(() => expect(screen.queryByText("Someone else's talk.")).toBeNull());
  });

  it("asks before deleting a summary", async () => {
    mocks.noteSummary.mockResolvedValue(summary());
    render(<NoteSummaryPanel noteId="note-1" />);

    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    expect(screen.getByText("Delete this summary?")).toBeTruthy();
    expect(mocks.forgetNoteSummary).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(mocks.forgetNoteSummary).toHaveBeenCalledWith("note-1"));
  });

  it("shows the failure the run recorded rather than swallowing it", async () => {
    mocks.noteSummary.mockResolvedValue(
      summary({ status: "failed", lastError: "The model returned status 502.", chunksDone: 2 }),
    );

    render(<NoteSummaryPanel noteId="note-1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("The model returned status 502.");
    // A failure still offers the way back in.
    expect(screen.getByRole("button", { name: /summarize/i })).toBeTruthy();
  });
});
