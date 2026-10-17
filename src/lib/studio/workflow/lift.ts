// What happened to a block's steps, said on the block step (ADR-0116): the
// run, the prices, the step cache and the validator all speak of flat steps
// (`instance/inner`); the canvas shows the written graph, so each of their
// answers is lifted onto the block step its flat steps came from.

import type { NodeCostEstimate } from "./cost";
import type { Flattened } from "./flatten";
import type { NodeRunResult } from "./run-types";
import type { ValidationIssue } from "./validator";

/** The flat steps of each block step. */
function stepsOf(flat: Pick<Flattened, "display">): Map<string, string[]> {
  const steps = new Map<string, string[]>();
  for (const [flatId, owner] of flat.display)
    steps.set(owner, [...(steps.get(owner) ?? []), flatId]);
  return steps;
}

/** Results with each block step's own: running while any step runs, failed
 * when one failed, held when one waits for approval, done when all are, and
 * showing what its first output made. */
export function liftResults(
  results: ReadonlyMap<string, NodeRunResult>,
  flat: Pick<Flattened, "display" | "primary">,
): Map<string, NodeRunResult> {
  if (flat.display.size === 0) return results as Map<string, NodeRunResult>;
  const lifted = new Map(results);
  for (const [owner, steps] of stepsOf(flat)) {
    const own = steps.map((id) => results.get(id)).filter((entry) => entry !== undefined);
    if (own.length === 0) continue;
    const failed = own.find((entry) => entry.status === "error");
    const status: NodeRunResult["status"] = failed
      ? "error"
      : own.some((entry) => entry.status === "running")
        ? "running"
        : own.some((entry) => entry.status === "awaiting")
          ? "awaiting"
          : own.length === steps.length && own.every((entry) => entry.status === "done")
            ? "done"
            : "pending";
    const shown = results.get(flat.primary.get(owner) ?? "");
    const running = own.filter((entry) => entry.status === "running");
    lifted.set(owner, {
      nodeId: owner,
      status,
      ...(shown?.output ? { output: shown.output } : {}),
      ...(failed?.error ? { error: failed.error } : {}),
      // How far along: the share of its steps done, the running one's own
      // progress counted in.
      ...(status === "running"
        ? {
            progress:
              (own.filter((entry) => entry.status === "done").length +
                running.reduce((sum, entry) => sum + (entry.progress ?? 0), 0)) /
              steps.length,
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

/** Each block step's price: the sum of what its steps cost, by usage when
 * any of them is, reused when every paid one is. */
export function liftPrices(
  nodes: readonly NodeCostEstimate[],
  flat: Pick<Flattened, "display">,
): Map<string, NodeCostEstimate> {
  const byId = new Map(nodes.map((entry) => [entry.nodeId, entry]));
  for (const [owner, steps] of stepsOf(flat)) {
    const own = steps.map((id) => byId.get(id)).filter((entry) => entry !== undefined);
    const paid = own.filter((entry) => entry.kind !== "free");
    const metered = paid.some((entry) => entry.kind === "metered");
    const credits = paid.reduce((sum, entry) => sum + (entry.credits ?? 0), 0);
    byId.set(owner, {
      nodeId: owner,
      type: "block",
      label: "",
      kind: paid.length === 0 ? "free" : metered ? "metered" : "flat",
      ...(paid.length > 0 && !metered ? { credits: Math.round(credits * 100) / 100 } : {}),
      quotable: paid.some((entry) => entry.quotable),
      ...(paid.length > 0 && paid.every((entry) => entry.reused) ? { reused: true } : {}),
    });
  }
  return byId;
}

/** The steps the next run reuses, with each block step all of whose paid
 * steps it reuses. */
export function liftReused(
  reused: ReadonlySet<string>,
  flat: Pick<Flattened, "display">,
  paid: ReadonlySet<string>,
): Set<string> {
  const lifted = new Set(reused);
  for (const [owner, steps] of stepsOf(flat)) {
    const own = steps.filter((id) => paid.has(id));
    if (own.length > 0 && own.every((id) => reused.has(id))) lifted.add(owner);
  }
  return lifted;
}

/** Problems on the step they concern: a block's steps' on the block. */
export function liftIssues(
  issues: readonly ValidationIssue[],
  flat: Pick<Flattened, "display">,
): ValidationIssue[] {
  if (flat.display.size === 0) return [...issues];
  return issues.map((issue) => {
    const owner = issue.nodeId ? flat.display.get(issue.nodeId) : undefined;
    return owner ? { ...issue, nodeId: owner } : issue;
  });
}

/** The flat steps a run of these steps runs: a block step's own. */
export function flatTargets(ids: readonly string[], flat: Pick<Flattened, "display">): string[] {
  const targets = new Set(ids);
  for (const [flatId, owner] of flat.display) if (targets.has(owner)) targets.add(flatId);
  return [...targets];
}
