import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RETAKES,
  needsRetake,
  retakesLeft,
  verdictTally,
  type CouncilCycle,
  type CouncilVerdict,
  type Retake,
} from "../lib/council";

const councilCycle = vi.fn<() => Promise<CouncilCycle | null>>();
const councilVerdicts = vi.fn<() => Promise<CouncilVerdict[]>>();
const councilRequestVerdict = vi.fn<() => Promise<CouncilVerdict>>();
const councilRetake = vi.fn<() => Promise<Retake>>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("../lib/council", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/council")>();
  return {
    ...actual,
    councilCycle: (...args: unknown[]) => councilCycle(...(args as [])),
    councilVerdicts: (...args: unknown[]) => councilVerdicts(...(args as [])),
    councilRequestVerdict: (...args: unknown[]) => councilRequestVerdict(...(args as [])),
    councilRetake: (...args: unknown[]) => councilRetake(...(args as [])),
  };
});

const { VerdictPanel } = await import("../components/agent/council/VerdictPanel");

function cycle(overrides: Partial<CouncilCycle> = {}): CouncilCycle {
  return {
    id: "m1",
    councilId: "mandate",
    request: "make the settings page faster",
    status: "executing",
    seats: [],
    questions: [],
    dissent: [],
    cuts: [],
    round: 0,
    modelCalls: 9,
    promptVersion: "council-v1",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function verdict(overrides: Partial<CouncilVerdict> = {}): CouncilVerdict {
  return {
    mandateId: "m1",
    round: 0,
    status: "ready",
    criteria: [
      {
        statement: "It paints under 300ms",
        status: "satisfied",
        evidence: "src/x.ts:12",
        seat: "conformance",
      },
    ],
    findings: [],
    summary: "The page is faster.",
    promptVersion: "council-v1",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

/** What the shell hands the panel as evidence for a folderless sitting. */
const readReply = vi.fn<(sessionId: string) => Promise<string | undefined>>();

beforeEach(() => {
  vi.clearAllMocks();
  readReply.mockResolvedValue(undefined);
  councilCycle.mockResolvedValue(cycle());
  councilVerdicts.mockResolvedValue([]);
});

function renderPanel(props: Partial<Parameters<typeof VerdictPanel>[0]> = {}) {
  return render(
    <VerdictPanel
      mandateId="m1"
      readReply={readReply}
      onRetake={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  );
}

describe("offering the reading", () => {
  it("offers rather than runs", async () => {
    renderPanel();
    expect(await screen.findByRole("button", { name: "Have it read" })).toBeInTheDocument();
    expect(councilRequestVerdict).not.toHaveBeenCalled();
  });

  it("hands over what the agent said, for work that left no files", async () => {
    // A mandate asking for an analysis, a rating or a rewritten text produces
    // prose and nothing on disk. Without this the verdict had nothing to read
    // and spent three model calls writing "unverifiable" once per criterion.
    councilCycle.mockResolvedValue(cycle({ sessionId: "sess-7" }));
    readReply.mockResolvedValue("Here is the revised screenplay, scene by scene.");
    councilRequestVerdict.mockResolvedValue(verdict({ status: "running" }));
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: "Have it read" }));
    await waitFor(() => expect(readReply).toHaveBeenCalledWith("sess-7"));
    await waitFor(() =>
      expect(councilRequestVerdict).toHaveBeenCalledWith(
        "m1",
        "Here is the revised screenplay, scene by scene.",
      ),
    );
  });

  it("asks anyway when the transcript cannot be read", async () => {
    // Reading it is best-effort: a sitting WITH a working folder does not need
    // it, and refusing to ask because the transcript hiccupped would withhold
    // a verdict that had real evidence waiting.
    councilCycle.mockResolvedValue(cycle({ sessionId: "sess-7" }));
    readReply.mockRejectedValue(new Error("gateway is down"));
    councilRequestVerdict.mockResolvedValue(verdict({ status: "running" }));
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: "Have it read" }));
    await waitFor(() => expect(councilRequestVerdict).toHaveBeenCalledWith("m1", undefined));
  });

  it("runs it on the tap", async () => {
    councilRequestVerdict.mockResolvedValue(verdict({ status: "running" }));
    renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: "Have it read" }));
    await waitFor(() => expect(councilRequestVerdict).toHaveBeenCalledWith("m1", undefined));
  });

  it("lets the user decline without spending anything", async () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(onClose).toHaveBeenCalled();
    expect(councilRequestVerdict).not.toHaveBeenCalled();
  });
});

describe("reading a verdict", () => {
  it("shows every criterion with the evidence that settled it", async () => {
    councilVerdicts.mockResolvedValue([verdict()]);
    renderPanel();
    expect(await screen.findByText("It paints under 300ms")).toBeInTheDocument();
    expect(screen.getByText("src/x.ts:12")).toBeInTheDocument();
    expect(screen.getByText("1 of 1 criteria hold")).toBeInTheDocument();
  });

  it("counts what could not be checked apart from what failed", async () => {
    councilVerdicts.mockResolvedValue([
      verdict({
        criteria: [
          {
            statement: "a",
            status: "satisfied",
            evidence: "x",
            seat: "conformance",
          },
          { statement: "b", status: "unverifiable", evidence: "", seat: "" },
        ],
      }),
    ]);
    renderPanel();
    expect(
      await screen.findByText("1 of 2 criteria hold, 1 could not be checked"),
    ).toBeInTheDocument();
  });

  it("names what no criterion covered", async () => {
    councilVerdicts.mockResolvedValue([
      verdict({
        findings: [
          {
            kind: "letter",
            summary: "[criterion 1] the test asserts nothing",
            evidence: "src/x.test.ts:3",
            seat: "letter",
          },
        ],
      }),
    ]);
    renderPanel();
    expect(await screen.findByText("Satisfied in appearance only")).toBeInTheDocument();
  });

  it("keeps each round, so a correction can be seen to have worked", async () => {
    councilVerdicts.mockResolvedValue([
      verdict({
        round: 0,
        criteria: [{ statement: "a", status: "unsatisfied", evidence: "x", seat: "" }],
      }),
      verdict({ round: 1 }),
    ]);
    renderPanel();
    expect(await screen.findByText(/First reading/)).toBeInTheDocument();
    expect(screen.getByText(/After correction 1/)).toBeInTheDocument();
  });
});

describe("corrections", () => {
  it("sends the rendered correction back into the same session", async () => {
    councilVerdicts.mockResolvedValue([
      verdict({ criteria: [{ statement: "a", status: "unsatisfied", evidence: "x", seat: "" }] }),
    ]);
    councilRetake.mockResolvedValue({
      cycle: { ...cycle({ round: 1 }), sessionId: "sess-9" },
      prompt: "FIX THESE",
    });
    const onRetake = vi.fn().mockResolvedValue(undefined);
    renderPanel({ onRetake });

    await userEvent.click(await screen.findByRole("button", { name: /Send it back/ }));
    // The session is addressed explicitly: by now the user may be looking at
    // another conversation, and a correction sent to the selection would land
    // in whichever one that is.
    await waitFor(() => expect(onRetake).toHaveBeenCalledWith("FIX THESE", "sess-9"));
  });

  it("remembers a declined offer for that round, so it is not asked again", async () => {
    const onClose = vi.fn();
    councilCycle.mockResolvedValue(cycle({ round: 1 }));
    renderPanel({ onClose });
    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(onClose).toHaveBeenCalledWith(1);
  });

  it("does not count a correction as a declined offer", async () => {
    councilVerdicts.mockResolvedValue([
      verdict({ criteria: [{ statement: "a", status: "unsatisfied", evidence: "x", seat: "" }] }),
    ]);
    councilRetake.mockResolvedValue({
      cycle: { ...cycle({ round: 1 }), sessionId: "sess-9" },
      prompt: "FIX THESE",
    });
    const onClose = vi.fn();
    renderPanel({ onClose, onRetake: vi.fn().mockResolvedValue(undefined) });
    await userEvent.click(await screen.findByRole("button", { name: /Send it back/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith());
  });

  it("stops after the corrections run out and says what remains", async () => {
    councilCycle.mockResolvedValue(cycle({ round: MAX_RETAKES }));
    councilVerdicts.mockResolvedValue([
      verdict({
        round: MAX_RETAKES,
        criteria: [{ statement: "a", status: "unsatisfied", evidence: "x", seat: "" }],
      }),
    ]);
    renderPanel();
    expect(await screen.findByText(/Both corrections have been used/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send it back/ })).not.toBeInTheDocument();
  });

  it("offers no correction when everything holds", async () => {
    councilVerdicts.mockResolvedValue([verdict()]);
    renderPanel();
    expect(await screen.findByText("Everything the mandate asked for holds.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send it back/ })).not.toBeInTheDocument();
  });
});

describe("the retake rules", () => {
  it("treats unverifiable as unsettled", () => {
    expect(
      needsRetake(
        verdict({ criteria: [{ statement: "a", status: "unverifiable", evidence: "", seat: "" }] }),
      ),
    ).toBe(true);
  });

  it("treats a finding as worth correcting even when every criterion holds", () => {
    expect(
      needsRetake(
        verdict({
          findings: [{ kind: "collateral", summary: "x", evidence: "y", seat: "collateral" }],
        }),
      ),
    ).toBe(true);
  });

  it("counts corrections down and never below zero", () => {
    expect(retakesLeft(cycle({ round: 0 }))).toBe(MAX_RETAKES);
    expect(retakesLeft(cycle({ round: MAX_RETAKES }))).toBe(0);
    expect(retakesLeft(cycle({ round: MAX_RETAKES + 5 }))).toBe(0);
  });

  it("tallies what holds apart from what could not be checked", () => {
    const tally = verdictTally(
      verdict({
        criteria: [
          { statement: "a", status: "satisfied", evidence: "x", seat: "" },
          { statement: "b", status: "unverifiable", evidence: "", seat: "" },
          { statement: "c", status: "unsatisfied", evidence: "z", seat: "" },
        ],
      }),
    );
    expect(tally).toEqual({ satisfied: 1, unverifiable: 1, total: 3 });
  });
});
