import { useCallback, useEffect, useState } from "react";
import { useAccountSyncUpdated } from "../../lib/account-sync-events";
import { type ChatSessionItem, listChatSessions } from "../../lib/chat-titles";
import { t } from "../../lib/i18n";
import { listSessionFolders } from "../../lib/tauri";
import { formatNoteTime } from "./screens/NoteRow";

/** The chats filed in a project, newest first, on the phone's folder screen
 * (ADR-0085). A chat's own screen does the rest. */
export function ProjectChats({
  folderId,
  onOpenChat,
}: {
  folderId: string;
  onOpenChat: (taskId: string) => void;
}) {
  const [chats, setChats] = useState<ChatSessionItem[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [sessions, rows] = await Promise.all([listChatSessions(), listSessionFolders()]);
      const filed = new Set(
        rows.filter((row) => row.folderId === folderId).map((row) => row.sessionId),
      );
      setChats(
        sessions
          .filter((session) => filed.has(session.id))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      );
    } catch {
      // The notes below still show; an empty section is the honest fallback.
      setChats([]);
    }
  }, [folderId]);

  useAccountSyncUpdated(refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (chats.length === 0) return null;
  return (
    <section aria-label={t("Chats")}>
      <h2 className="mobile-list-section-title">{t("Chats")}</h2>
      <ul className="mobile-note-list">
        {chats.map((chat) => {
          const title = chat.title.trim() || chat.prompt.trim() || t("New chat");
          const time = formatNoteTime(chat.updatedAt);
          return (
            <li key={chat.id}>
              <button
                type="button"
                className="mobile-note-row mobile-chat-row"
                aria-label={[title, time].filter(Boolean).join(", ")}
                onClick={() => onOpenChat(chat.id)}
              >
                <span className="mobile-note-row-body">
                  <span className="mobile-note-row-title mobile-chat-row-title">{title}</span>
                  {chat.lastMessagePreview ? (
                    <span className="mobile-note-row-subtitle">{chat.lastMessagePreview}</span>
                  ) : null}
                </span>
                <span className="mobile-note-row-time">{time}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
