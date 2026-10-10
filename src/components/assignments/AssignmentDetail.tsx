import { ConnectorTriggers } from "./ConnectorTriggers";
import { IconPause } from "central-icons/IconPause";
import { IconPencil } from "central-icons/IconPencil";
import { IconPlay } from "central-icons/IconPlay";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useCallback, useEffect, useState } from "react";
import {
  type Assignment,
  type AssignmentRun,
  assignmentDelete,
  assignmentRunNow,
  assignmentRuns,
  assignmentSetPaused,
  cadenceLabel,
  formatWhen,
  onAssignmentsChanged,
  toolChoices,
} from "../../lib/assignments";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { RunHistoryRow, RunReview } from "./RunReview";

/**
 * One assignment: what it is, where and when it runs, the results waiting
 * for a verdict, and its history. Pause stops new slots; resuming does not
 * owe the slots it was paused through.
 */
export function AssignmentDetail({
  assignment,
  platform,
  onEdit,
  onDeleted,
  onChanged,
  onOpenRun,
}: {
  assignment: Assignment;
  platform: "desktop" | "phone";
  onEdit: () => void;
  onDeleted: () => void;
  onChanged: (assignment: Assignment) => void;
  onOpenRun?: (run: AssignmentRun) => void;
}) {
  const [runs, setRuns] = useState<AssignmentRun[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    try {
      setRuns(await assignmentRuns(assignment.id, 50));
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }, [assignment.id]);

  useEffect(() => {
    void load();
    return onAssignmentsChanged(() => void load());
  }, [load]);

  async function act(run: () => Promise<void>) {
    setBusy(true);
    try {
      await run();
      setError(null);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  }

  const tools = toolChoices("desktop")
    .filter((choice) => assignment.tools.includes(choice.id))
    .map((choice) => choice.label);
  const waiting = runs.filter((run) => run.state === "needs_review");
  const history = runs.filter((run) => run.state !== "needs_review");
  const running = runs.some((run) => run.state === "running");
  const isTask = assignment.kind === "task";

  return (
    <div className="assignment-detail">
      <section className="assignment-card">
        <p className="assignment-goal">{assignment.goal}</p>
        <dl className="assignment-facts">
          <dt>{t("When")}</dt>
          <dd>
            {cadenceLabel(assignment)}
            {assignment.paused ? ` · ${t("Paused")}` : ""}
          </dd>
          {assignment.nextRunAt && !assignment.paused ? (
            <>
              <dt>{t("Next run")}</dt>
              <dd>{formatWhen(assignment.nextRunAt)}</dd>
            </>
          ) : null}
          <dt>{t("Runs on")}</dt>
          <dd>
            {assignment.runsHere
              ? platform === "phone"
                ? t("This phone, when Sub Rosa is open")
                : t("This computer, while Sub Rosa is open")
              : assignment.deviceName || t("Your other device")}
          </dd>
          <dt>{t("Autonomy")}</dt>
          <dd>
            {assignment.autonomy === "ask"
              ? t("Ask before anything leaves the device")
              : t("Act within these tools")}
          </dd>
          <dt>{t("Tools")}</dt>
          <dd>{tools.length ? tools.join(", ") : t("None")}</dd>
        </dl>
        {assignment.waitingForConsent ? (
          <p className="assignment-notice">
            {t(
              'Another of your devices set this up. This computer runs it once you turn on "Run links sent from your other devices" in Settings, Import.',
            )}
          </p>
        ) : null}
        <div className="assignment-actions">
          <button
            type="button"
            className="assignment-button"
            data-tone="primary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const outcome = await assignmentRunNow(assignment.id);
                // A run started here says "running" from its row (below), so
                // the line goes when the result lands instead of staying on.
                setNotice(
                  outcome.outcome === "sent"
                    ? t("Sent to {device}. It runs there as soon as Sub Rosa is open.", {
                        device: outcome.deviceName || t("your other device"),
                      })
                    : null,
                );
                await load();
              })
            }
          >
            <IconPlay size={16} aria-hidden />
            {t("Run now")}
          </button>
          <button
            type="button"
            className="assignment-button"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                onChanged(await assignmentSetPaused(assignment.id, !assignment.paused));
              })
            }
          >
            {assignment.paused ? (
              <IconPlay size={16} aria-hidden />
            ) : (
              <IconPause size={16} aria-hidden />
            )}
            {assignment.paused ? t("Resume") : t("Pause")}
          </button>
          <button type="button" className="assignment-button" onClick={onEdit}>
            <IconPencil size={16} aria-hidden />
            {t("Edit")}
          </button>
          <button
            type="button"
            className="assignment-button"
            data-tone="danger"
            onClick={() => setConfirmDelete(true)}
          >
            <IconTrashCan size={16} aria-hidden />
            {t("Delete")}
          </button>
        </div>
        {notice ? <p className="assignment-meta">{notice}</p> : null}
        {running && !notice ? (
          <p className="assignment-meta">{t("Running now. The result lands here.")}</p>
        ) : null}
        {error ? (
          <p className="assignment-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <ConnectorTriggers assignmentId={assignment.id} />

      {waiting.length ? (
        <section className="assignment-section" aria-label={t("To review")}>
          <h2 className="assignment-section-title">{t("To review")}</h2>
          {waiting.map((run) => (
            <RunReview
              key={run.id}
              run={run}
              onReviewed={() => void load()}
              onOpenRun={onOpenRun}
            />
          ))}
        </section>
      ) : null}

      {/* A run waiting for review has run: the history says "not run yet"
       * only when there is no run at all, and stays away while the only
       * runs are the ones above. */}
      {history.length || !waiting.length ? (
        <section className="assignment-section" aria-label={t("History")}>
          <h2 className="assignment-section-title">{t("History")}</h2>
          {history.length ? (
            <ul className="assignment-history">
              {history.map((run) => (
                <RunHistoryRow key={run.id} run={run} />
              ))}
            </ul>
          ) : (
            <p className="assignment-meta">
              {isTask ? t("This task has not run yet.") : t("This assignment has not run yet.")}
            </p>
          )}
        </section>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await assignmentDelete(assignment.id);
          setConfirmDelete(false);
          onDeleted();
        }}
        title={isTask ? t("Delete this task?") : t("Delete this assignment?")}
        description={t("Its results and history are deleted on all your devices.")}
        confirmLabel={t("Delete")}
        cancelLabel={t("Cancel")}
        destructive
      />
    </div>
  );
}
