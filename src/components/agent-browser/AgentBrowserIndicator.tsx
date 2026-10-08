import { t } from "../../lib/i18n";
import { listen } from "@tauri-apps/api/event";
import { IconGlobe } from "central-icons/IconGlobe";
import { IconStopCircle } from "central-icons/IconStopCircle";
import { useEffect, useState } from "react";
import {
  AGENT_BROWSER_CONSENT_EVENT,
  AGENT_BROWSER_STATE_EVENT,
  type AgentBrowserStatus,
  type ConsentAnswer,
  type PendingConsent,
  agentBrowserStatus,
  answerAgentBrowserConsent,
  consentQuestion,
  indicatorVisible,
  journalLine,
  stopAgentBrowser,
} from "../../lib/agent-browser";
import "../../styles/agent-browser.css";

/** The live status, from the first read and every pushed change. */
export function useAgentBrowserStatus() {
  const [status, setStatus] = useState<AgentBrowserStatus | null>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      Promise.resolve()
        .then(() => agentBrowserStatus())
        .then((next) => {
          if (!disposed && next) setStatus(next);
        })
        .catch(() => {
          // An older build or a preview page has no browser to report.
        });
    };
    refresh();
    // Outside the app (a test, a preview page) there is no event bus.
    const unlisteners = [
      listen<AgentBrowserStatus>(AGENT_BROWSER_STATE_EVENT, (event) => {
        if (!disposed) setStatus(event.payload);
      }).catch(() => undefined),
      listen<PendingConsent>(AGENT_BROWSER_CONSENT_EVENT, refresh).catch(() => undefined),
    ];
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) void unlisten.then((stop) => stop?.());
    };
  }, []);
  return status;
}

/** "May the agent use this site?", answered in place. */
export function AgentBrowserConsentCard({ pending }: { pending: PendingConsent }) {
  const [answering, setAnswering] = useState(false);
  const answer = (choice: ConsentAnswer) => {
    setAnswering(true);
    void answerAgentBrowserConsent(pending.id, choice).catch(() => setAnswering(false));
  };
  return (
    <div className="agent-browser-consent" role="alertdialog" aria-label={consentQuestion(pending)}>
      <p className="agent-browser-consent-question">{consentQuestion(pending)}</p>
      <p className="agent-browser-consent-detail">
        {pending.site
          ? t(
              "The agent opens pages of this site in its own browser window. It never types passwords or card numbers.",
            )
          : t("It will open its browser window again to carry on with the task.")}
      </p>
      <div className="agent-browser-consent-actions">
        {pending.site ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={answering}
            onClick={() => answer("always")}
          >
            {t("Always allow")}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          disabled={answering}
          onClick={() => answer("once")}
        >
          {pending.site ? t("Allow this time") : t("Allow")}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={answering}
          onClick={() => answer("deny")}
        >
          {pending.site ? t("Don’t allow") : t("Keep it stopped")}
        </button>
      </div>
    </div>
  );
}

/**
 * The browser's presence in the app (ADR-0094): consent questions, the
 * "Sub Rosa is using the browser" bar with its Stop, and the journal of
 * what the agent did there. Renders nothing while the browser is idle.
 */
export function AgentBrowserIndicator() {
  const status = useAgentBrowserStatus();
  const [journalOpen, setJournalOpen] = useState(false);
  if (!status || !indicatorVisible(status)) return null;
  const journal = [...status.journal].reverse();
  return (
    <aside className="agent-browser-indicator" aria-label={t("Agent browser")} aria-live="polite">
      {status.pending.map((pending) => (
        <AgentBrowserConsentCard key={pending.id} pending={pending} />
      ))}
      {status.active ? (
        <div className="agent-browser-bar">
          <IconGlobe size={15} aria-hidden />
          <span className="agent-browser-bar-label">
            {status.site
              ? t("Sub Rosa is using the browser on {site}", { site: status.site })
              : t("Sub Rosa is using the browser")}
          </span>
          <button
            type="button"
            className="agent-browser-journal-toggle"
            aria-expanded={journalOpen}
            onClick={() => setJournalOpen((open) => !open)}
          >
            {journalOpen ? t("Hide steps") : t("Steps")}
          </button>
          <button
            type="button"
            className="agent-browser-stop"
            onClick={() => void stopAgentBrowser()}
          >
            <IconStopCircle size={15} aria-hidden />
            {t("Stop")}
          </button>
        </div>
      ) : null}
      {status.active && journalOpen ? (
        <ol className="agent-browser-journal">
          {journal.length === 0 ? <li>{t("Nothing yet.")}</li> : null}
          {journal.map((entry) => (
            <li key={`${entry.at}-${entry.action}-${entry.target}`}>{journalLine(entry)}</li>
          ))}
        </ol>
      ) : null}
    </aside>
  );
}
