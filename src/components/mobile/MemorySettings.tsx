import { useEffect, useState } from "react";
import { hapticSelection } from "../../lib/haptics";
import {
  type MemoryDto,
  type MemorySettings as MemorySettingsDto,
  memoryAdd,
  memoryClear,
  memoryDelete,
  memoryList,
  memorySetSettings,
  memoryUpdate,
} from "../../lib/tauri";

/**
 * Mobile memory management: the same store as the desktop Memory tab, sized
 * for a phone column — two toggles, a one-line add field, and the list with
 * per-memory pause and delete.
 */
export function MemorySettings() {
  const [items, setItems] = useState<MemoryDto[]>([]);
  const [settings, setSettings] = useState<MemorySettingsDto | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    try {
      const response = await memoryList();
      setItems(response.items);
      setSettings(response.settings);
      setError(null);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  async function updateSettings(next: MemorySettingsDto) {
    hapticSelection();
    try {
      setSettings(await memorySetSettings(next));
      setError(null);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  async function addMemory() {
    const text = draft.trim();
    if (!text) return;
    try {
      const memory = await memoryAdd(text);
      setItems((current) => [memory, ...current]);
      setDraft("");
      setError(null);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  async function toggleMemory(memory: MemoryDto) {
    hapticSelection();
    try {
      const updated = await memoryUpdate({ memoryId: memory.id, disabled: !memory.disabled });
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setError(null);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  async function removeMemory(memory: MemoryDto) {
    try {
      await memoryDelete(memory.id);
      setItems((current) => current.filter((item) => item.id !== memory.id));
      setError(null);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  async function clearAll() {
    if (!confirmingClear) {
      setConfirmingClear(true);
      return;
    }
    setConfirmingClear(false);
    try {
      await memoryClear();
      setItems([]);
      setError(null);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  return (
    <div className="mobile-memory">
      <label className="mobile-toggle-row">
        <input
          type="checkbox"
          checked={settings?.enabled === true}
          disabled={settings === null}
          onChange={(event) =>
            void updateSettings({
              enabled: event.target.checked,
              autoExtract: settings?.autoExtract ?? true,
            })
          }
        />
        <span>Use memory in chats</span>
      </label>
      <label className="mobile-toggle-row">
        <input
          type="checkbox"
          checked={settings?.autoExtract === true}
          disabled={settings === null || settings?.enabled !== true}
          onChange={(event) =>
            void updateSettings({
              enabled: settings?.enabled ?? true,
              autoExtract: event.target.checked,
            })
          }
        />
        <span>Learn from conversations</span>
      </label>
      <form
        className="mobile-memory-add"
        onSubmit={(event) => {
          event.preventDefault();
          void addMemory();
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder="Add a fact to remember"
          aria-label="Add a fact to remember"
          maxLength={2000}
        />
        <button type="submit" disabled={draft.trim().length === 0}>
          Add
        </button>
      </form>
      {items.length === 0 ? (
        <p className="mobile-memory-empty">
          Nothing remembered yet. Facts are extracted automatically from your chats, or add one
          above.
        </p>
      ) : (
        <ul className="mobile-memory-list">
          {items.map((memory) => (
            <li key={memory.id} className="mobile-memory-row" data-paused={memory.disabled}>
              <div className="mobile-memory-row-main">
                <span className="mobile-memory-text">{memory.text}</span>
                <span className="mobile-memory-meta">
                  {memory.source === "manual" ? "Added by you" : "Learned from a conversation"}
                  {memory.disabled ? " · paused" : ""}
                </span>
              </div>
              <div className="mobile-memory-row-actions">
                <button type="button" onClick={() => void toggleMemory(memory)}>
                  {memory.disabled ? "Resume" : "Pause"}
                </button>
                <button
                  type="button"
                  className="mobile-memory-delete"
                  onClick={() => void removeMemory(memory)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 ? (
        <button
          type="button"
          className="mobile-memory-clear"
          onBlur={() => setConfirmingClear(false)}
          onClick={() => void clearAll()}
        >
          {confirmingClear ? "Tap again to forget everything" : "Forget all memories"}
        </button>
      ) : null}
      {error ? <p className="mobile-memory-error">{error}</p> : null}
    </div>
  );
}

function messageFromError(caught: unknown) {
  if (caught && typeof caught === "object" && "message" in caught) {
    return String((caught as { message: unknown }).message);
  }
  return String(caught);
}
