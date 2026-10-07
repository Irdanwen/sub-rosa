import "../../styles/personalization.css";
import { IconBookmark } from "central-icons/IconBookmark";
import { useEffect, useRef, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { hapticSelection } from "../../lib/haptics";
import { t } from "../../lib/i18n";
import { useModalFocus } from "../../lib/modal-focus";
import {
  memorySourcesForTask,
  type TurnMemorySources,
  turnIdForReply,
} from "../../lib/personalization";
import { type MemoryDto, memoryDelete, memoryUpdate } from "../../lib/tauri";

/**
 * "Used 3 memories" under a phone reply (ADR-0081): which remembered facts
 * that turn carried. Tapping it lists them, each readable in full and
 * pausable or forgettable on the spot.
 *
 * Every reply of a chat asks the same question, so one fetch per chat and
 * message count is shared between them.
 */
const fetches = new Map<string, Promise<TurnMemorySources[]>>();

function sourcesFor(taskId: string, version: number): Promise<TurnMemorySources[]> {
  const key = `${taskId}:${version}`;
  let pending = fetches.get(key);
  if (!pending) {
    for (const stale of fetches.keys()) {
      if (stale.startsWith(`${taskId}:`)) fetches.delete(stale);
    }
    // Memory sources are an enrichment: no answer means no chip, never an error.
    pending = Promise.resolve()
      .then(() => memorySourcesForTask(taskId))
      .catch(() => []);
    fetches.set(key, pending);
  }
  return pending;
}

export function MemorySourcesChip({
  task,
  messageId,
}: {
  task?: { id: string; messages: { id: string; role: string }[] } | null;
  messageId: string;
}) {
  const taskId = task?.id ?? "";
  const count = task?.messages.length ?? 0;
  const turnId = task ? turnIdForReply(task.messages, messageId) : undefined;
  const [memories, setMemories] = useState<MemoryDto[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!turnId) return;
    let cancelled = false;
    void sourcesFor(taskId, count).then((turns) => {
      if (cancelled) return;
      setMemories(turns.find((turn) => turn.turnId === turnId)?.memories ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId, turnId, count]);

  if (!turnId || memories.length === 0) return null;

  return (
    <>
      <button
        type="button"
        className="memory-sources-chip"
        onClick={() => {
          hapticSelection();
          setOpen(true);
        }}
      >
        <IconBookmark size={13} aria-hidden />
        {memories.length === 1
          ? t("Used 1 memory")
          : t("Used {count} memories", { count: memories.length })}
      </button>
      {open ? (
        <MemorySourcesSheet
          memories={memories}
          onChange={(next) => {
            setMemories(next);
            fetches.clear();
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

export function MemorySourcesSheet({
  memories,
  onChange,
  onClose,
}: {
  memories: MemoryDto[];
  onChange: (memories: MemoryDto[]) => void;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useModalFocus(sheetRef, { onClose });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function togglePause(memory: MemoryDto) {
    try {
      const updated = await memoryUpdate({ memoryId: memory.id, disabled: !memory.disabled });
      onChange(memories.map((item) => (item.id === updated.id ? updated : item)));
      setError(null);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  async function forget(memory: MemoryDto) {
    try {
      await memoryDelete(memory.id);
      onChange(memories.filter((item) => item.id !== memory.id));
      setError(null);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  return (
    <div className="mobile-sheet-backdrop">
      <button
        type="button"
        className="mobile-sheet-dismiss"
        aria-label={t("Close")}
        onClick={onClose}
      />
      <div
        className="mobile-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t("Memories used in this reply")}
        ref={sheetRef}
        tabIndex={-1}
      >
        <span className="mobile-sheet-grabber" aria-hidden />
        <p className="mobile-sheet-title">{t("Memories used in this reply")}</p>
        {memories.length === 0 ? (
          <p className="memory-sources-empty">{t("You forgot every memory this reply used.")}</p>
        ) : (
          <ul className="memory-sources-list">
            {memories.map((memory) => {
              const isOpen = expanded === memory.id;
              return (
                <li key={memory.id} className="memory-sources-item">
                  <p className="memory-sources-text" data-collapsed={isOpen ? undefined : true}>
                    {memory.text}
                  </p>
                  <div className="memory-sources-actions">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => setExpanded(isOpen ? null : memory.id)}
                    >
                      {isOpen ? t("Show less") : t("Open")}
                    </button>
                    <button type="button" onClick={() => void togglePause(memory)}>
                      {memory.disabled ? t("Resume") : t("Pause")}
                    </button>
                    <button
                      type="button"
                      data-tone="destructive"
                      onClick={() => void forget(memory)}
                    >
                      {t("Forget")}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {error ? <p className="memory-sources-empty">{error}</p> : null}
      </div>
    </div>
  );
}
