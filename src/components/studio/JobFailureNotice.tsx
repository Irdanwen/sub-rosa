// The one place a failed generation is put into words.
//
// Every Studio surface used to print `job.state.message` raw, which is the
// backend talking to a client rather than to a person ("Unknown or expired
// queue_id - re-queue the job"). Worse, each surface decided for itself whether
// to run the constraint reader first, so the same failure read differently
// depending on which tab you were in.
//
// Ordering matters here: a constraint error names the field to fix and is the
// most actionable thing we can say, so it wins. Anything else goes through
// `describeJobFailure`, which is where "what happened" becomes "what to do".

import { describeJobFailure } from "../../lib/studio/job-errors";
import { explainConstraintError } from "../../lib/studio/model-constraints";

export function JobFailureNotice({
  message,
  status,
  className = "studio-error",
  retryClassName = "btn btn-secondary",
  onRetry,
}: {
  message?: string;
  /** HTTP status behind the failure, when the backend gave one. */
  status?: number;
  className?: string;
  retryClassName?: string;
  /**
   * Repeat the same request. Left out when the request is no longer known
   * well enough to repeat (after a restart, say) - offering a button that
   * would re-spend on a guess is worse than offering none.
   */
  onRetry?: () => void;
}) {
  const constraint = explainConstraintError(message ?? "");
  const failure = constraint ? undefined : describeJobFailure({ message, status });
  return (
    // The backend's own words stay reachable on hover: the summary is for
    // acting on, the detail is for reporting a bug against.
    <p className={className} title={failure?.detail}>
      {constraint ?? failure?.text ?? "The render failed."}
      {failure?.retryable && onRetry ? (
        <>
          {" "}
          <button type="button" className={retryClassName} onClick={onRetry}>
            Start again
          </button>
        </>
      ) : null}
    </p>
  );
}
