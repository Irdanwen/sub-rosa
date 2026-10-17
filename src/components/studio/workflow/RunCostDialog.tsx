// The pre-spend handshake a run passes through before any paid node starts.

import { t } from "../../../lib/i18n";
import { formatCredits } from "../../../lib/studio/catalog";
import type { WorkflowCostEstimate } from "../../../lib/studio/workflow";
import { useState } from "react";
import { readSpendCeiling, writeSpendCeiling } from "../../../lib/studio/workflow/spend-ceiling";
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
  const [ceiling, setCeiling] = useState<number | undefined>(readSpendCeiling);
  const over = ceiling !== undefined && estimate.credits > ceiling;
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
                {node.reused
                  ? t("Reused, free")
                  : node.kind === "flat" && node.credits !== undefined
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
        <label className="studio-cost-ceiling">
          <span>{t("Stop a run that would spend more than")}</span>
          <input
            className="studio-input"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            placeholder={t("No limit")}
            value={ceiling ?? ""}
            onChange={(event) => {
              const value = event.target.value === "" ? undefined : Number(event.target.value);
              const next = value !== undefined && value > 0 ? value : undefined;
              setCeiling(next);
              writeSpendCeiling(next);
            }}
          />
        </label>
        {over ? (
          <p className="studio-node-error" role="alert">
            {t("This run is estimated above your ceiling. Raise it or run part of the workflow.")}
          </p>
        ) : null}
        <p className="studio-cost-note">
          {t("These are estimates, not a receipt. Usage priced nodes bill by what they consume.")}
        </p>
        <div className="studio-cost-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="studio-primary-button"
            disabled={over}
            onClick={onConfirm}
          >
            {t("Run workflow")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
