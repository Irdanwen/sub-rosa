// The check every paid node passes just before it spends: the figure it was
// priced at fits the ceiling the run accepted, and the account still holds it.
//
// Two callers, two strictnesses. A film production (ADR-0030) refuses a node
// it cannot price, because its ceiling is a promise. The canvas lets a
// usage-priced node through (a chat step has no figure before it answers),
// but only while the account holds more than the run has already reserved,
// so a workflow whose credits ran out stops at the next step instead of
// waiting out ten minutes of payment refusals on each one.

import { t } from "../../i18n";
import { carpeDiemGetCredits } from "../../tauri";
import { nodeCostMap, type WorkflowCostEstimate } from "./cost";
import type { WorkflowNode } from "./schema";

export interface SpendGuardOptions {
  /** The most the run may reserve, in credits. Absent means no ceiling. */
  ceiling?: number;
  /** What to do with a paid node that has no figure. */
  unpriced: "refuse" | "allow";
}

/** Reserve against one opening balance snapshot before parallel jobs start.
 * Fresh balance checks catch spending outside this run, without subtracting
 * already charged reservations from the current balance a second time. */
export function spendGuard(estimate: WorkflowCostEstimate, options: SpendGuardOptions) {
  const costs = nodeCostMap(estimate);
  const { ceiling } = options;
  let reserved = 0;
  let openingBalance: ReturnType<typeof carpeDiemGetCredits> | undefined;
  return async (node: WorkflowNode) => {
    const item = estimate.nodes.find((entry) => entry.nodeId === node.id);
    if (item?.kind === "free") return;
    const priced = costs[node.id];
    const known = priced !== undefined && Number.isFinite(priced) && priced >= 0;
    if (!known && options.unpriced === "refuse")
      throw new Error(t("Price unavailable. Choose another model or try quoting again."));
    const cost = known ? priced : 0;
    if (
      ceiling !== undefined &&
      (!Number.isFinite(ceiling) || ceiling < 0 || reserved + cost > ceiling)
    )
      throw new Error(t("This generation exceeds the spend ceiling."));
    reserved += cost;
    const allocation = reserved;
    openingBalance ??= carpeDiemGetCredits();
    try {
      const initial = await openingBalance;
      const current = await carpeDiemGetCredits();
      // An unpriced step cannot be measured against a figure, only against
      // what is left: the account must still hold more than the run has
      // already set aside.
      const enough = known
        ? Number.isFinite(initial.availableCredits) &&
          initial.availableCredits >= allocation &&
          Number.isFinite(current.availableCredits) &&
          current.availableCredits >= cost
        : Number.isFinite(current.availableCredits) && current.availableCredits > allocation;
      if (!enough) throw new Error(t("You do not have enough credits for this generation."));
    } catch (error) {
      reserved -= cost;
      throw error;
    }
  };
}
