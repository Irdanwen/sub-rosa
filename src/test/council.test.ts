import { describe, expect, it } from "vitest";
import type { TextPrice } from "../lib/carpe-diem-text-pricing";
import {
  awaitsUser,
  baselineDrafts,
  estimateSittingCost,
  formatSittingCost,
  isSitting,
  mandateProblems,
  pendingSeats,
  type CouncilCycle,
  type CouncilSeat,
  type Mandate,
  type PlannedCall,
  type SeatDraft,
  type SittingPlan,
} from "../lib/council";

const PRICES: TextPrice[] = [
  { model: "glm", inputUsdPerMtok: 2, outputUsdPerMtok: 8 },
  { model: "kimi", inputUsdPerMtok: 1, outputUsdPerMtok: 4 },
];

function call(overrides: Partial<PlannedCall> = {}): PlannedCall {
  return {
    phase: "blind",
    seatId: "shape",
    model: "glm",
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
    certain: true,
    ...overrides,
  };
}

function plan(calls: PlannedCall[]): SittingPlan {
  return {
    councilId: "mandate",
    seats: [],
    minModelCalls: calls.filter((entry) => entry.certain).length,
    maxModelCalls: calls.length,
    reusedFamilies: [],
    reusedByChoice: false,
    calls,
  };
}

function seat(id: string, role: CouncilSeat["role"] = "position"): CouncilSeat {
  return { id, name: id, role, charge: "", model: "glm", modelFamily: "glm" };
}

function draft(seatId: string, phase: SeatDraft["phase"] = "blind", failed = false): SeatDraft {
  return {
    seatId,
    model: "glm",
    phase,
    failed,
    openQuestions: [],
    whatWouldChangeMyMind: "",
    createdAt: "",
  };
}

function cycle(overrides: Partial<CouncilCycle> = {}): CouncilCycle {
  return {
    id: "m1",
    councilId: "mandate",
    request: "make it faster",
    status: "deliberating",
    seats: [seat("shape"), seat("risk"), seat("objection", "objection")],
    questions: [],
    dissent: [],
    cuts: [],
    round: 0,
    modelCalls: 0,
    promptVersion: "council-v1",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

const SOUND_MANDATE: Mandate = {
  objective: "Cut settings load below 300ms",
  deliverable: ["AppSettings.tsx"],
  constraints: [],
  acceptance: [{ statement: "It paints in under 300ms", verifiedBy: "performance.now()" }],
  outOfScope: [],
  firstStep: "Measure it",
};

describe("estimateSittingCost", () => {
  it("prices each call on the model that call runs on", () => {
    // 1M prompt at $2 + 1M completion at $8 = $10 on glm, $5 on kimi.
    const cost = estimateSittingCost(plan([call(), call({ model: "kimi" })]), PRICES);
    expect(cost?.minUsd).toBeCloseTo(15, 5);
  });

  it("separates the council that agrees from the one that has to ask", () => {
    const cost = estimateSittingCost(
      plan([call(), call({ model: "kimi", certain: false })]),
      PRICES,
    );
    expect(cost?.minUsd).toBeCloseTo(10, 5);
    expect(cost?.maxUsd).toBeCloseTo(15, 5);
  });

  it("names the models it could not price rather than pricing them at zero", () => {
    const cost = estimateSittingCost(plan([call(), call({ model: "mystery" })]), PRICES);
    expect(cost?.minUsd).toBeCloseTo(10, 5);
    expect(cost?.unpricedModels).toEqual(["mystery"]);
  });

  it("returns nothing at all when nothing could be priced", () => {
    // An invented figure is worse than none: the surface knows how to show
    // "no estimate" and does not know how to un-show a wrong one.
    expect(estimateSittingCost(plan([call({ model: "mystery" })]), PRICES)).toBeUndefined();
    expect(estimateSittingCost(plan([call()]), [])).toBeUndefined();
  });
});

describe("formatSittingCost", () => {
  it("shows a range when the two ends differ", () => {
    const cost = estimateSittingCost(
      plan([call(), call({ model: "kimi", certain: false })]),
      PRICES,
    );
    expect(formatSittingCost(cost)).toBe("$10.00 to $15.00");
  });

  it("collapses to one figure when nothing optional is left", () => {
    expect(formatSittingCost(estimateSittingCost(plan([call()]), PRICES))).toBe("$10.00");
  });

  it("says at least when part of the sitting could not be priced", () => {
    const cost = estimateSittingCost(plan([call(), call({ model: "mystery" })]), PRICES);
    expect(formatSittingCost(cost)).toBe("at least $10.00");
  });

  it("does not print a figure that rounds to nothing", () => {
    const cheap = plan([call({ promptTokens: 100, completionTokens: 100 })]);
    expect(formatSittingCost(estimateSittingCost(cheap, PRICES))).toBe("under $0.01");
  });

  it("omits the line entirely when there is no estimate", () => {
    expect(formatSittingCost(undefined)).toBeUndefined();
  });
});

describe("mandateProblems", () => {
  it("passes a sound mandate", () => {
    expect(mandateProblems(SOUND_MANDATE)).toEqual([]);
  });

  it("refuses a mandate nothing could judge", () => {
    const problems = mandateProblems({ ...SOUND_MANDATE, acceptance: [] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("nothing could judge it");
  });

  it("refuses a criterion that names no way of being checked", () => {
    const problems = mandateProblems({
      ...SOUND_MANDATE,
      acceptance: [{ statement: "It works well", verifiedBy: "  " }],
    });
    expect(problems).toContain("An acceptance criterion names no way of being checked.");
  });

  it("treats a missing mandate as a problem rather than as fine", () => {
    expect(mandateProblems(null)).toHaveLength(1);
  });
});

describe("reading a cycle", () => {
  it("knows when the sitting is waiting on the user", () => {
    expect(awaitsUser(cycle({ status: "questions" }))).toBe(true);
    expect(awaitsUser(cycle({ status: "ready" }))).toBe(true);
    expect(awaitsUser(cycle({ status: "deliberating" }))).toBe(false);
  });

  it("knows when it is spending money", () => {
    expect(isSitting(cycle({ status: "deliberating" }))).toBe(true);
    expect(isSitting(cycle({ status: "reviewing" }))).toBe(true);
    expect(isSitting(cycle({ status: "executing" }))).toBe(false);
  });

  it("counts only the seats that hold a position as still to be heard", () => {
    // The objection seat never speaks in the blind round, so showing it as
    // "waiting" would report a sitting as unfinished forever.
    const drafts = [draft("shape")];
    expect(pendingSeats(cycle(), drafts).map((entry) => entry.id)).toEqual(["risk"]);
  });

  it("does not count a second turn as a seat having been heard for the first", () => {
    const drafts = [draft("shape"), draft("risk", "contradiction")];
    expect(pendingSeats(cycle(), drafts).map((entry) => entry.id)).toEqual(["risk"]);
  });

  it("keeps only the uncontaminated answers as the baseline", () => {
    const drafts = [draft("shape"), draft("risk", "blind", true), draft("shape", "contradiction")];
    // A failed seat has no opinion, and a second turn has already seen the
    // table — neither is a single-model baseline.
    expect(baselineDrafts(drafts).map((entry) => entry.seatId)).toEqual(["shape"]);
  });
});
