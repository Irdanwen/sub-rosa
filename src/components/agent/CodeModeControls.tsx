import "../../styles/code-review.css";
import { IconCode } from "central-icons/IconCode";
import { IconFiles } from "central-icons/IconFiles";
import { useState } from "react";
import {
  codeModeStartFailure,
  setCodeModeDraft,
  startCodeMode,
  useCodeMode,
  useCodeModeDraft,
} from "../../lib/code-mode";
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
  // Chosen for the new chat but refused when its first message started it.
  const failure = on ? undefined : (error ?? codeModeStartFailure(sessionId) ?? null);

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
          failure ??
          (on
            ? t("Code mode is on: every file the assistant changes is listed for review.")
            : t("Work on the code in this folder and review every change"))
        }
        data-error={failure ? "true" : undefined}
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

/**
 * Code mode for a chat not started yet (ADR-0090): shown in the new-chat
 * composer once a working folder is chosen. The choice is held for that
 * folder and taken up when the first message creates the chat, which records
 * where the folder starts before the agent reads the message.
 */
export function NewChatCodeModeToggle({ workingDir }: { workingDir: string }) {
  const draft = useCodeModeDraft();
  const on = draft === workingDir;
  return (
    <button
      type="button"
      className="agent-sandbox-trigger code-mode-draft-toggle"
      aria-pressed={on}
      title={
        on
          ? t(
              "This chat starts in Code mode: every file the assistant changes is listed for review.",
            )
          : t("Start this chat in Code mode on the working folder")
      }
      onClick={() => setCodeModeDraft(on ? null : workingDir)}
    >
      <IconCode size={14} aria-hidden />
      {t("Code")}
    </button>
  );
}
