import { useCallback, useEffect, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { type EgressLedgerDto, egressLedger } from "../../lib/tauri";
import { formatBytes } from "./StorageSettingsSection";

/** "3 min ago", "yesterday", or the date, for a timeline a person scans. */
export function relativeTime(iso: string, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return new Date(then).toLocaleDateString();
}

/** The sentence above the timeline: what left, in how many requests, to whom. */
export function egressSentence(summary: EgressLedgerDto["summary"], days: number) {
  if (summary.requests === 0) return `Nothing left this machine in the last ${days} days.`;
  const hosts = summary.hosts.length === 1 ? summary.hosts[0] : `${summary.hosts.length} hosts`;
  const requests = summary.requests === 1 ? "1 request" : `${summary.requests} requests`;
  return `${requests} in the last ${days} days, ${formatBytes(summary.requestBytes)} sent and ${formatBytes(summary.responseBytes)} received, to ${hosts}.`;
}

/**
 * The promise kept: every outbound request the process made, newest first,
 * with what it was for and how big it was. Read from the ledger the Rust
 * side writes (`egress_ledger.rs`); nothing here is a sentence about what
 * the app does, it is the record of what it did.
 */
export function EgressLedgerCard({ noteId }: { noteId?: string } = {}) {
  const [ledger, setLedger] = useState<EgressLedgerDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(30);
  const days = 7;

  const load = useCallback(() => {
    egressLedger({ limit, noteId, days })
      .then((next) => {
        setLedger(next);
        setError(null);
      })
      .catch((err) => setError(messageFromError(err)));
  }, [limit, noteId]);

  useEffect(load, [load]);

  return (
    <div className="settings-card egress-ledger">
      <div className="settings-row">
        <div className="settings-row-info">
          <h3 className="settings-row-title">What left this machine</h3>
          <p className="settings-row-description">
            {ledger ? egressSentence(ledger.summary, days) : error ? error : "Reading the ledger…"}
          </p>
          {ledger && ledger.summary.purposes.length > 0 ? (
            <p className="settings-row-description egress-purposes">
              {ledger.summary.purposes
                .map(([purpose, count]) => `${purpose} ×${count}`)
                .join(" · ")}
            </p>
          ) : null}
        </div>
        <div className="settings-row-control">
          <button type="button" className="btn btn-secondary" onClick={load}>
            Refresh
          </button>
        </div>
      </div>
      {ledger && ledger.rows.length > 0 ? (
        <table className="egress-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Purpose</th>
              <th scope="col">Host</th>
              <th scope="col">Sent</th>
              <th scope="col">Received</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {ledger.rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <time dateTime={row.at}>{relativeTime(row.at)}</time>
                </td>
                <td>
                  {row.purpose}
                  {row.model ? <span className="egress-model"> · {row.model}</span> : null}
                </td>
                <td>{row.host}</td>
                <td>{formatBytes(row.requestBytes)}</td>
                <td>{formatBytes(row.responseBytes)}</td>
                <td>{row.status ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {ledger && ledger.rows.length >= limit ? (
        <div className="egress-more">
          <button type="button" className="btn btn-ghost" onClick={() => setLimit((n) => n + 100)}>
            Show more
          </button>
        </div>
      ) : null}
      {ledger ? (
        <p className="settings-row-description egress-footnote">
          Shapes, never contents: the ledger records where a request went, what it was for and how
          big it was, and keeps {ledger.retentionDays} days of it.
        </p>
      ) : null}
    </div>
  );
}
