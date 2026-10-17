// What happened to a block's steps, said on the steps the canvas shows
// (ADR-0116). The run, the prices, the step cache and the validator all
// speak of flat steps (`instance/inner`); the canvas shows one level of the
// written graph (the workflow, or the inside of one block step), so each of
// their answers is lifted onto the step it belongs to at that level: a plain
// step answers for itself, a block step for all of its steps.

import type { NodeCostEstimate } from "./cost";
import type { Flattened } from "./flatten";
import type { NodeRunResult } from "./run-types";
import type { ValidationIssue } from "./validator";

/** One level of the written graph, seen from the flat one. */
export interface StepView {
  /** The path of the block step the level is inside, `""` at the top, else
   * ending in `/`. */
  prefix: string;
  /** The flat steps of each step at this level. */
  groups: Map<string, string[]>;
  /** Each block step at this level → the flat step whose result it shows. */
  primary: Map<string, string>;
}

/** The step a flat step (or a block step's path) belongs to at this level,
 * or nothing when it is not inside it. */
export function visibleStep(view: Pick<StepView, "prefix">, flatId: string): string | undefined {
  if (!flatId.startsWith(view.prefix)) return undefined;
  // A list's items and a step's copies (`step#2`) belong to the step.
  return flatId.slice(view.prefix.length).split("/")[0].split("#")[0] || undefined;
}

/** The level inside the block steps `path` leads through (none: the top). */
export function viewAt(
  flat: Pick<Flattened, "workflow" | "primary">,
  path: readonly string[] = [],
): StepView {
  const prefix = path.length > 0 ? `${path.join("/")}/` : "";
  const groups = new Map<string, string[]>();
  for (const node of flat.workflow.nodes) {
    const step = visibleStep({ prefix }, node.id);
    if (step) groups.set(step, [...(groups.get(step) ?? []), node.id]);
  }
  const primary = new Map<string, string>();
  for (const [blockPath, shown] of flat.primary) {
    const step = visibleStep({ prefix }, blockPath);
    if (step && `${prefix}${step}` === blockPath) primary.set(step, shown);
  }
  return { prefix, groups, primary };
}

/** Where a copy or an item sits in its list (`step#2` → 2). */
function copyIndex(id: string): number {
  const index = Number(id.slice(id.lastIndexOf("#") + 1));
  return Number.isFinite(index) ? index : 0;
}

/** Whether a step at this level is a plain one, answering for itself. */
function plain(view: StepView, step: string, ids: string[]): boolean {
  return ids.length === 1 && ids[0] === `${view.prefix}${step}`;
}

/** Results as the level shows them: a plain step's own; a block step running
 * while any of its steps runs, failed when one failed, held when one waits
 * for approval, done when all are, and showing what its first output made. */
export function liftResults(
  results: ReadonlyMap<string, NodeRunResult>,
  view: StepView,
): Map<string, NodeRunResult> {
  const lifted = new Map<string, NodeRunResult>();
  for (const [step, ids] of view.groups) {
    if (plain(view, step, ids)) {
      const own = results.get(ids[0]);
      if (own) lifted.set(step, { ...own, nodeId: step });
      continue;
    }
    const own = ids.map((id) => results.get(id)).filter((entry) => entry !== undefined);
    if (own.length === 0) continue;
    const failed = own.find((entry) => entry.status === "error");
    const status: NodeRunResult["status"] = failed
      ? "error"
      : own.some((entry) => entry.status === "running")
        ? "running"
        : own.some((entry) => entry.status === "awaiting")
          ? "awaiting"
          : own.length === ids.length && own.every((entry) => entry.status === "done")
            ? "done"
            : "pending";
    const shown = results.get(view.primary.get(step) ?? "");
    const running = own.filter((entry) => entry.status === "running");
    // A list's items, or a step's copies, in order: what each made.
    const copies = ids
      .filter((id) => id.startsWith(`${view.prefix}${step}#`))
      .sort((a, b) => copyIndex(a) - copyIndex(b))
      .flatMap((id) => {
        const output = results.get(id)?.output;
        return output ? [output] : [];
      });
    lifted.set(step, {
      nodeId: step,
      status,
      ...(shown?.output ? { output: shown.output } : {}),
      ...(copies.length > 0 ? { items: copies } : {}),
      ...(failed?.error ? { error: failed.error } : {}),
      // How far along: the share of its steps done, the running one's own
      // progress counted in.
      ...(status === "running"
        ? {
            progress:
              (own.filter((entry) => entry.status === "done").length +
                running.reduce((sum, entry) => sum + (entry.progress ?? 0), 0)) /
              ids.length,
          }
        : {}),
      ...(own.every((entry) => entry.reused || entry.status !== "done") &&
      own.some((entry) => entry.reused)
        ? { reused: true }
        : {}),
    });
  }
  return lifted;
}

/** Each step's price at this level: a block step's is the sum of what its
 * steps cost, by usage when any of them is, reused when every paid one is. */
export function liftPrices(
  nodes: readonly NodeCostEstimate[],
  view: StepView,
): Map<string, NodeCostEstimate> {
  const byId = new Map(nodes.map((entry) => [entry.nodeId, entry]));
  const lifted = new Map<string, NodeCostEstimate>();
  for (const [step, ids] of view.groups) {
    if (plain(view, step, ids)) {
      const own = byId.get(ids[0]);
      if (own) lifted.set(step, { ...own, nodeId: step });
      continue;
    }
    const own = ids.map((id) => byId.get(id)).filter((entry) => entry !== undefined);
    const paid = own.filter((entry) => entry.kind !== "free");
    const metered = paid.some((entry) => entry.kind === "metered");
    const credits = paid.reduce((sum, entry) => sum + (entry.credits ?? 0), 0);
    lifted.set(step, {
      nodeId: step,
      type: "block",
      label: "",
      kind: paid.length === 0 ? "free" : metered ? "metered" : "flat",
      ...(paid.length > 0 && !metered ? { credits: Math.round(credits * 100) / 100 } : {}),
      quotable: paid.some((entry) => entry.quotable),
      ...(paid.length > 0 && paid.every((entry) => entry.reused) ? { reused: true } : {}),
    });
  }
  return lifted;
}

/** The steps at this level the next run reuses: a plain step the cache
 * answers, a block step all of whose paid steps it answers. */
export function liftReused(
  reused: ReadonlySet<string>,
  view: StepView,
  paid: ReadonlySet<string>,
): Set<string> {
  const lifted = new Set<string>();
  for (const [step, ids] of view.groups) {
    const own = plain(view, step, ids) ? ids : ids.filter((id) => paid.has(id));
    if (own.length > 0 && own.every((id) => reused.has(id))) lifted.add(step);
  }
  return lifted;
}

/** Problems on the step they concern at this level; one outside it keeps
 * its message and loses its place. */
export function liftIssues(issues: readonly ValidationIssue[], view: StepView): ValidationIssue[] {
  return issues.map((issue) => {
    if (!issue.nodeId) return issue;
    const step = visibleStep(view, issue.nodeId);
    const { nodeId: _flat, ...rest } = issue;
    return step ? { ...rest, nodeId: step } : rest;
  });
}

/** The flat steps a run of these steps (at this level) runs. */
export function flatTargets(ids: readonly string[], view: StepView): string[] {
  const wanted = new Set(ids);
  const targets: string[] = [];
  for (const [step, flat] of view.groups) if (wanted.has(step)) targets.push(...flat);
  return targets;
}
