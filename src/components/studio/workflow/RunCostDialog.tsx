// The pre-spend handshake a run passes through before any paid node starts.

import { t } from "../../../lib/i18n";
import { formatCredits } from "../../../lib/studio/catalog";
import type { WorkflowCostEstimate } from "../../../lib/studio/workflow";
import { Dialog } from "../../ui/Dialog";

export function costSummary(estimate: WorkflowCostEstimate): string {
  if (estimate.credits > 0 && estimate.metered > 0) {
    return t("~{credits} + usage", { credits: formatCredits(estimate.credits) });
  }
  if (estimate.credits > 0) return `~${formatCredits(estimate.credits)}`;
  return t("Usage priced");
}

/** The pre-spend handshake: every paying node's figure, the total, and the
 * one button that actually starts the run. */
export function RunCostDialog({
  estimate,
  onConfirm,
  onClose,
}: {
  estimate: WorkflowCostEstimate;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const paying = estimate.nodes.filter((node) => node.kind !== "free");
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("Run this production?")}
      description={t("What one run of this workflow is expected to spend.")}
      width={440}
    >
      <div className="dialog-body">
        <ul className="studio-cost-rows">
          {paying.map((node) => (
            <li key={node.nodeId}>
              <span>{node.label}</span>
              <span>
                {node.kind === "flat" && node.credits !== undefined
                  ? `~${formatCredits(node.credits)}`
                  : t("usage priced")}
              </span>
            </li>
          ))}
        </ul>
        <p className="studio-cost-total">
          <span>{t("Total")}</span>
          <span>
            {estimate.metered > 0
              ? t("at least ~{credits}", { credits: formatCredits(estimate.credits) })
              : `~${formatCredits(estimate.credits)}`}
          </span>
        </p>
        <p className="studio-cost-note">
          {t("These are estimates, not a receipt. Usage priced nodes bill by what they consume.")}
        </p>
        <div className="studio-cost-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button type="button" className="studio-primary-button" onClick={onConfirm}>
            {t("Run workflow")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
