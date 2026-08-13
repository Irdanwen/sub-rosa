// Cost estimation for a workflow run: what each node would spend, in credits,
// before anything is queued. Estimates come from the same machinery the rest
// of the Studio prices with — flat per-generation prices from the catalog,
// music duration brackets, and (at run time, from the UI) `/video/quote` — so
// the figure on the Run button is the figure VideoStudio would have shown.
//
// Estimates are estimates: a node with no published price still spends
// ("metered"), and the total is therefore "at least". Nothing here blocks a
// run; the confirmation handshake in the UI is what stands between the figure
// and the spend.

import { estimateCostCredits } from "../catalog";
import { mediaJson } from "../client";
import { supportsVideoQuote, VIDEO_QUOTE_PATH } from "../paths";
import type { MediaCatalog, MediaModel } from "../types";
import { maybeNodeSchema, type Workflow, type WorkflowNode, type WorkflowNodeType } from "./schema";

/** How a node spends: not at all, a known figure, or usage-priced. */
export type NodeCostKind = "free" | "flat" | "metered";

export interface NodeCostEstimate {
  nodeId: string;
  type: WorkflowNodeType;
  label: string;
  kind: NodeCostKind;
  /** Known estimate in credits; defined exactly when `kind` is "flat". */
  credits?: number;
  /** True when `/video/quote` could refine this figure at run time. */
  quotable: boolean;
}

export interface WorkflowCostEstimate {
  nodes: NodeCostEstimate[];
  /** Sum of the known figures, in credits. The total is "at least" this. */
  credits: number;
  /** Paying nodes with no figure (usage-priced chat, unpriced models). */
  metered: number;
  /** Nodes whose figure a run-time quote could refine. */
  quotable: number;
}

/** Below this many credits a run starts without a confirmation handshake:
 * a lone flat-priced image should not cost a click, a production should. */
export const RUN_CONFIRM_THRESHOLD_CREDITS = 20;

function modelOf(catalog: MediaCatalog, params: Record<string, unknown>): MediaModel | undefined {
  const id = params.model;
  if (typeof id !== "string" || id === "") return undefined;
  return catalog.models.find((model) => model.id === id);
}

function flat(
  base: Omit<NodeCostEstimate, "kind" | "credits">,
  credits?: number,
): NodeCostEstimate {
  return credits !== undefined ? { ...base, kind: "flat", credits } : { ...base, kind: "metered" };
}

export function estimateNodeCost(node: WorkflowNode, catalog: MediaCatalog): NodeCostEstimate {
  const schema = maybeNodeSchema(node.type);
  // The node's own name ("First shot"), so two video nodes stay tellable
  // apart in a cost breakdown; the schema label is the fallback.
  const label = node.label.trim() || schema?.label || String(node.type);
  const base = { nodeId: node.id, type: node.type, label, quotable: false };

  switch (node.type) {
    // Local or pass-through work: reads, frame decodes, approvals, the
    // in-webview export.
    case "textInput":
    case "asset":
    case "document":
    case "lastFrame":
    case "gate":
    case "assemble":
    case "output":
      return { ...base, kind: "free" };

    // Usage-priced per token; no per-run figure to show.
    case "chat":
      return { ...base, kind: "metered" };

    case "image":
    case "imageEdit":
    case "tts":
      return flat(base, modelOf(catalog, node.params)?.costCredits);

    case "music": {
      const model = modelOf(catalog, node.params);
      if (!model) return { ...base, kind: "metered" };
      const durationSeconds =
        typeof node.params.durationSeconds === "number" ? node.params.durationSeconds : undefined;
      return flat(
        base,
        estimateCostCredits(model, { durationSeconds, multiplier: catalog.priceMultiplier }),
      );
    }

    case "video": {
      const model = modelOf(catalog, node.params);
      const quotable = model !== undefined && supportsVideoQuote(model.id);
      if (!model) return { ...base, kind: "metered" };
      return flat({ ...base, quotable }, estimateCostCredits(model));
    }

    default:
      return { ...base, kind: "metered" };
  }
}

/**
 * The whole graph's bill before running it. `overrides` carries figures the
 * UI refined (run-time quotes), keyed by node id; an override turns a metered
 * node into a known one.
 */
export function estimateWorkflowCost(
  workflow: Pick<Workflow, "nodes">,
  catalog: MediaCatalog,
  overrides?: Map<string, number>,
): WorkflowCostEstimate {
  const nodes = workflow.nodes.map((node) => {
    const estimate = estimateNodeCost(node, catalog);
    const override = overrides?.get(node.id);
    if (override !== undefined && estimate.kind !== "free") {
      return { ...estimate, kind: "flat" as const, credits: override };
    }
    return estimate;
  });
  let credits = 0;
  let metered = 0;
  let quotable = 0;
  for (const estimate of nodes) {
    if (estimate.kind === "flat" && estimate.credits !== undefined) credits += estimate.credits;
    if (estimate.kind === "metered") metered += 1;
    if (estimate.quotable) quotable += 1;
  }
  return { nodes, credits: Math.round(credits * 100) / 100, metered, quotable };
}

/** The known figures per node, for stamping onto what the run produces. */
export function nodeCostMap(estimate: WorkflowCostEstimate): Record<string, number> {
  const costs: Record<string, number> = {};
  for (const node of estimate.nodes) {
    if (node.kind === "flat" && node.credits !== undefined) costs[node.nodeId] = node.credits;
  }
  return costs;
}

/**
 * Whether a run should pass through the confirmation handshake first. Cheap,
 * fully-priced runs start unprompted; anything that reaches the threshold,
 * hides a usage-priced media node, or could be quoted more precisely at run
 * time gets its figure shown before the spend.
 */
export function needsRunConfirmation(estimate: WorkflowCostEstimate): boolean {
  if (estimate.credits >= RUN_CONFIRM_THRESHOLD_CREDITS) return true;
  if (estimate.quotable > 0) return true;
  // Metered chat is negligible; metered *media* is not. Count the media ones.
  return estimate.nodes.some((node) => node.kind === "metered" && node.type !== "chat");
}

export const QUOTE_TIMEOUT_MS = 4000;

/**
 * Refine quotable video nodes' figures through `/video/quote`, in credits.
 * Failures and slow answers just leave the static estimate in place — a
 * quote is a nicety, never a gate.
 */
export async function fetchVideoQuotes(
  workflow: Pick<Workflow, "nodes">,
  catalog: MediaCatalog,
): Promise<Map<string, number>> {
  const quotes = new Map<string, number>();
  const multiplier = catalog.priceMultiplier ?? 1;
  const quotable = new Set(
    estimateWorkflowCost(workflow, catalog)
      .nodes.filter((node) => node.quotable)
      .map((node) => node.nodeId),
  );
  await Promise.all(
    workflow.nodes
      .filter((node) => quotable.has(node.id))
      .map(async (node) => {
        const prompt = node.params.prompt;
        const body: Record<string, unknown> = {
          model: node.params.model,
          // The real prompt may come from an upstream node that has not run
          // yet; the quote prices duration and resolution, not words.
          prompt: typeof prompt === "string" && prompt.trim() !== "" ? prompt : node.label,
        };
        for (const [param, field] of [
          ["duration", "duration"],
          ["aspectRatio", "aspect_ratio"],
          ["resolution", "resolution"],
        ] as const) {
          const value = node.params[param];
          if (typeof value === "string" && value !== "") body[field] = value;
        }
        try {
          const response = await Promise.race([
            mediaJson<{ quote?: number }>(VIDEO_QUOTE_PATH, body),
            new Promise<undefined>((resolve) => {
              setTimeout(() => resolve(undefined), QUOTE_TIMEOUT_MS);
            }),
          ]);
          if (response && typeof response.quote === "number") {
            // The quote comes back in USD; credits are cents times the
            // backend's price multiplier (same conversion VideoStudio does).
            quotes.set(node.id, Math.round(response.quote * 100 * multiplier * 100) / 100);
          }
        } catch {
          // Keep the static estimate.
        }
      }),
  );
  return quotes;
}
