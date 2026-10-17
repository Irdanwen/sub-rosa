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

import { liveSwitchBranches } from "./switches";
import { estimatedSpeechSeconds } from "../speech";
import { estimateCostCredits } from "../catalog";
import { mediaJson } from "../client";
import { supportsVideoQuote, VIDEO_QUOTE_PATH } from "../paths";
import type { MediaCatalog, MediaModel } from "../types";
import {
  fedParams,
  isPaidNode,
  maybeNodeSchema,
  nodeLabel,
  type Workflow,
  type WorkflowNode,
  type WorkflowNodeType,
} from "./schema";

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
  /** Answered from the step cache: free, and not quoted (ADR-0115). */
  reused?: boolean;
}

export interface WorkflowCostEstimate {
  nodes: NodeCostEstimate[];
  /** Sum of the known figures, in credits. The total is "at least" this. */
  credits: number;
  /** Paying nodes with no figure (usage-priced chat, unpriced models). */
  metered: number;
  /** Nodes whose figure a run-time quote could refine. */
  quotable: number;
  /** The two sides of each switch decided during the run: only one is
   * made, so the total counts the dearer one (switches.ts). */
  alternatives?: Array<{ a: string[]; b: string[] }>;
}

/** The figures of a bill: the sum of what is known, the dearer side of each
 * live switch only. */
function totals(
  nodes: NodeCostEstimate[],
  alternatives: WorkflowCostEstimate["alternatives"],
): Pick<WorkflowCostEstimate, "credits" | "metered" | "quotable"> {
  const known = (estimate: NodeCostEstimate) =>
    estimate.kind === "flat" && estimate.credits !== undefined ? estimate.credits : 0;
  let credits = 0;
  let metered = 0;
  let quotable = 0;
  for (const estimate of nodes) {
    credits += known(estimate);
    if (estimate.kind === "metered") metered += 1;
    if (estimate.quotable) quotable += 1;
  }
  const byId = new Map(nodes.map((estimate) => [estimate.nodeId, estimate]));
  for (const { a, b } of alternatives ?? []) {
    const side = (ids: string[]) =>
      ids.reduce(
        (sum, id) => sum + (byId.has(id) ? known(byId.get(id) as NodeCostEstimate) : 0),
        0,
      );
    credits -= Math.min(side(a), side(b));
  }
  return { credits: Math.round(credits * 100) / 100, metered, quotable };
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

/** What a step costs. A closed choice it takes from a connection is
 * priced at its dearest value: the connection may bring any of them. */
export function estimateNodeCost(node: WorkflowNode, catalog: MediaCatalog): NodeCostEstimate {
  const schema = maybeNodeSchema(node.type);
  const choices = fedParams(node.params).flatMap((name) => {
    const param = schema?.params.find((entry) => entry.name === name);
    return param?.type === "enum" && param.enumValues?.length
      ? [{ name, values: param.enumValues }]
      : [];
  });
  if (choices.length === 0) return estimateOwnCost(node, catalog);
  let variants: Array<Record<string, unknown>> = [node.params];
  for (const { name, values } of choices) {
    variants = variants.flatMap((params) => values.map((value) => ({ ...params, [name]: value })));
    if (variants.length > 64) break;
  }
  const estimates = variants.map((params) => estimateOwnCost({ ...node, params }, catalog));
  const metered = estimates.find((estimate) => estimate.kind === "metered");
  if (metered) return metered;
  return estimates.reduce((dearest, estimate) =>
    (estimate.credits ?? 0) > (dearest.credits ?? 0) ? estimate : dearest,
  );
}

function estimateOwnCost(node: WorkflowNode, catalog: MediaCatalog): NodeCostEstimate {
  const schema = maybeNodeSchema(node.type);
  // The node's own name ("First shot"), so two video nodes stay tellable
  // apart in a cost breakdown; the schema label is the fallback.
  const label = nodeLabel(node);
  const base = { nodeId: node.id, type: node.type, label, quotable: false };

  switch (node.type) {
    // Local or pass-through work: reads, frame decodes, approvals, the
    // in-webview export.
    case "textInput":
    case "asset":
    case "document":
    case "lastFrame":
    case "relay":
    case "note":
    case "block":
    case "assemble":
    case "output":
    case "soundMix":
    case "compare":
    case "textTemplate":
    case "preview":
    case "switch":
    case "textList":
    case "splitText":
    case "imageList":
    case "listItem":
      return { ...base, kind: "free" };

    // Usage-priced per token; no per-run figure to show. An upscale and a
    // cutout are billed by the provider with no price the catalog states.
    case "chat":
    case "upscale":
    case "cutout":
      return { ...base, kind: "metered" };

    // An approval is free; a judge reading the candidates first is a chat
    // call like any other.
    case "gate":
      return isPaidNode(node) ? { ...base, kind: "metered" } : { ...base, kind: "free" };

    // One edit each: a zone retouch sends one crop, a sheet draws nine
    // variations in one image.
    case "image":
    case "imageEdit":
    case "zoneEdit":
    case "sheet":
      return flat(base, modelOf(catalog, node.params)?.costCredits);

    // Speech is billed by what it reads (per character, or per second of
    // what it says): priced when the node holds its own text, metered when
    // the text arrives from upstream at run time.
    case "tts": {
      const model = modelOf(catalog, node.params);
      const text = typeof node.params.text === "string" ? node.params.text.trim() : "";
      if (!model || !text) return { ...base, kind: "metered" };
      return flat(
        base,
        estimateCostCredits(model, {
          characters: text.length,
          durationSeconds: estimatedSpeechSeconds(text.length),
          multiplier: catalog.priceMultiplier,
        }),
      );
    }

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
  workflow: Pick<Workflow, "nodes"> & Partial<Pick<Workflow, "edges">>,
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
  const alternatives = workflow.edges
    ? liveSwitchBranches({ nodes: workflow.nodes, edges: workflow.edges }).map((branch) => ({
        a: [...branch.a],
        b: [...branch.b],
      }))
    : [];
  return {
    nodes,
    ...totals(nodes, alternatives),
    ...(alternatives.length > 0 ? { alternatives } : {}),
  };
}

/** The bill once the steps the cache will answer are taken out: each costs
 * nothing, asks for no quote, and says why. */
export function withReusedSteps(
  estimate: WorkflowCostEstimate,
  reused: ReadonlySet<string>,
): WorkflowCostEstimate {
  if (reused.size === 0) return estimate;
  const nodes = estimate.nodes.map((node) =>
    reused.has(node.nodeId) && node.kind !== "free"
      ? { ...node, kind: "flat" as const, credits: 0, quotable: false, reused: true }
      : node,
  );
  return { ...estimate, nodes, ...totals(nodes, estimate.alternatives) };
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

/** What `/video/quote` is asked for a node: its model and the settings that
 * price a render (duration, ratio, resolution, sound). */
export function quoteBody(node: WorkflowNode): Record<string, unknown> {
  const prompt = node.params.prompt;
  const body: Record<string, unknown> = {
    model: node.params.model,
    // The real prompt may come from an upstream node that has not run yet;
    // the quote prices duration and resolution, not words.
    prompt: typeof prompt === "string" && prompt.trim() !== "" ? prompt : nodeLabel(node),
  };
  for (const [param, field] of [
    ["duration", "duration"],
    ["aspectRatio", "aspect_ratio"],
    ["resolution", "resolution"],
  ] as const) {
    const value = node.params[param];
    if (typeof value === "string" && value !== "") body[field] = value;
  }
  // A silent render can price differently from one with sound; the compiler
  // only marks it silent on a model that has the switch.
  if (node.params.silent === true) body.audio = false;
  return body;
}

/** One node's quote in credits, or nothing when the quote is slow or fails
 * (the static estimate stays). `ask` is the client call: with retries at
 * run time, a single attempt while someone is editing. */
export async function quoteVideoNode(
  node: WorkflowNode,
  multiplier: number,
  ask: <T>(path: string, body?: unknown) => Promise<T>,
): Promise<number | undefined> {
  try {
    const response = await Promise.race([
      ask<{ quote?: number }>(VIDEO_QUOTE_PATH, quoteBody(node)),
      new Promise<undefined>((resolve) => {
        setTimeout(() => resolve(undefined), QUOTE_TIMEOUT_MS);
      }),
    ]);
    if (response && typeof response.quote === "number") {
      // The quote comes back in USD; credits are cents times the backend's
      // price multiplier (same conversion VideoStudio does).
      return Math.round(response.quote * 100 * multiplier * 100) / 100;
    }
  } catch {
    // Keep the static estimate.
  }
  return undefined;
}

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
        const credits = await quoteVideoNode(node, multiplier, mediaJson);
        if (credits !== undefined) quotes.set(node.id, credits);
      }),
  );
  return quotes;
}
