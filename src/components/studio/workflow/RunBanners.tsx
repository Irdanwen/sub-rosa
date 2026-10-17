// The banners above the workflow library and canvas: productions still being
// made in this session, and runs that stopped (failed, held at a gate,
// interrupted or stopped by hand) with Dismiss and Resume.

import { t } from "../../../lib/i18n";
import type { WorkflowRunSummary } from "../../../lib/studio/workflow-run";

export function RunBanners({
  running,
  liveProductions,
  resumable,
  dismissResumable,
  resume,
}: {
  running: boolean;
  liveProductions: Array<{ id: string; name: string }>;
  resumable: WorkflowRunSummary[];
  dismissResumable: (entry: WorkflowRunSummary) => Promise<void>;
  resume: (entry: WorkflowRunSummary) => Promise<void>;
}) {
  return (
    <>
      {!running && liveProductions.length > 0 ? (
        <div className="studio-resume-banner">
          {liveProductions.map((entry) => (
            <div key={entry.id} className="studio-resume-row">
              <span>
                {t("Still producing:")} <strong>{entry.name || t("Untitled workflow")}</strong>
                {t(". Its media lands in the gallery as it finishes.")}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {resumable.length > 0 ? (
        <div className="studio-resume-banner">
          {resumable.map((entry) => (
            <div key={entry.id} className="studio-resume-row">
              <span>
                {entry.status === "failed" ? (
                  <>
                    {t("A production that stopped:")}{" "}
                    <strong>{entry.name || t("Untitled workflow")}</strong>.{" "}
                    {entry.error || t("A step failed.")}{" "}
                    {t("Finished steps are kept; resuming retries the one that failed.")}
                  </>
                ) : entry.status === "cancelled" ? (
                  <>
                    {t("A production you stopped:")}{" "}
                    <strong>{entry.name || t("Untitled workflow")}</strong>
                    {t(". Finished steps are kept; resuming only runs what is left.")}
                  </>
                ) : entry.status === "awaitingGate" ? (
                  <>
                    {t("A production waiting on you:")}{" "}
                    <strong>{entry.name || t("Untitled workflow")}</strong>
                    {t(". Resume it to reach the gate and decide.")}
                  </>
                ) : (
                  <>
                    {t("An interrupted production:")}{" "}
                    <strong>{entry.name || t("Untitled workflow")}</strong>
                    {t(". Finished steps are kept; resuming only runs what is left.")}
                  </>
                )}
              </span>
              <span className="studio-resume-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={running}
                  onClick={() => void dismissResumable(entry)}
                >
                  {t("Dismiss")}
                </button>
                <button
                  type="button"
                  className="studio-primary-button"
                  disabled={running}
                  onClick={() => void resume(entry)}
                >
                  {t("Resume")}
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
