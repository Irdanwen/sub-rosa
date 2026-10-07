import "../../styles/personalization.css";
import { IconBookmark } from "central-icons/IconBookmark";
import { useEffect, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { memorySourcesForSession, sessionStartMs } from "../../lib/personalization";
import { type HermesSessionInfo, type MemoryDto, memoryDelete } from "../../lib/tauri";
import { Dialog } from "../ui/Dialog";
import { isProvisionalHermesSessionId } from "./hero-content";

/**
 * "Memory in this chat" at the head of a desktop conversation (ADR-0081).
 *
 * The desktop agent gets its memories once, in the SOUL its runtime starts
 * with, so what a chat carries is the set that runtime was given. The app
 * records it against the stored session id the first time the chat is shown;
 * a chat older than the running runtime shows nothing rather than a guess.
 * Facts the agent looks up mid-chat with search_user_memories are not listed.
 */
export function MemoryInChatIndicator({ session }: { session?: HermesSessionInfo }) {
  const sessionId = session && !isProvisionalHermesSessionId(session.id) ? session.id : undefined;
  const startedAt = sessionStartMs(session?.started_at ?? session?.startedAt);
  const turns = session?.message_count;
  const [memories, setMemories] = useState<MemoryDto[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    // A chat with no message yet has nothing to bind: its runtime may not
    // even be running.
    if (!sessionId || turns === 0) {
      setMemories([]);
      return;
    }
    let cancelled = false;
    // Asked again as the chat grows: the runtime may only have started with
    // its first message. Best-effort, a failure just shows nothing.
    void Promise.resolve()
      .then(() => memorySourcesForSession(sessionId, startedAt))
      .then((sources) => {
        if (!cancelled) setMemories(sources.memories);
      })
      .catch(() => {
        if (!cancelled) setMemories([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, startedAt, turns]);

  if (!sessionId || memories.length === 0) return null;

  async function forget(memory: MemoryDto) {
    try {
      await memoryDelete(memory.id);
      setMemories((current) => current.filter((item) => item.id !== memory.id));
      setError(undefined);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  return (
    <div className="memory-in-chat">
      <button
        type="button"
        className="agent-session-workdir"
        title={t("The remembered facts this chat started with")}
        onClick={() => setOpen(true)}
      >
        <IconBookmark size={13} aria-hidden />
        {t("Memory in this chat · {count}", { count: memories.length })}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("Memory in this chat")}
        description={t(
          "This chat started with these facts. Forgetting one removes it from your memory; this chat keeps what it already read.",
        )}
        footer={
          <button type="button" className="primary-action" onClick={() => setOpen(false)}>
            {t("Close")}
          </button>
        }
      >
        <ul className="memory-sources-list">
          {memories.map((memory) => (
            <li key={memory.id} className="memory-sources-item">
              <p className="memory-sources-text">{memory.text}</p>
              <div className="memory-sources-actions">
                <button type="button" data-tone="destructive" onClick={() => void forget(memory)}>
                  {t("Forget")}
                </button>
              </div>
            </li>
          ))}
        </ul>
        {error ? <p className="settings-row-error">{error}</p> : null}
      </Dialog>
    </div>
  );
}
