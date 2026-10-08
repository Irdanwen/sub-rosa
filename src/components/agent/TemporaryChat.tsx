import "../../styles/temporary-chat.css";
import { IconGhost } from "central-icons/IconGhost";
import { t } from "../../lib/i18n";
import { setTemporaryDraft, useIsTemporaryChat, useTemporaryDraft } from "../../lib/temporary-chat";

/**
 * The two faces of a temporary chat (ADR-0083): the switch a new chat starts
 * from, and the banner that stays at the head of one while it is open, so
 * nobody mistakes it for a chat that will be there tomorrow. Both shells use
 * these.
 */
export function TemporaryChatToggle({ disabled }: { disabled?: boolean }) {
  const on = useTemporaryDraft();
  return (
    <div className="temporary-chat-start" data-on={on || undefined}>
      <button
        type="button"
        className="temporary-chat-toggle"
        aria-pressed={on}
        disabled={disabled}
        onClick={() => setTemporaryDraft(!on)}
      >
        <IconGhost size={14} aria-hidden />
        {t("Temporary chat")}
      </button>
      {on ? <TemporaryChatNotice /> : null}
    </div>
  );
}

/** Shown at the head of an open temporary chat; nothing for any other. */
export function TemporaryChatBanner({ chatId }: { chatId?: string | null }) {
  const temporary = useIsTemporaryChat(chatId);
  return temporary ? <TemporaryChatNotice /> : null;
}

function TemporaryChatNotice() {
  return (
    <p className="temporary-chat-banner" role="status">
      <IconGhost size={14} aria-hidden />
      <span>{t("Temporary chat: not saved, not remembered")}</span>
    </p>
  );
}
