import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatUsd } from "./carpe-diem-billing";
import {
  estimateCostUsd,
  priceFor,
  type TextPrice,
  textPricing,
  type WebPrice,
  webPricing,
} from "./carpe-diem-text-pricing";

/**
 * Deep research (ADR-0089), for both shells: the commands of
 * `src-tauri/src/research/` and the arithmetic the screens show.
 *
 * The run lives in Rust as rows the background sweep re-drives, so nothing
 * here waits on it: a screen reads a run, and reads it again when the
 * `june://research` event names it.
 */

export type ResearchDepth = "quick" | "standard" | "deep";

export type ResearchPlanSection = { title: string; queries: string[] };
export type ResearchPlan = { title: string; sections: ResearchPlanSection[] };

export type ResearchEstimate = {
  depth: ResearchDepth;
  searches: number;
  pageReads: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
};

export type ResearchSource = {
  position: number;
  kind: "web" | "note" | "project_file" | "connector";
  title: string;
  url?: string | null;
  noteId?: string | null;
  status: "pending" | "read" | "skipped" | "failed";
};

export type ResearchStatus = "clarifying" | "planned" | "running" | "done" | "stopped" | "failed";

export type ResearchRun = {
  id: string;
  question: string;
  depth: ResearchDepth;
  status: ResearchStatus;
  phase?: "searching" | "reading" | "writing" | null;
  useNotes: boolean;
  projectId?: string | null;
  chatId?: string | null;
  clarifyQuestions: string[];
  clarifyAnswers: string[];
  plan?: ResearchPlan | null;
  model: string;
  reportNoteId?: string | null;
  citedSources: number;
  inventedCitations: number;
  error?: string | null;
  stepsDone: number;
  stepsTotal: number;
  maxSources: number;
  sourcesFound: number;
  sourcesRead: number;
  estimate?: ResearchEstimate | null;
  /** The same ceiling at every depth, for the depth picker. */
  depthEstimates?: ResearchEstimate[];
  sources: ResearchSource[];
  live: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DocumentFormat = "markdown" | "pdf" | "docx";

export const RESEARCH_EVENT = "june://research";

/** What each depth reads at most, and the searches its plan may hold
 * (`Depth` in research/mod.rs). */
export const RESEARCH_DEPTHS: Record<ResearchDepth, { sources: number; searches: number }> = {
  quick: { sources: 10, searches: 4 },
  standard: { sources: 25, searches: 8 },
  deep: { sources: 50, searches: 14 },
};

export function startResearch(request: {
  question: string;
  depth: ResearchDepth;
  useNotes: boolean;
  chatId?: string | null;
  /** Connectors the run may search (ADR-0092). */
  connectors?: string[];
}): Promise<ResearchRun> {
  return invoke<ResearchRun>("research_start", {
    request: { ...request, chatId: request.chatId || undefined },
  });
}

export function planResearch(id: string, answers: string[]): Promise<ResearchRun> {
  return invoke<ResearchRun>("research_plan", { request: { id, answers } });
}

export function approveResearch(
  id: string,
  plan: ResearchPlan,
  depth: ResearchDepth,
): Promise<ResearchRun> {
  return invoke<ResearchRun>("research_approve", { request: { id, plan, depth } });
}

export function stopResearch(id: string): Promise<ResearchRun> {
  return invoke<ResearchRun>("research_stop", { request: { id } });
}

export function resumeResearch(id: string, finishNow = false): Promise<ResearchRun> {
  return invoke<ResearchRun>("research_resume", { request: { id, finishNow } });
}

export function getResearch(id: string): Promise<ResearchRun> {
  return invoke<ResearchRun>("research_get", { request: { id } });
}

export function listResearch(): Promise<ResearchRun[]> {
  return invoke<ResearchRun[]>("research_list");
}

export function deleteResearch(id: string): Promise<void> {
  return invoke<void>("research_delete", { request: { id } });
}

export function exportNoteDocument(
  noteId: string,
  format: DocumentFormat,
): Promise<{ path?: string | null; bytes: number; shared: boolean }> {
  return invoke("note_export_document", { request: { noteId, format } });
}

/** Calls `onChange` with the run's id whenever a run changes. */
export function onResearchChanged(onChange: (id: string) => void): () => void {
  let stop: (() => void) | null = null;
  let closed = false;
  void listen<{ id: string }>(RESEARCH_EVENT, (event) => onChange(event.payload.id))
    .then((unlisten) => {
      if (closed) unlisten();
      else stop = unlisten;
    })
    .catch(() => {
      // Outside the app shell: the screen still works by its own reads.
    });
  return () => {
    closed = true;
    stop?.();
  };
}

/** The searches a plan holds. */
export function planSearches(plan: ResearchPlan): number {
  return plan.sections.reduce(
    (total, section) => total + section.queries.filter((query) => query.trim()).length,
    0,
  );
}

/** The plan with no more searches than `depth` allows, in order. */
export function clampPlanSearches(plan: ResearchPlan, depth: ResearchDepth): ResearchPlan {
  let budget = RESEARCH_DEPTHS[depth].searches;
  return {
    ...plan,
    sections: plan.sections.map((section) => {
      const queries = section.queries.slice(0, Math.max(0, budget));
      budget -= queries.length;
      return { ...section, queries };
    }),
  };
}

/** The prices a ceiling is computed from: the model's per-token rates and
 * the operator's per-call prices for the two web routes the engine uses. */
export type ResearchPrices = { model?: TextPrice; web: WebPrice };

export async function researchPrices(model: string): Promise<ResearchPrices> {
  const [table, web] = await Promise.all([textPricing(), webPricing()]);
  return { model: priceFor(model, table), web };
}

/** What a run costs at most, in USD, by what it pays for. A part whose price
 * is not known is undefined, and so is the total: a ceiling that leaves out
 * part of the bill is not one. */
export type ResearchCeiling = {
  modelUsd?: number;
  searchesUsd?: number;
  readsUsd?: number;
  totalUsd?: number;
};

export function researchCeiling(
  estimate: ResearchEstimate,
  prices: ResearchPrices,
): ResearchCeiling {
  const modelUsd = estimateCostUsd(
    { promptTokens: estimate.promptTokens, completionTokens: estimate.completionTokens },
    prices.model,
  );
  const searchesUsd =
    prices.web.searchUsd === undefined ? undefined : estimate.searches * prices.web.searchUsd;
  const readsUsd =
    prices.web.readUsd === undefined ? undefined : estimate.pageReads * prices.web.readUsd;
  const totalUsd =
    modelUsd === undefined || searchesUsd === undefined || readsUsd === undefined
      ? undefined
      : modelUsd + searchesUsd + readsUsd;
  return { modelUsd, searchesUsd, readsUsd, totalUsd };
}

/** The ceiling of `depth` for a plan of `searches` searches, from the run's
 * per-depth estimates (the plan is edited on screen, so its searches are
 * counted here, capped at what the depth runs). */
export function estimateForDepth(
  run: Pick<ResearchRun, "depthEstimates" | "estimate">,
  depth: ResearchDepth,
  searches: number,
): ResearchEstimate | undefined {
  const found =
    run.depthEstimates?.find((estimate) => estimate.depth === depth) ??
    (run.estimate?.depth === depth ? run.estimate : undefined);
  if (!found) return undefined;
  return { ...found, searches: Math.min(searches, RESEARCH_DEPTHS[depth].searches) };
}

/** A price as the screen shows it: never below a cent, so a part that costs
 * something never reads as free. */
export function formatCeilingUsd(usd: number): string {
  return formatUsd(Math.max(usd, 0.01));
}

/** Runs still at work, for the badge that brings a closed panel back. */
export function isActive(run: ResearchRun): boolean {
  return run.status === "running";
}
