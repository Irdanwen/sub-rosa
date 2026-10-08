import "../../styles/connectors.css";
import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import { IconConnectors1 } from "central-icons/IconConnectors1";
import { useEffect, useState } from "react";
import type { ConnectorCallChatBlock } from "../../lib/chat-blocks";
import { type ConnectorCall, connectorCallDecide, connectorCallGet } from "../../lib/connectors";
import { friendlyErrorMessage } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { openExternalUrl } from "../../lib/tauri";
import { DotSpinner } from "../DotSpinner";

const PREVIEW_CHARS = 600;

function preview(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? "";
  } catch {
    text = "";
  }
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
}

function statusLine(call: ConnectorCall): string {
  switch (call.status) {
    case "pending":
      return t("Waiting for your approval. Nothing has run yet.");
    case "running":
      return t("Running");
    case "denied":
      return t("Declined. Nothing ran.");
    case "failed":
      return call.error ? t(call.error) : t("This action failed.");
    default:
      return call.result?.isError ? t("The service reported an error.") : t("Done");
  }
}

/**
 * A `subrosa:connector` block (ADR-0092): one call the assistant made through
 * a connector, read from its row. A call that asks first shows what it would
 * send and runs only on Approve; the row is claimed once, so a second tap, or
 * the same card on another screen, runs nothing.
 */
export function ConnectorCallCard({ block }: { block: ConnectorCallChatBlock }) {
  const [call, setCall] = useState<ConnectorCall | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    connectorCallGet(block.callId)
      .then((value) => {
        if (!cancelled) setCall(value);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [block.callId]);

  const decide = async (approve: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setCall(await connectorCallDecide(block.callId, approve));
    } catch (cause) {
      setError(friendlyErrorMessage(cause, t("That could not be done just now.")));
    } finally {
      setBusy(false);
    }
  };

  if (missing) {
    return (
      <section className="chat-block" aria-label={t("Connector action")}>
        <p className="connector-app-note">{t("This action is not on this device.")}</p>
      </section>
    );
  }
  if (!call) return null;
  const title = call.toolTitle ?? call.tool;
  return (
    <section className="chat-block" aria-label={t("Connector action")}>
      <header className="connector-card-head">
        <span className="chat-block-row-icon" aria-hidden>
          <IconConnectors1 size={16} />
        </span>
        <span className="chat-block-row-body">
          <span className="chat-block-row-title">{title}</span>
          <span className="chat-block-row-meta">{call.connectorName}</span>
        </span>
      </header>
      <div className="connector-card-body">
        <span
          className="connector-card-status"
          role="status"
          data-tone={call.status === "failed" ? "error" : undefined}
        >
          {statusLine(call)}
        </span>
        {call.status === "pending" ? (
          <>
            <span className="connector-card-status">{t("What it will send")}</span>
            <pre className="connector-card-args">{preview(call.arguments)}</pre>
            <div className="connector-card-actions">
              <button
                type="button"
                className="proposal-do"
                disabled={busy}
                onClick={() => void decide(true)}
              >
                {busy ? <DotSpinner /> : t("Approve")}
              </button>
              <button
                type="button"
                className="proposal-do"
                disabled={busy}
                onClick={() => void decide(false)}
              >
                {t("Decline")}
              </button>
            </div>
          </>
        ) : null}
        {call.status === "done" && call.result?.text ? (
          <p className="connector-card-text">{call.result.text.slice(0, 400)}</p>
        ) : null}
        {call.result?.links.length ? (
          <ul className="chat-block-rows">
            {call.result.links.map((link) => (
              <li key={link.url}>
                <button
                  type="button"
                  className="chat-block-row"
                  title={link.url}
                  onClick={() => void openExternalUrl(link.url)}
                >
                  <span className="chat-block-row-body">
                    <span className="chat-block-row-title">{link.title}</span>
                  </span>
                  <span className="chat-block-row-open" aria-hidden>
                    <IconArrowUpRight size={14} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <span className="connector-card-status" data-tone="error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </section>
  );
}
