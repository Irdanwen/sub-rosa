/**
 * A note that is not being worked on and has not been finished, and a way to
 * pick it back up.
 *
 * Two ways to get here. The user pressed Stop - nothing failed, so this is a
 * status and not an alert, and the action is "Resume", not "Retry". Or the app
 * closed mid-run: the row still says transcribing, nothing in this process is
 * working on it, and on the desktop nothing ever will be (there is no resume
 * sweep there). Before this, that note showed a spinner that turned forever,
 * which is precisely the "is it stuck?" nobody could answer.
 *
 * Resuming reuses the retry path, which keeps every turn already transcribed:
 * what was paid for is not paid for twice.
 */

import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { useState } from "react";
import { t } from "../../lib/i18n";
import { InlineNotice } from "../ui/InlineNotice";

export function ProcessingResumeNotice({
  reason,
  audioPreserved,
  onResume,
}: {
  reason: "stopped" | "stalled";
  audioPreserved: boolean;
  onResume: () => void | Promise<void>;
}) {
  // A fast double press must not start two runs. The notice unmounts once the
  // note is being worked on again, so the flag never needs resetting on
  // success; the catch releases it when the resume itself is refused.
  const [resuming, setResuming] = useState(false);

  async function handleResume() {
    if (resuming) return;
    setResuming(true);
    try {
      await onResume();
    } catch {
      setResuming(false);
    }
  }

  const body =
    reason === "stopped"
      ? t("You stopped processing this note.")
      : t("Processing stopped when the app closed.");
  const saved = audioPreserved
    ? t("The recording is saved, so you can pick it up where it left off.")
    : t("The recording could not be found, so there is nothing to resume.");

  return (
    <InlineNotice
      className="processing-resume-notice"
      role="status"
      body={`${body} ${saved}`}
      actions={
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void handleResume()}
          disabled={!audioPreserved || resuming}
          aria-busy={resuming || undefined}
        >
          <IconArrowRotateClockwise size={14} aria-hidden />
          {t("Resume")}
        </button>
      }
    />
  );
}
