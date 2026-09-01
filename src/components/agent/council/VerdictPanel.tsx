import { listen } from "@tauri-apps/api/event";
import { messageFromError } from "../../../lib/errors";
import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconCircleQuestionmark } from "central-icons/IconCircleQuestionmark";
import { IconCircleX } from "central-icons/IconCircleX";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { useCallback, useEffect, useState } from "react";
import {
  councilCycle as fetchCycle,
  councilRequestVerdict,
  councilRetake,
  councilVerdicts as fetchVerdicts,
  COUNCIL_EVENT,
  needsRetake,
  retakesLeft,
  verdictTally,
  type CouncilCycle,
  type CouncilVerdict,
  type CriterionStatus,
} from "../../../lib/council";

/**
 * The verdict: finished work read against the mandate that asked for it.
 *
 * It is offered rather than run. Accepting a mandate bought a deliberation, not
 * a reading of whatever came out hours later, and the moment the work lands is
 * exactly when the user knows whether they want one.
 *
 * A verdict never announces a score. It answers each criterion with the
 * evidence that settled it, names what no criterion covered, and stops.
 */
export function VerdictPanel({
  mandateId,
  readReply,
  onRetake,
  onClose,
}: {
  mandateId: string;
  /** What the agent said when it reported finished, for a sitting that left
   * nothing on disk. Injected rather than read here, like SessionUsagePanel's
   * fetcher: the transcript lives behind the gateway and this panel has no
   * business knowing that. Returning nothing is fine -- Rust prefers the
   * working folder anyway and refuses when neither exists. */
  readReply: (sessionId: string) => Promise<string | undefined>;
  /** Sends the corrective instructions as a follow-up turn in the session that
   * did the work. The id is passed explicitly: by the time a verdict is read
   * the user may well be looking at a different session, and a correction
   * delivered to the wrong one is a correction delivered to nobody. */
  onRetake: (prompt: string, sessionId: string | null) => Promise<void>;
  /** The round is handed back so the caller can remember a declined offer and
   * not re-open it at the agent's next pause. */
  onClose: (round?: number) => void;
}) {
  const [cycle, setCycle] = useState<CouncilCycle | null>(null);
  const [verdicts, setVerdicts] = useState<CouncilVerdict[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const read = () => {
      void fetchCycle(mandateId).then((row) => {
        if (live && row) setCycle(row);
      });
      void fetchVerdicts(mandateId).then((rows) => {
        if (live) setVerdicts(rows);
      });
    };
    read();
    const unlisten = listen<CouncilCycle>(COUNCIL_EVENT, (event) => {
      if (event.payload.id !== mandateId) return;
      read();
    });
    return () => {
      live = false;
      void unlisten.then((off) => off());
    };
  }, [mandateId]);

  const ask = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // The work may have left nothing on disk -- an analysis, a rating, a
      // rewritten text lives in the reply and nowhere else. Rust prefers a
      // diff when there is a folder and falls back to this, so handing it over
      // costs nothing when the folder is the real evidence.
      const sessionId = cycle?.sessionId ?? undefined;
      const reply = sessionId ? await readReply(sessionId).catch(() => undefined) : undefined;
      await councilRequestVerdict(mandateId, reply);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(false);
    }
  }, [cycle?.sessionId, mandateId, readReply]);

  const correct = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const retake = await councilRetake(mandateId);
      await onRetake(retake.prompt, retake.cycle.sessionId ?? null);
      // No round is passed: a correction is not a declined offer, and the next
      // verdict belongs to the round that just opened.
      onClose();
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(false);
    }
  }, [mandateId, onClose, onRetake]);

  const latest = verdicts.at(-1);
  const running = latest?.status === "running" || cycle?.status === "reviewing";
  const left = cycle ? retakesLeft(cycle) : 0;

  return (
    <section className="council-verdict" aria-label="Verdict">
      <header className="council-header">
        <div className="council-header-text">
          <h2 className="council-title">The verdict</h2>
          {cycle ? <p className="council-request">{cycle.request}</p> : null}
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => onClose(cycle?.round)}
          aria-label="Close"
        >
          <IconCrossSmall size={16} aria-hidden />
        </button>
      </header>

      {!latest && !running ? (
        <>
          <p className="council-status">
            The agent has stopped. The council can read what changed against the mandate it issued,
            on models the work was not written on.
          </p>
          <div className="council-actions">
            <button
              type="button"
              className="primary-action"
              disabled={busy}
              onClick={() => void ask()}
            >
              Have it read
            </button>
            <button
              type="button"
              className="council-secondary"
              onClick={() => onClose(cycle?.round)}
            >
              Not now
            </button>
          </div>
        </>
      ) : null}

      {running ? (
        <p className="council-status" role="status">
          Reading what changed…
        </p>
      ) : null}

      {latest?.status === "failed" ? (
        <div className="council-notice council-failed" role="alert">
          <h3 className="council-notice-title">The reading stopped</h3>
          <p>{latest.lastError ?? "Something went wrong."}</p>
          <div className="council-actions">
            <button
              type="button"
              className="council-secondary"
              disabled={busy}
              onClick={() => void ask()}
            >
              Try again
            </button>
          </div>
        </div>
      ) : null}

      {verdicts
        .filter((verdict) => verdict.status === "ready")
        .map((verdict) => (
          <VerdictRound key={verdict.round} verdict={verdict} />
        ))}

      {latest?.status === "ready" ? (
        <div className="council-actions">
          {needsRetake(latest) && left > 0 ? (
            <button
              type="button"
              className="primary-action"
              disabled={busy}
              onClick={() => void correct()}
            >
              Send it back ({left} left)
            </button>
          ) : null}
          {needsRetake(latest) && left === 0 ? (
            <p className="council-status">
              Both corrections have been used. What is still unsatisfied is listed above, and the
              next move is yours.
            </p>
          ) : null}
          {!needsRetake(latest) ? (
            <p className="council-status">Everything the mandate asked for holds.</p>
          ) : null}
          <button type="button" className="council-secondary" onClick={() => onClose(cycle?.round)}>
            Close
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="council-problems" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function VerdictRound({ verdict }: { verdict: CouncilVerdict }) {
  const tally = verdictTally(verdict);
  return (
    <article className="council-verdict-round">
      <h3 className="council-notice-title">
        {verdict.round === 0 ? "First reading" : `After correction ${verdict.round}`}
        <span className="council-verdict-tally">
          {tally.satisfied} of {tally.total} criteria hold
          {tally.unverifiable > 0 ? `, ${tally.unverifiable} could not be checked` : ""}
        </span>
      </h3>

      {verdict.summary ? <p className="council-verdict-summary">{verdict.summary}</p> : null}

      <ol className="council-criteria-list">
        {verdict.criteria.map((criterion) => (
          <li key={criterion.statement} data-status={criterion.status}>
            <StatusIcon status={criterion.status} />
            <span className="council-criterion-text">
              <span>{criterion.statement}</span>
              {criterion.evidence ? (
                <span className="council-criterion-evidence">{criterion.evidence}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>

      {verdict.findings.length > 0 ? (
        <div className="council-notice">
          <h4 className="council-notice-title">Outside the criteria</h4>
          <ul>
            {verdict.findings.map((finding) => (
              <li key={`${finding.kind}-${finding.summary}`}>
                <span className="council-finding-kind">{findingLabel(finding.kind)}</span>
                {finding.summary}
                {finding.evidence ? (
                  <span className="council-criterion-evidence">{finding.evidence}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

function findingLabel(kind: string): string {
  if (kind === "letter") return "Satisfied in appearance only";
  if (kind === "skipped") return "Asked for and not done";
  return "Changed without being asked";
}

function StatusIcon({ status }: { status: CriterionStatus }) {
  if (status === "satisfied") return <IconCircleCheck size={16} aria-hidden />;
  if (status === "unsatisfied") return <IconCircleX size={16} aria-hidden />;
  return <IconCircleQuestionmark size={16} aria-hidden />;
}
