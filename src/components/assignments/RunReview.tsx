import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { useId, useState } from "react";
import {
  type AssignmentRun,
  assignmentReview,
  formatWhen,
  resultSummary,
  runErrorLabel,
  runPlaceLabel,
  runStateLabel,
} from "../../lib/assignments";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";

/**
 * One result in the inbox: what the run found, and Approve or Reject with a
 * sentence for the next run. The sentence is the point: it is read back by
 * every later run of the assignment, wherever it runs (ADR-0091).
 */
export function RunReview({
  run,
  title,
  onReviewed,
  onOpenRun,
}: {
  run: AssignmentRun;
  /** The assignment's title, when the inbox mixes several. */
  title?: string;
  onReviewed: (run: AssignmentRun) => void;
  /** Opens the run's own conversation, where there is one to open. */
  onOpenRun?: (run: AssignmentRun) => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const feedbackId = useId();
  const summary = resultSummary(run.result);

  async function review(approve: boolean) {
    setBusy(true);
    try {
      onReviewed(await assignmentReview(run.id, approve, feedback.trim() || undefined));
      setError(null);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="assignment-review" aria-label={title ?? t("Result to review")}>
      <header className="assignment-review-head">
        {title ? <span className="assignment-review-title">{title}</span> : null}
        <span className="assignment-meta">
          {formatWhen(run.finishedAt ?? run.startedAt)} · {runPlaceLabel(run)}
          {run.late ? ` · ${t("Ran late")}` : ""}
        </span>
      </header>
      {summary ? <p className="assignment-review-summary">{summary}</p> : null}
      {run.result ? (
        <button
          type="button"
          className="assignment-link-button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? t("Hide the full result") : t("Read the full result")}
        </button>
      ) : null}
      {open && run.result ? <pre className="assignment-result">{run.result}</pre> : null}
      <label className="assignment-field-label" htmlFor={feedbackId}>
        {t("Feedback for the next run")}
      </label>
      <textarea
        id={feedbackId}
        className="assignment-textarea"
        rows={2}
        value={feedback}
        placeholder={t("What to keep, what to change")}
        onChange={(event) => setFeedback(event.target.value)}
      />
      <div className="assignment-actions">
        <button
          type="button"
          className="assignment-button"
          data-tone="primary"
          disabled={busy}
          onClick={() => void review(true)}
        >
          <IconCheckmark1Small size={16} aria-hidden />
          {t("Approve")}
        </button>
        <button
          type="button"
          className="assignment-button"
          disabled={busy}
          onClick={() => void review(false)}
        >
          <IconCrossSmall size={16} aria-hidden />
          {t("Reject")}
        </button>
        {onOpenRun && run.handle && run.deviceName === "phone" ? (
          <button type="button" className="assignment-link-button" onClick={() => onOpenRun(run)}>
            {t("Open the conversation")}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="assignment-error" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}

/** One line of an assignment's history. */
export function RunHistoryRow({ run }: { run: AssignmentRun }) {
  const [open, setOpen] = useState(false);
  const summary = run.state === "failed" ? runErrorLabel(run.error) : resultSummary(run.result);
  return (
    <li className="assignment-history-row">
      <div className="assignment-history-line">
        <span className="assignment-state" data-state={run.state}>
          {runStateLabel(run.state)}
        </span>
        <span className="assignment-meta">
          {formatWhen(run.startedAt)} · {runPlaceLabel(run)}
          {run.late ? ` · ${t("Ran late")}` : ""}
          {run.slot.startsWith("approved:") ? ` · ${t("Carried out after approval")}` : ""}
        </span>
      </div>
      {summary ? <p className="assignment-history-summary">{summary}</p> : null}
      {run.feedback ? (
        <p className="assignment-history-feedback">
          {t("Your feedback: {feedback}", { feedback: run.feedback })}
        </p>
      ) : null}
      {run.result ? (
        <>
          <button
            type="button"
            className="assignment-link-button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? t("Hide the full result") : t("Read the full result")}
          </button>
          {open ? <pre className="assignment-result">{run.result}</pre> : null}
        </>
      ) : null}
    </li>
  );
}
