// A workflow's runs, newest first: when, how it ended, what it made and what
// it was confirmed at. A past run's results can be shown on the canvas, and
// the graph it executed restored (its frozen definition, ADR-0021).

import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { useEffect, useState } from "react";
import { intlLocale, t } from "../../../lib/i18n";
import { formatCredits } from "../../../lib/studio/catalog";
import {
  runCredits,
  type WorkflowRunEntry,
  workflowRunHistory,
} from "../../../lib/studio/workflow-run";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { EmptyState } from "../../ui/EmptyState";
import { Spinner } from "../../ui/Spinner";

function statusLabel(entry: WorkflowRunEntry): string {
  switch (entry.status) {
    case "completed":
      return t("Finished");
    case "failed":
      return t("Stopped on an error");
    case "cancelled":
      return t("Stopped by you");
    case "awaitingGate":
      return t("Waiting on you");
    default:
      return t("Interrupted");
  }
}

export function RunHistoryPanel({
  workflowId,
  refreshKey,
  onShow,
  onRestore,
  onClose,
}: {
  workflowId: string;
  /** Changes when a run ends, so the list is read again. */
  refreshKey: unknown;
  onShow: (runId: string) => void;
  onRestore: (runId: string) => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<WorkflowRunEntry[] | undefined>(undefined);
  const [restoring, setRestoring] = useState<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey asks for a fresh read.
  useEffect(() => {
    let cancelled = false;
    void workflowRunHistory(workflowId).then((loaded) => {
      if (!cancelled) setEntries(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [workflowId, refreshKey]);
  const when = new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", timeStyle: "short" });
  return (
    <section className="studio-run-history" aria-label={t("Run history")}>
      <header className="studio-run-history-head">
        <h3>{t("Run history")}</h3>
        <button
          type="button"
          className="studio-icon-button"
          aria-label={t("Close")}
          onClick={onClose}
        >
          <IconCrossSmall size={14} />
        </button>
      </header>
      {entries === undefined ? (
        <Spinner aria-label={t("Loading")} />
      ) : entries.length === 0 ? (
        <EmptyState size="compact" title={t("This workflow has not run yet.")} />
      ) : (
        <ul className="studio-run-history-list">
          {entries.map((entry) => {
            const credits = runCredits(entry);
            return (
              <li key={entry.id} data-status={entry.status}>
                <div className="studio-run-history-line">
                  <span className="studio-run-history-when">
                    {when.format(new Date(entry.createdAt))}
                  </span>
                  <span>{statusLabel(entry)}</span>
                </div>
                <div className="studio-run-history-meta">
                  <span>
                    {entry.done === 1
                      ? t("One step made")
                      : t("{count} steps made", { count: entry.done })}
                  </span>
                  {credits !== undefined && credits > 0 ? (
                    <span>~{formatCredits(credits)}</span>
                  ) : null}
                </div>
                {entry.error ? <p className="studio-node-error">{entry.error}</p> : null}
                <div className="studio-run-history-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={entry.done === 0}
                    onClick={() => onShow(entry.id)}
                  >
                    {t("Show results")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setRestoring(entry.id)}
                  >
                    {t("Restore this graph")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={restoring !== undefined}
        onClose={() => setRestoring(undefined)}
        title={t("Restore the graph this run used?")}
        description={t(
          "The canvas goes back to the steps and settings of that run. Its results stay in the gallery.",
        )}
        confirmLabel={t("Restore")}
        onConfirm={() => {
          if (restoring) onRestore(restoring);
          setRestoring(undefined);
        }}
      />
    </section>
  );
}
