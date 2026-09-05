import { t } from "../../lib/i18n";
import { IconCloudOff } from "central-icons/IconCloudOff";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NoteListItemDto } from "../../lib/tauri";
import { carpeDiemProbeUpstream, listNotesFailedInTransit, retryProcessing } from "../../lib/tauri";

/** How often the endpoint is asked whether it is back, while notes wait. */
export const OFFLINE_PROBE_INTERVAL_MS = 30_000;

export type OfflineState = {
  /** Notes whose request never reached the endpoint. */
  waiting: string[];
  /** Null until the first probe answers. */
  reachable: boolean | null;
};

/** The sentence the banner shows, from the two facts it has. */
export function offlineSentence(waiting: number, reachable: boolean | null) {
  const notes = waiting === 1 ? "1 note is waiting" : `${waiting} notes are waiting`;
  if (reachable === false) return `You are offline. ${notes} to be processed.`;
  if (reachable === true) return `The connection is back. ${notes} to be processed.`;
  return `${notes} to be processed; checking the connection…`;
}

/**
 * Tracks the notes that failed on the network, and whether the endpoint is
 * back. Nothing here retries on its own (ADR-0018 keeps the desktop's manual
 * retry meaningful); it only knows enough to say so, and to make "Retry all"
 * a single gesture when the connection returns.
 */
export function useOfflineState(notes: NoteListItemDto[]): OfflineState & {
  retryAll: () => Promise<void>;
  retrying: boolean;
} {
  const failedCount = notes.filter((note) => note.processingStatus === "failed").length;
  const [waiting, setWaiting] = useState<string[]>([]);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [retrying, setRetrying] = useState(false);
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;

  // Which failed notes are transport failures: asked whenever the number of
  // failed notes changes, which is when it can have changed.
  useEffect(() => {
    let cancelled = false;
    if (failedCount === 0) {
      setWaiting([]);
      return;
    }
    // Through a resolved promise so a bridge without the command (a test,
    // a preview page) rejects instead of throwing out of the effect.
    Promise.resolve()
      .then(() => listNotesFailedInTransit())
      .then((ids) => {
        if (!cancelled) setWaiting(ids);
      })
      .catch(() => {
        if (!cancelled) setWaiting([]);
      });
    return () => {
      cancelled = true;
    };
  }, [failedCount]);

  // Probe only while something waits; stop the moment nothing does.
  useEffect(() => {
    if (waiting.length === 0) {
      setReachable(null);
      return;
    }
    let cancelled = false;
    const probe = () => {
      Promise.resolve()
        .then(() => carpeDiemProbeUpstream())
        .then((result) => {
          if (!cancelled) setReachable(result.reachable);
        })
        .catch(() => {
          if (!cancelled) setReachable(false);
        });
    };
    probe();
    const timer = window.setInterval(probe, OFFLINE_PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [waiting.length]);

  const retryAll = useCallback(async () => {
    const ids = waitingRef.current;
    if (ids.length === 0) return;
    setRetrying(true);
    try {
      for (const id of ids) {
        try {
          await retryProcessing(id);
        } catch {
          // A note that still cannot go stays failed; the list will say so.
        }
      }
      setWaiting([]);
    } finally {
      setRetrying(false);
    }
  }, []);

  return { waiting, reachable, retryAll, retrying };
}

export function OfflineBanner({
  waiting,
  reachable,
  retrying,
  onRetryAll,
}: {
  waiting: number;
  reachable: boolean | null;
  retrying: boolean;
  onRetryAll: () => void;
}) {
  if (waiting === 0) return null;
  return (
    <section
      className="message-card permission-banner offline-banner"
      role="status"
      aria-label={t("Connection")}
    >
      <p className="permission-banner-message">
        <span className="permission-banner-eyebrow">
          <IconCloudOff size={14} aria-hidden />
        </span>
        <span className="permission-banner-body">{offlineSentence(waiting, reachable)}</span>
      </p>
      <div className="permission-banner-actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={retrying || reachable === false}
          onClick={onRetryAll}
        >
          {retrying ? t("Retrying…") : t("Retry all")}
        </button>
      </div>
    </section>
  );
}
