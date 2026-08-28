/**
 * The council: deliberation that issues a verifiable mandate (ADR-0034).
 *
 * The bindings and the arithmetic; the surfaces live in
 * `components/agent/council/`. Two things are worth knowing before reading
 * anything here:
 *
 * - **The mandate is fields, not a string.** The rendered prompt comes back
 *   from Rust and is never composed here. Editing a mandate means sending the
 *   fields back and letting `mandate::render` make the string again, which is
 *   what keeps "the app owns the prompt" true even when the user is the one
 *   who changed it.
 * - **Desktop only.** There is no Hermes on iOS, so there is nothing for a
 *   mandate to be handed to. Nothing in the mobile shell imports this.
 */

import { estimateCostUsd, priceFor, type TextPrice } from "./carpe-diem-text-pricing";
import { invoke } from "./tauri";

/** Emitted whenever a cycle changes: seats landing, questions asked, a mandate
 * issued. The surfaces follow a sitting through this rather than polling. */
export const COUNCIL_EVENT = "june://council";

export type CouncilSeatRole = "position" | "objection" | "conformance" | "collateral" | "letter";

export type CouncilSeat = {
  id: string;
  name: string;
  role: CouncilSeatRole;
  /** One line, shown to the user: what this seat is for. */
  charge: string;
  model: string;
  /** Two seats of one council never share this, unless the catalog offered
   * nothing else — in which case the plan says so through `reusedFamilies`. */
  modelFamily: string;
};

export type AcceptanceCriterion = {
  statement: string;
  /** How it is checked. A criterion without one is not a criterion, and the
   * Rust validator refuses the mandate rather than shipping it. */
  verifiedBy: string;
};

export type Mandate = {
  objective: string;
  deliverable: string[];
  constraints: string[];
  acceptance: AcceptanceCriterion[];
  outOfScope: string[];
  firstStep: string;
};

export type CouncilQuestion = {
  id: string;
  question: string;
  /** How many seats raised it independently. Never fewer than two: one seat
   * asking is that seat's idiosyncrasy, not an ambiguity in the request. */
  raisedBy: number;
  answer?: string | null;
};

export type CouncilCycleStatus =
  | "deliberating"
  | "questions"
  | "ready"
  | "executing"
  | "reviewing"
  | "settled"
  | "failed";

export type CouncilCycle = {
  id: string;
  councilId: string;
  request: string;
  status: CouncilCycleStatus;
  seats: CouncilSeat[];
  situation?: string | null;
  questions: CouncilQuestion[];
  mandate?: Mandate | null;
  dissent: string[];
  cuts: string[];
  renderedPrompt?: string | null;
  sessionId?: string | null;
  workingDir?: string | null;
  round: number;
  modelCalls: number;
  promptVersion: string;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CriterionStatus = "satisfied" | "unsatisfied" | "unverifiable";

export type CriterionVerdict = {
  statement: string;
  status: CriterionStatus;
  /** What settled it. An empty one never accompanies "satisfied": the Rust
   * reconciliation downgrades an unevidenced pass to unverifiable. */
  evidence: string;
  seat: string;
};

export type VerdictFinding = {
  /** collateral: changed without being asked. skipped: asked for and not done.
   * letter: satisfied in appearance only. */
  kind: "collateral" | "skipped" | "letter";
  summary: string;
  evidence: string;
  seat: string;
};

export type CouncilVerdict = {
  mandateId: string;
  round: number;
  status: "running" | "ready" | "failed";
  sessionId?: string | null;
  criteria: CriterionVerdict[];
  findings: VerdictFinding[];
  /** The chair's short reading. Never a score. */
  summary?: string | null;
  promptVersion: string;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Retake = {
  cycle: CouncilCycle;
  /** Sent as a follow-up turn in the same session, which already holds the
   * work. Rendered in Rust from the verdict, never paraphrased by a model. */
  prompt: string;
};

/** A cycle gets two corrections. When they run out the app states what remains
 * rather than looping. Mirrors `mandate::MAX_RETAKES`. */
export const MAX_RETAKES = 2;

export type PlannedCall = {
  phase: string;
  seatId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** False for the calls a sitting only makes if it has to ask the user
   * something or answer an objection. */
  certain: boolean;
};

export type SittingPlan = {
  councilId: string;
  seats: CouncilSeat[];
  minModelCalls: number;
  maxModelCalls: number;
  reusedFamilies: string[];
  situation?: string | null;
  calls: PlannedCall[];
};

/** One seat's draft, parsed. The blind-round drafts are the single-model
 * baseline the council is measured against, so they are shown, not hidden once
 * the mandate exists. */
export type SeatDraft = {
  seatId: string;
  model: string;
  phase: "blind" | "revision" | "contradiction";
  /** True for a seat that failed, and for one whose answer could not be read:
   * an unreadable draft is not an opinion. */
  failed: boolean;
  mandate?: Mandate | null;
  openQuestions: string[];
  whatWouldChangeMyMind: string;
  createdAt: string;
};

export const EMPTY_MANDATE: Mandate = {
  objective: "",
  deliverable: [],
  constraints: [],
  acceptance: [],
  outOfScope: [],
  firstStep: "",
};

// --- Bindings --------------------------------------------------------------

export async function councilPlan(input: {
  request: string;
  workingDir?: string;
  unrestricted?: boolean;
  councilId?: string;
}) {
  return invoke<SittingPlan>("council_plan", {
    councilId: input.councilId,
    request: input.request,
    workingDir: input.workingDir,
    unrestricted: input.unrestricted ?? false,
  });
}

export async function councilConvene(input: {
  request: string;
  workingDir?: string;
  unrestricted?: boolean;
}) {
  return invoke<CouncilCycle>("council_convene", {
    request: input.request,
    workingDir: input.workingDir,
    unrestricted: input.unrestricted ?? false,
  });
}

export async function councilCycle(mandateId: string) {
  return invoke<CouncilCycle | null>("council_cycle", { mandateId });
}

export async function councilCycles(limit?: number) {
  return invoke<CouncilCycle[]>("council_cycles", { limit });
}

/** Every seat's draft for one round, in the order the phases ran. */
export async function councilDrafts(mandateId: string, round?: number) {
  return invoke<SeatDraft[]>("council_drafts", { mandateId, round });
}

export async function councilCycleForSession(sessionId: string) {
  return invoke<CouncilCycle | null>("council_cycle_for_session", { sessionId });
}

export async function councilAnswerQuestions(mandateId: string, answers: CouncilQuestion[]) {
  return invoke<CouncilCycle>("council_answer_questions", { mandateId, answers });
}

/** Send the edited fields back. The prompt is re-rendered in Rust; this never
 * ships a string. */
export async function councilUpdateMandate(mandateId: string, mandate: Mandate) {
  return invoke<CouncilCycle>("council_update_mandate", { mandateId, mandate });
}

export async function councilBindSession(input: {
  mandateId: string;
  sessionId: string;
  workingDir?: string;
}) {
  return invoke<CouncilCycle>("council_bind_session", {
    mandateId: input.mandateId,
    sessionId: input.sessionId,
    workingDir: input.workingDir,
  });
}

/** Judge the finished work against the mandate that asked for it. */
export async function councilRequestVerdict(mandateId: string) {
  return invoke<CouncilVerdict>("council_request_verdict", { mandateId });
}

export async function councilVerdicts(mandateId: string) {
  return invoke<CouncilVerdict[]>("council_verdicts", { mandateId });
}

/** The cycle a session is executing, if the council is still waiting on it.
 * The status rule lives in Rust so no surface has to know it. */
export async function councilCycleAwaitingVerdict(sessionId: string) {
  return invoke<CouncilCycle | null>("council_cycle_awaiting_verdict", { sessionId });
}

/** Open a corrective pass. Costs no model call: the instructions are rendered
 * from the verdict. */
export async function councilRetake(mandateId: string) {
  return invoke<Retake>("council_retake", { mandateId });
}

/** Deleting the row is the cancel, and the only one. A sitting in flight
 * notices between movements and stands down. */
export async function councilForget(mandateId: string) {
  return invoke<void>("council_forget", { mandateId });
}

// --- Reading a cycle -------------------------------------------------------

/** The cycle is waiting on the user rather than on a model. */
export function awaitsUser(cycle: CouncilCycle): boolean {
  return cycle.status === "questions" || cycle.status === "ready";
}

/** A sitting is spending money right now. */
export function isSitting(cycle: CouncilCycle): boolean {
  return cycle.status === "deliberating" || cycle.status === "reviewing";
}

/** Seats the sitting is still waiting on, so the surface can fill in as they
 * land rather than jumping from nothing to everything.
 *
 * The objection seat is never counted: it does not speak in the blind round,
 * and counting it would report every sitting as unfinished. */
export function pendingSeats(cycle: CouncilCycle, drafts: SeatDraft[]): CouncilSeat[] {
  const spoken = new Set(
    drafts.filter((draft) => draft.phase === "blind").map((draft) => draft.seatId),
  );
  return cycle.seats.filter((seat) => seat.role === "position" && !spoken.has(seat.id));
}

/** The blind-round draft of each seat: what one model said, alone, before it
 * saw anybody else. Later phases are dropped, because the baseline is the
 * uncontaminated answer and nothing else. */
export function baselineDrafts(drafts: SeatDraft[]): SeatDraft[] {
  return drafts.filter((draft) => draft.phase === "blind" && !draft.failed);
}

/** Whether a mandate could be handed to an agent at all. Mirrors the Rust
 * validator; the Rust one is the authority and refuses on submit. */
export function mandateProblems(mandate: Mandate | null | undefined): string[] {
  if (!mandate) return ["There is no mandate yet."];
  const problems: string[] = [];
  if (!mandate.objective.trim()) problems.push("The mandate has no objective.");
  if (mandate.acceptance.length === 0) {
    problems.push("The mandate has no acceptance criterion, so nothing could judge it.");
  }
  if (mandate.acceptance.some((criterion) => !criterion.verifiedBy.trim())) {
    problems.push("An acceptance criterion names no way of being checked.");
  }
  return problems;
}

/** Whether a verdict found anything a correction should address. Mirrors
 * `verdict::needs_retake`: unverifiable is not satisfied, and treating it as
 * one is how a cycle closes over a hole. */
export function needsRetake(verdict: CouncilVerdict): boolean {
  return (
    verdict.criteria.some((criterion) => criterion.status !== "satisfied") ||
    verdict.findings.length > 0
  );
}

/** How many corrections this cycle has left. Zero means the app states what
 * remains rather than looping. */
export function retakesLeft(cycle: CouncilCycle): number {
  return Math.max(0, MAX_RETAKES - cycle.round);
}

/** One line naming what a verdict settled, for a heading. */
export function verdictTally(verdict: CouncilVerdict): {
  satisfied: number;
  total: number;
  unverifiable: number;
} {
  return {
    satisfied: verdict.criteria.filter((entry) => entry.status === "satisfied").length,
    unverifiable: verdict.criteria.filter((entry) => entry.status === "unverifiable").length,
    total: verdict.criteria.length,
  };
}

// --- What it costs ---------------------------------------------------------

export type SittingCost = {
  /** A council that agrees, on a request needing no clarification. */
  minUsd: number;
  /** One that asks, and then answers an objection. */
  maxUsd: number;
  /** Calls whose model is not in the price table. The figure is a floor when
   * this is non-empty, and the surface says so rather than rounding it away. */
  unpricedModels: string[];
};

/**
 * What a sitting would cost, priced per call on the model that call runs on.
 *
 * Deliberately a range and deliberately rough: the point of showing it before
 * anyone commits is cents against euros. Returns undefined when nothing could
 * be priced at all — an invented figure would be worse than none, and the
 * surface already knows how to show "no estimate".
 *
 * Prompt caching is not modelled, though the blind round sends three nearly
 * identical prompts and the operator may well serve part of them from cache.
 * That makes this an over-estimate rather than an under-estimate, which is the
 * direction a figure shown before a spend should err in.
 */
export function estimateSittingCost(
  plan: SittingPlan,
  prices: TextPrice[],
): SittingCost | undefined {
  let minUsd = 0;
  let maxUsd = 0;
  let priced = 0;
  const unpricedModels = new Set<string>();

  for (const call of plan.calls) {
    const usd = estimateCostUsd(
      { promptTokens: call.promptTokens, completionTokens: call.completionTokens },
      priceFor(call.model, prices),
    );
    if (usd === undefined) {
      unpricedModels.add(call.model);
      continue;
    }
    priced += 1;
    maxUsd += usd;
    if (call.certain) minUsd += usd;
  }

  if (priced === 0) return undefined;
  return { minUsd, maxUsd, unpricedModels: [...unpricedModels] };
}

/** The cost of a sitting, as a short line. `undefined` when nothing is
 * priceable, so the caller can omit the line rather than print a zero. */
export function formatSittingCost(cost: SittingCost | undefined): string | undefined {
  if (!cost) return undefined;
  const floor = cost.unpricedModels.length > 0 ? "at least " : "";
  if (cost.maxUsd - cost.minUsd < 0.005) {
    // One figure, and "under $0.01" rather than "$0.00", which reads as free.
    return `${floor}${cost.minUsd < 0.01 ? "under $0.01" : formatUsd(cost.minUsd)}`;
  }
  // A range never borrows the "under" wording: "under $0.01 to $0.15" parses
  // as nonsense on the way past.
  return `${floor}${formatUsd(cost.minUsd)} to ${formatUsd(cost.maxUsd)}`;
}

function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
