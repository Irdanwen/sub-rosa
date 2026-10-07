// Thumbs up and down on a finished reply, shared by the desktop agent and the
// phone chat. A thumbs down opens a short, optional "what went wrong": a few
// reasons and a line of the person's own. Nothing leaves the device
// (reply-ratings.ts), and the panel says so.

import "../../styles/reply-feedback.css";
import { IconThumbsDown } from "central-icons/IconThumbsDown";
import { IconThumbsUp } from "central-icons/IconThumbsUp";
import { IconThumbsDown as IconThumbsDownFilled } from "central-icons-filled/IconThumbsDown";
import { IconThumbsUp as IconThumbsUpFilled } from "central-icons-filled/IconThumbsUp";
import { useId, useState } from "react";
import { t } from "../../lib/i18n";
import {
  DOWN_REASONS,
  type DownReason,
  downReasonLabel,
  MAX_REASON_NOTE_CHARS,
  useReplyRating,
} from "../../lib/reply-ratings";

export function RateReply({
  conversationId,
  messageId,
  className,
  onPress,
}: {
  conversationId: string;
  messageId: string;
  /** The shell's action class, so the thumbs sit in its row like Copy. */
  className: string;
  /** A shell's own press feedback (the phone's haptic tick). */
  onPress?: () => void;
}) {
  const { rating, rate } = useReplyRating(conversationId, messageId);
  const [asking, setAsking] = useState(false);
  const value = rating?.rating;

  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={t("Good reply")}
        title={t("Good reply")}
        aria-pressed={value === "up"}
        data-rated={value === "up" || undefined}
        onClick={() => {
          onPress?.();
          setAsking(false);
          void rate({ rating: value === "up" ? null : "up" });
        }}
      >
        {value === "up" ? (
          <IconThumbsUpFilled size={13} aria-hidden />
        ) : (
          <IconThumbsUp size={13} aria-hidden />
        )}
      </button>
      <button
        type="button"
        className={className}
        aria-label={t("Bad reply")}
        title={t("Bad reply")}
        aria-pressed={value === "down"}
        aria-expanded={asking}
        data-rated={value === "down" || undefined}
        onClick={() => {
          onPress?.();
          if (value === "down") {
            setAsking(false);
            void rate({ rating: null });
            return;
          }
          void rate({ rating: "down" });
          setAsking(true);
        }}
      >
        {value === "down" ? (
          <IconThumbsDownFilled size={13} aria-hidden />
        ) : (
          <IconThumbsDown size={13} aria-hidden />
        )}
      </button>
      {asking ? (
        <DownReasonPanel
          initialReason={rating?.reason ?? undefined}
          initialNote={rating?.note ?? ""}
          onSave={(reason, note) => {
            setAsking(false);
            void rate({ rating: "down", reason, note });
          }}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </>
  );
}

function DownReasonPanel({
  initialReason,
  initialNote,
  onSave,
  onClose,
}: {
  initialReason?: DownReason;
  initialNote: string;
  onSave: (reason: DownReason | null, note: string | null) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<DownReason | undefined>(initialReason);
  const [note, setNote] = useState(initialNote);
  const headingId = useId();

  return (
    <fieldset className="reply-feedback-panel" aria-labelledby={headingId}>
      <p className="reply-feedback-title" id={headingId}>
        {t("What went wrong?")}
      </p>
      <div className="reply-feedback-reasons">
        {DOWN_REASONS.map((option) => (
          <button
            key={option}
            type="button"
            className="reply-feedback-reason"
            aria-pressed={reason === option}
            onClick={() => setReason((current) => (current === option ? undefined : option))}
          >
            {downReasonLabel(option)}
          </button>
        ))}
      </div>
      {reason === "other" ? (
        <input
          className="reply-feedback-note"
          aria-label={t("Your reason")}
          placeholder={t("Add a few words for yourself")}
          maxLength={MAX_REASON_NOTE_CHARS}
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSave(reason, note.trim() || null);
            }
          }}
        />
      ) : null}
      <div className="reply-feedback-footer">
        <span className="reply-feedback-privacy">{t("Kept on this device only.")}</span>
        <button type="button" className="reply-feedback-button" onClick={onClose}>
          {t("Skip")}
        </button>
        <button
          type="button"
          className="reply-feedback-button"
          data-primary="true"
          onClick={() => onSave(reason ?? null, reason === "other" ? note.trim() || null : null)}
        >
          {t("Save")}
        </button>
      </div>
    </fieldset>
  );
}
