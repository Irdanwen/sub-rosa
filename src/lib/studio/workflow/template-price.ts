// What a template is expected to cost before anyone uses it: the same
// estimate the canvas shows before a run, its lists counted at their most
// (ADR-0117), so a card never promises less than a run would spend.

import { t } from "../../i18n";
import { formatCredits } from "../catalog";
import type { MediaCatalog } from "../types";
import { estimateWorkflowCost, type WorkflowCostEstimate } from "./cost";
import { expandLists } from "./lists";
import type { Workflow } from "./schema";

export function templateEstimate(
  workflow: Workflow,
  catalog: MediaCatalog,
): WorkflowCostEstimate | undefined {
  if (catalog.models.length === 0) return undefined;
  return estimateWorkflowCost(expandLists(workflow), catalog);
}

/** Whether a run spends nothing at all. */
export function isFree(estimate: WorkflowCostEstimate): boolean {
  return estimate.nodes.every((node) => node.kind === "free");
}

/** The price as the end of a card's sentence ("1 image, ~4 credits"). */
export function templatePriceLabel(estimate: WorkflowCostEstimate): string {
  if (isFree(estimate)) return t("free");
  const credits = formatCredits(estimate.credits);
  if (estimate.credits > 0 && estimate.metered > 0) return t("~{credits} + usage", { credits });
  if (estimate.credits > 0) return `~${credits}`;
  return t("priced by use");
}
