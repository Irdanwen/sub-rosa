// "Read aloud" beside Copy on a finished reply. Shared by the desktop agent
// and the phone chat, which pass their own action class so it sits in their
// row like its neighbours. One reply speaks at a time (reply-speech.ts).

import "../../styles/reply-feedback.css";
import { IconSpeaker } from "central-icons/IconSpeaker";
import { IconStop } from "central-icons/IconStop";
import { useEffect } from "react";
import { t } from "../../lib/i18n";
import { replySpeech, useReplySpeech } from "../../lib/reply-speech";
import { Spinner } from "../ui/Spinner";

export function ReadAloudButton({
  speechKey,
  text,
  className,
  onPress,
}: {
  /** Identifies the reply, so pressing another one stops this one. */
  speechKey: string;
  /** The reply as written (markdown and chat blocks included). */
  text: string;
  className: string;
  /** A shell's own press feedback (the phone's haptic tick). */
  onPress?: () => void;
}) {
  const { status, toggle } = useReplySpeech(speechKey);

  // A reply that leaves the screen (another chat opened) stops talking.
  useEffect(
    () => () => {
      if (replySpeech.getState().key === speechKey) replySpeech.stop();
    },
    [speechKey],
  );

  if (!text.trim()) return null;
  const active = status === "playing" || status === "loading";
  const label = active ? t("Stop reading") : t("Read aloud");
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      aria-pressed={active}
      title={status === "failed" ? t("This reply could not be read aloud. Try again.") : label}
      data-state={status}
      onClick={() => {
        onPress?.();
        toggle(text);
      }}
    >
      {status === "loading" ? (
        <Spinner aria-hidden />
      ) : active ? (
        <IconStop size={13} aria-hidden />
      ) : (
        <IconSpeaker size={13} aria-hidden />
      )}
      <span>{active ? t("Stop") : t("Read aloud")}</span>
    </button>
  );
}
