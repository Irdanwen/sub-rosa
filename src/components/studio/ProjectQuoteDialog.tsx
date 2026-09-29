import { intlLocale, t } from "../../lib/i18n";
import type { WorkflowCostEstimate } from "../../lib/studio/workflow/cost";
import { Dialog } from "../ui/Dialog";

const quoteCredits = (credits: number) =>
  credits.toLocaleString(intlLocale(), { maximumFractionDigits: 2 });

/** What a generation will cost, step by step, before anything is spent. */
export function ProjectQuoteDialog({
  quote,
  budget,
  onClose,
  onConfirm,
}: {
  quote: {
    estimate: WorkflowCostEstimate;
    notes?: string[];
    uncertainRetry?: boolean;
    priorSpend?: number;
  };
  budget: number;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("Review generation costs")}
      description={t(
        "Only the steps listed here will be generated. Your existing takes remain available.",
      )}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={
              quote.estimate.metered > 0 ||
              quote.estimate.credits + (quote.priorSpend ?? 0) > budget
            }
            onClick={onConfirm}
          >
            {t("Generate · {credits} credits", {
              credits: quoteCredits(quote.estimate.credits),
            })}
          </button>
        </>
      }
    >
      <div className="dialog-body">
        {quote.notes?.map((note) => (
          <p className="project-warning" key={note}>
            {note}
          </p>
        ))}
        {quote.uncertainRetry ? (
          <p className="project-warning">
            {t(
              "A previous request may already have been charged. Check your provider history before confirming this new quote.",
            )}
          </p>
        ) : null}
        {quote.estimate.nodes
          .filter((node) => node.kind !== "free")
          .map((node) => (
            <div className="project-quote-row" key={node.nodeId}>
              <span>{node.label}</span>
              <strong>
                {node.credits === undefined
                  ? t("Price unavailable")
                  : t("{credits} credits", { credits: quoteCredits(node.credits) })}
              </strong>
            </div>
          ))}
        {quote.estimate.metered > 0 ? (
          <p className="project-warning">
            {t(
              "Some prices are unavailable. Choose another model or try quoting again before generating.",
            )}
          </p>
        ) : null}
        {quote.estimate.credits + (quote.priorSpend ?? 0) > budget ? (
          <p className="project-error">{t("This generation exceeds the spend ceiling.")}</p>
        ) : null}
      </div>
    </Dialog>
  );
}
