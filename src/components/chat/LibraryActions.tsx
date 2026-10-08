// "Save" and "Open in canvas": what a reply, a link or a place offers the
// Library and the canvas (ADR-0087, ADR-0088). Shared by the desktop agent,
// the phone chat and the chat cards, so each surface passes its own action
// class and press feedback, like the thumbs beside them.

import "../../styles/canvas.css";
import { IconBookmark } from "central-icons/IconBookmark";
import { IconBookmark as IconBookmarkFilled } from "central-icons-filled/IconBookmark";
import { IconSidebarSimpleRightWide } from "central-icons/IconSidebarSimpleRightWide";
import { useState } from "react";
import { openReplyInCanvas } from "../../lib/canvas";
import { friendlyErrorMessage } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  replySaveRequest,
  type SavedItemKind,
  toggleSaved,
  useSavedItem,
} from "../../lib/chat-library";
import { useIsTemporaryChat, useTemporaryChatOpen } from "../../lib/temporary-chat";

type SaveRequest = {
  kind: SavedItemKind;
  sourceKey: string;
  title: string;
  payload: Record<string, unknown>;
  conversationId?: string;
};

/**
 * Keeps a thing in the Library, or takes it back out. Hidden in a temporary
 * chat: keeping anything is one more way out of it (ADR-0083). A card does
 * not know its chat, so it is hidden while any temporary chat is open.
 */
export function SaveToggle({
  request,
  className,
  onPress,
}: {
  request: SaveRequest;
  className: string;
  onPress?: () => void;
}) {
  const saved = useSavedItem(request.sourceKey);
  const temporary = useIsTemporaryChat(request.conversationId);
  const temporaryOpen = useTemporaryChatOpen();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (temporary || (!request.conversationId && temporaryOpen)) return null;

  const label = saved ? t("Remove from Library") : t("Save to Library");
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={error ?? label}
      aria-pressed={Boolean(saved)}
      data-saved={saved ? true : undefined}
      data-failed={error ? true : undefined}
      disabled={busy}
      onClick={() => {
        onPress?.();
        setBusy(true);
        setError(null);
        void toggleSaved(request, saved)
          .catch((cause) =>
            setError(friendlyErrorMessage(cause, t("That did not save. Try again."))),
          )
          .finally(() => setBusy(false));
      }}
    >
      {saved ? (
        <IconBookmarkFilled size={13} aria-hidden />
      ) : (
        <IconBookmark size={13} aria-hidden />
      )}
    </button>
  );
}

/** "Open in canvas" and "Save" under a finished reply. */
export function ReplyLibraryActions({
  text,
  conversationId,
  messageId,
  className,
  onPress,
}: {
  text: string;
  conversationId?: string;
  messageId?: string;
  className: string;
  onPress?: () => void;
}) {
  const temporary = useIsTemporaryChat(conversationId);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (temporary || !text.trim()) return null;
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={t("Open in canvas")}
        title={error ?? t("Open in canvas")}
        data-failed={error ? true : undefined}
        disabled={opening}
        onClick={() => {
          onPress?.();
          setOpening(true);
          setError(null);
          void openReplyInCanvas({ text, conversationId, messageId })
            .catch((cause) =>
              setError(friendlyErrorMessage(cause, t("The canvas did not open. Try again."))),
            )
            .finally(() => setOpening(false));
        }}
      >
        <IconSidebarSimpleRightWide size={13} aria-hidden />
      </button>
      <SaveToggle
        request={replySaveRequest({ text, conversationId, messageId })}
        className={className}
        onPress={onPress}
      />
    </>
  );
}
