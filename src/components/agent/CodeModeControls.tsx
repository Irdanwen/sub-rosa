import "../../styles/code-review.css";
import { IconCode } from "central-icons/IconCode";
import { IconFiles } from "central-icons/IconFiles";
import { useState } from "react";
import { startCodeMode, useCodeMode } from "../../lib/code-mode";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { CodeReviewPanel } from "./CodeReviewPanel";

/**
 * Code mode's two buttons in a chat's session bar (ADR-0090), shown when the
 * chat has a working folder: "Code" turns the mode on (recording where the
 * folder starts), and "Review changes" opens the panel where each changed
 * file is kept or reverted. Turning the mode off lives in the panel.
 */
export function CodeModeControls({
  sessionId,
  workingDir,
}: {
  sessionId: string;
  workingDir: string;
}) {
  const { status } = useCodeMode(sessionId);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  // A review of another folder (the chat's folder changed since) restarts.
  const on = status.active && status.folder === workingDir;

  const start = () => {
    setStarting(true);
    setError(null);
    void startCodeMode(sessionId, workingDir)
      .catch((cause) => setError(messageFromError(cause)))
      .finally(() => setStarting(false));
  };

  return (
    <>
      <button
        type="button"
        className="code-mode-toggle"
        aria-pressed={on}
        disabled={starting || on}
        title={
          error ??
          (on
            ? t("Code mode is on: every file the assistant changes is listed for review.")
            : t("Work on the code in this folder and review every change"))
        }
        data-error={error ? "true" : undefined}
        onClick={start}
      >
        <IconCode size={13} aria-hidden />
        {starting ? t("Starting") : t("Code")}
      </button>
      {on ? (
        <button
          type="button"
          className="code-mode-toggle"
          title={t("Review what changed in the working folder")}
          onClick={() => setReviewOpen(true)}
        >
          <IconFiles size={13} aria-hidden />
          {t("Review changes")}
        </button>
      ) : null}
      {reviewOpen ? (
        <CodeReviewPanel
          sessionId={sessionId}
          folder={workingDir}
          onClose={() => setReviewOpen(false)}
        />
      ) : null}
    </>
  );
}
