// Above a workflow the assistant proposed (ADR-0120): it is shown, never
// changed or run, until the person keeps it or discards it.

import { t } from "../../../lib/i18n";

export function ProposalNotice({
  onKeep,
  onDiscard,
}: {
  onKeep: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="studio-port-notice" role="status">
      <span>
        {t("The assistant proposed this workflow. Keep it to change and run it, or discard it.")}
      </span>
      <button type="button" className="btn btn-secondary" onClick={onDiscard}>
        {t("Discard")}
      </button>
      <button type="button" className="studio-primary-button" onClick={onKeep}>
        {t("Keep")}
      </button>
    </div>
  );
}
