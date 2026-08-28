import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_MANDATE } from "../lib/council";
import type { CouncilCycle, SeatDraft, SittingPlan } from "../lib/council";

const councilPlan = vi.fn<() => Promise<SittingPlan>>();
const councilConvene = vi.fn<() => Promise<CouncilCycle>>();
const councilCycle = vi.fn<() => Promise<CouncilCycle | null>>();
const councilDrafts = vi.fn<() => Promise<SeatDraft[]>>();
const councilUpdateMandate = vi.fn<() => Promise<CouncilCycle>>();
const councilBindSession = vi.fn<() => Promise<CouncilCycle>>();
const councilAnswerQuestions = vi.fn<() => Promise<CouncilCycle>>();
const councilForget = vi.fn<() => Promise<void>>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("../lib/carpe-diem-text-pricing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/carpe-diem-text-pricing")>()),
  textPricing: () => Promise.resolve([{ model: "glm", inputUsdPerMtok: 2, outputUsdPerMtok: 8 }]),
}));

vi.mock("../lib/council", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/council")>();
  return {
    ...actual,
    councilPlan: (...args: unknown[]) => councilPlan(...(args as [])),
    councilConvene: (...args: unknown[]) => councilConvene(...(args as [])),
    councilCycle: (...args: unknown[]) => councilCycle(...(args as [])),
    councilDrafts: (...args: unknown[]) => councilDrafts(...(args as [])),
    councilUpdateMandate: (...args: unknown[]) => councilUpdateMandate(...(args as [])),
    councilBindSession: (...args: unknown[]) => councilBindSession(...(args as [])),
    councilAnswerQuestions: (...args: unknown[]) => councilAnswerQuestions(...(args as [])),
    councilForget: (...args: unknown[]) => councilForget(...(args as [])),
  };
});

const { CouncilSitting } = await import("../components/agent/council/CouncilSitting");

function plan(overrides: Partial<SittingPlan> = {}): SittingPlan {
  return {
    councilId: "mandate",
    seats: [
      {
        id: "shape",
        name: "Shape",
        role: "position",
        charge: "What is being asked for.",
        model: "glm",
        modelFamily: "glm",
      },
      {
        id: "objection",
        name: "Objection",
        role: "objection",
        charge: "Attacks the mandate.",
        model: "kimi",
        modelFamily: "kimi",
      },
    ],
    minModelCalls: 3,
    maxModelCalls: 6,
    reusedFamilies: [],
    situation: "Working folder: /tmp/app",
    calls: [
      {
        phase: "blind",
        seatId: "shape",
        model: "glm",
        promptTokens: 1_000_000,
        completionTokens: 0,
        certain: true,
      },
    ],
    ...overrides,
  };
}

function cycle(overrides: Partial<CouncilCycle> = {}): CouncilCycle {
  return {
    id: "m1",
    councilId: "mandate",
    request: "make the settings page faster",
    status: "ready",
    seats: plan().seats,
    questions: [],
    dissent: [],
    cuts: [],
    round: 0,
    modelCalls: 5,
    promptVersion: "council-v1",
    createdAt: "",
    updatedAt: "2026-08-28T00:00:00.000Z",
    mandate: {
      objective: "Cut settings load below 300ms",
      deliverable: [],
      constraints: [],
      acceptance: [{ statement: "It paints under 300ms", verifiedBy: "performance.now()" }],
      outOfScope: [],
      firstStep: "",
    },
    renderedPrompt: "THE RENDERED MANDATE",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  councilPlan.mockResolvedValue(plan());
  councilDrafts.mockResolvedValue([]);
  councilForget.mockResolvedValue(undefined);
});

function renderSitting(props: Partial<Parameters<typeof CouncilSitting>[0]> = {}) {
  return render(
    <CouncilSitting
      request="make the settings page faster"
      mandateId={null}
      onConvened={vi.fn()}
      onHandOff={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  );
}

describe("before anything is spent", () => {
  it("shows who would sit, on which weights, and what it would cost", async () => {
    renderSitting();
    expect(await screen.findByText("Shape")).toBeInTheDocument();
    expect(screen.getByText("kimi")).toBeInTheDocument();
    expect(screen.getByText("3 to 6")).toBeInTheDocument();
    // 1M prompt tokens at $2/Mtok, once.
    expect(screen.getByText("$2.00")).toBeInTheDocument();
  });

  it("spends nothing on the way in", async () => {
    renderSitting();
    await screen.findByText("Shape");
    expect(councilConvene).not.toHaveBeenCalled();
  });

  it("convenes on the tap, and not before", async () => {
    const onConvened = vi.fn();
    councilConvene.mockResolvedValue(cycle({ status: "deliberating" }));
    renderSitting({ onConvened });
    await userEvent.click(await screen.findByRole("button", { name: "Convene" }));
    await waitFor(() => expect(onConvened).toHaveBeenCalledWith("m1"));
  });

  it("says so when the catalog could not give every seat its own weights", async () => {
    councilPlan.mockResolvedValue(plan({ reusedFamilies: ["glm"] }));
    renderSitting();
    expect(await screen.findByText("Two seats are sharing weights")).toBeInTheDocument();
  });
});

describe("once a mandate is issued", () => {
  it("hands the rendered mandate over and binds the session to the cycle", async () => {
    councilCycle.mockResolvedValue(cycle());
    councilBindSession.mockResolvedValue(cycle({ status: "executing" }));
    const onHandOff = vi.fn().mockResolvedValue("sess-9");
    const onClose = vi.fn();
    renderSitting({ mandateId: "m1", onHandOff, onClose });

    await userEvent.click(await screen.findByRole("button", { name: "Hand to the agent" }));
    await waitFor(() => expect(onHandOff).toHaveBeenCalledWith("THE RENDERED MANDATE"));
    await waitFor(() =>
      expect(councilBindSession).toHaveBeenCalledWith(
        expect.objectContaining({ mandateId: "m1", sessionId: "sess-9" }),
      ),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("refuses to hand over a mandate nothing could judge", async () => {
    const unjudgeable = cycle();
    councilCycle.mockResolvedValue(
      cycle({ mandate: { ...(unjudgeable.mandate ?? EMPTY_MANDATE), acceptance: [] } }),
    );
    const onHandOff = vi.fn();
    renderSitting({ mandateId: "m1", onHandOff });

    expect(await screen.findByRole("button", { name: "Hand to the agent" })).toBeDisabled();
    expect(screen.getByText(/nothing could judge it/)).toBeInTheDocument();
    expect(onHandOff).not.toHaveBeenCalled();
  });

  it("shows where the seats disagreed and what the caps cut", async () => {
    councilCycle.mockResolvedValue(
      cycle({
        dissent: ["Risk wanted a stricter budget, Shape won"],
        cuts: ["Two criteria were dropped"],
      }),
    );
    renderSitting({ mandateId: "m1" });
    expect(await screen.findByText("Where they disagreed")).toBeInTheDocument();
    expect(screen.getByText("What was cut to fit")).toBeInTheDocument();
  });
});

describe("questions", () => {
  it("puts back only the answers to questions the council actually asked", async () => {
    councilCycle.mockResolvedValue(
      cycle({
        status: "questions",
        questions: [{ id: "q1", question: "Which page?", raisedBy: 2, answer: null }],
      }),
    );
    councilAnswerQuestions.mockResolvedValue(cycle({ status: "deliberating" }));
    renderSitting({ mandateId: "m1" });

    await userEvent.type(await screen.findByLabelText("Which page?"), "Settings");
    await userEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() =>
      expect(councilAnswerQuestions).toHaveBeenCalledWith("m1", [
        expect.objectContaining({ id: "q1", answer: "Settings" }),
      ]),
    );
  });

  it("lets the user decline without answering", async () => {
    councilCycle.mockResolvedValue(
      cycle({
        status: "questions",
        questions: [{ id: "q1", question: "Which page?", raisedBy: 2, answer: null }],
      }),
    );
    councilAnswerQuestions.mockResolvedValue(cycle({ status: "deliberating" }));
    renderSitting({ mandateId: "m1" });

    await userEvent.click(await screen.findByRole("button", { name: "Skip, decide for me" }));
    await waitFor(() =>
      expect(councilAnswerQuestions).toHaveBeenCalledWith("m1", [
        expect.objectContaining({ id: "q1", answer: null }),
      ]),
    );
  });
});

describe("the baseline", () => {
  it("offers what each model said alone, and hides the failed seats", async () => {
    councilCycle.mockResolvedValue(cycle());
    councilDrafts.mockResolvedValue([
      {
        seatId: "shape",
        model: "glm",
        phase: "blind",
        failed: false,
        mandate: {
          objective: "One model, alone",
          deliverable: [],
          constraints: [],
          acceptance: [],
          outOfScope: [],
          firstStep: "",
        },
        openQuestions: [],
        whatWouldChangeMyMind: "",
        createdAt: "t1",
      },
      {
        seatId: "risk",
        model: "kimi",
        phase: "blind",
        failed: true,
        openQuestions: [],
        whatWouldChangeMyMind: "",
        createdAt: "t2",
      },
    ]);
    renderSitting({ mandateId: "m1" });

    await userEvent.click(
      await screen.findByRole("button", { name: /what each model said alone/ }),
    );
    expect(screen.getByText("One model, alone")).toBeInTheDocument();
  });
});

describe("dismissing", () => {
  it("deletes the row, because that is the cancel", async () => {
    councilCycle.mockResolvedValue(cycle());
    const onClose = vi.fn();
    renderSitting({ mandateId: "m1", onClose });

    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(councilForget).toHaveBeenCalledWith("m1"));
    expect(onClose).toHaveBeenCalled();
  });

  it("has nothing to delete when nothing was convened", async () => {
    const onClose = vi.fn();
    renderSitting({ onClose });
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(councilForget).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
