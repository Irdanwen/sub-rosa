import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconArrowUndoUp } from "central-icons/IconArrowUndoUp";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { useCallback, useEffect, useState } from "react";
import { workingDirDisplayName } from "../../lib/agent-session-working-dir";
import {
  type CodeReviewChanges,
  codeReviewChanges,
  diffLineKind,
  type FileChange,
  keepChange,
  revertChange,
  stopCodeMode,
} from "../../lib/code-mode";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { Dialog } from "../ui/Dialog";

function statusLabel(status: FileChange["status"]): string {
  switch (status) {
    case "added":
      return t("Added");
    case "deleted":
      return t("Deleted");
    default:
      return t("Modified");
  }
}

function Diff({ change }: { change: FileChange }) {
  if (change.binary || !change.diff) {
    return (
      <p className="code-review-note">
        {change.revertible ? t("Binary file, no preview.") : t("Too large to preview or revert.")}
      </p>
    );
  }
  const lines = change.diff.replace(/\n$/, "").split("\n");
  return (
    <pre className="code-review-diff">
      {lines.map((line, index) => (
        // Lines of one diff never reorder, so their position is their identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: a diff is static text
        <span key={index} data-kind={diffLineKind(line)}>
          {line || " "}
        </span>
      ))}
      {change.truncated ? <span data-kind="hunk">{t("The diff is cut here.")}</span> : null}
    </pre>
  );
}

/**
 * The review of a chat in Code mode (ADR-0090): every file changed in the
 * working folder since the mode started, its diff, and keep or revert. A
 * revert asks once more, because it throws the change away. Rust decides
 * what may be reverted; this panel only names the file.
 */
export function CodeReviewPanel({
  sessionId,
  folder,
  onClose,
}: {
  sessionId: string;
  folder: string;
  onClose: () => void;
}) {
  const [review, setReview] = useState<CodeReviewChanges | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    void codeReviewChanges(sessionId)
      .then((next) => {
        setReview(next);
        // The first files open; a long list starts folded.
        setOpen(
          (current) =>
            new Set(
              current.size > 0 ? current : next.changes.slice(0, 3).map((change) => change.path),
            ),
        );
      })
      .catch((cause) => setError(messageFromError(cause)))
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(load, [load]);

  const act = (path: string, action: (sessionId: string, path: string) => Promise<void>) => {
    setBusyPath(path);
    setConfirming(null);
    setError(null);
    void action(sessionId, path)
      .then(load)
      .catch((cause) => setError(messageFromError(cause)))
      .finally(() => setBusyPath(null));
  };

  const keepAll = async () => {
    for (const change of review?.changes ?? []) {
      setBusyPath(change.path);
      try {
        await keepChange(sessionId, change.path);
      } catch (cause) {
        setError(messageFromError(cause));
        break;
      }
    }
    setBusyPath(null);
    load();
  };

  const changes = review?.changes ?? [];
  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <Dialog
      open
      onClose={onClose}
      width="min(920px, calc(100vw - 48px))"
      className="code-review-dialog"
      title={t("Changes in {folder}", { folder: workingDirDisplayName(folder) })}
      description={
        review?.status.base === "git"
          ? t("Compared with the folder as it was when Code mode started, using git.")
          : t("Compared with a copy of the folder taken when Code mode started.")
      }
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost code-review-off"
            onClick={() =>
              void stopCodeMode(sessionId)
                .then(onClose)
                .catch((cause) => setError(messageFromError(cause)))
            }
          >
            {t("Turn Code mode off")}
          </button>
          <button type="button" className="btn btn-secondary" disabled={loading} onClick={load}>
            <IconArrowRotateClockwise size={14} aria-hidden />
            {t("Refresh")}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={loading || busyPath !== null || changes.length === 0}
            onClick={() => void keepAll()}
          >
            <IconCheckmark1Small size={14} aria-hidden />
            {t("Keep all")}
          </button>
        </>
      }
    >
      <div className="code-review-body">
        {error ? (
          <p className="code-review-error" role="alert">
            {error}
          </p>
        ) : null}
        {loading && !review ? <p className="code-review-note">{t("Reading the folder")}</p> : null}
        {review && changes.length === 0 ? (
          <p className="code-review-note">{t("No changes since Code mode started.")}</p>
        ) : null}
        {review?.truncated ? (
          <p className="code-review-note">
            {t("Only the first files are listed. Keep or revert some to see the rest.")}
          </p>
        ) : null}
        <ul className="code-review-files">
          {changes.map((change) => {
            const expanded = open.has(change.path);
            const busy = busyPath === change.path;
            return (
              <li key={change.path} className="code-review-file" data-status={change.status}>
                <div className="code-review-file-head">
                  <button
                    type="button"
                    className="code-review-file-name"
                    aria-expanded={expanded}
                    onClick={() => toggle(change.path)}
                  >
                    <span className="code-review-status">{statusLabel(change.status)}</span>
                    <span className="code-review-path">{change.path}</span>
                    {change.binary ? null : (
                      <span className="code-review-counts">
                        <span data-kind="add">+{change.additions}</span>{" "}
                        <span data-kind="remove">-{change.deletions}</span>
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => act(change.path, keepChange)}
                  >
                    <IconCheckmark1Small size={14} aria-hidden />
                    {t("Keep")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost code-review-revert"
                    disabled={busy || !change.revertible}
                    data-confirming={confirming === change.path ? "true" : undefined}
                    title={
                      change.revertible
                        ? undefined
                        : t("No copy of this file was kept, so it cannot be reverted here.")
                    }
                    onClick={() =>
                      confirming === change.path
                        ? act(change.path, revertChange)
                        : setConfirming(change.path)
                    }
                  >
                    <IconArrowUndoUp size={14} aria-hidden />
                    {confirming === change.path ? t("Revert this file?") : t("Revert")}
                  </button>
                </div>
                {expanded ? <Diff change={change} /> : null}
              </li>
            );
          })}
        </ul>
      </div>
    </Dialog>
  );
}
