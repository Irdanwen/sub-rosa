import { useEffect, useState } from "react";
import { messageFromError } from "../../../lib/errors";
import {
  type MemoryDto,
  type MemorySettings,
  memoryAdd,
  memoryClear,
  memoryDelete,
  memoryList,
  memorySetSettings,
  memoryUpdate,
} from "../../../lib/tauri";
import { SettingsActionRow, SettingsGroup, SettingsRow, SettingsToggleRow } from "../SettingsList";
import { StackHeader } from "../StackHeader";
import { SwipeableRow } from "../SwipeableRow";

/**
 * Memory, as its own pushed screen.
 *
 * It used to be a section inlined on the Settings root, which meant the list
 * grew without bound between the theme picker and the connection controls.
 * Here it owns the screen, so the list can be as long as it is, and each row
 * carries its actions behind a swipe instead of two permanent text buttons.
 */
export function MemoryScreen({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<MemoryDto[]>([]);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
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

  async function updateSettings(next: MemorySettings) {
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

  const enabled = settings?.enabled === true;

  return (
    <div className="mobile-screen-root">
      <StackHeader title="Memory" onBack={onBack} backLabel="Settings" />
      <div className="mobile-settings-scroll">
        <SettingsGroup footer="Sub Rosa remembers durable facts about you and uses them in future conversations. Turning memory off stops it being used but never deletes anything.">
          <SettingsToggleRow
            label="Use memory in chats"
            checked={enabled}
            disabled={settings === null}
            onChange={(next) =>
              void updateSettings({ enabled: next, autoExtract: settings?.autoExtract ?? true })
            }
          />
          <SettingsToggleRow
            label="Learn from conversations"
            detail="Pick up new facts automatically"
            checked={settings?.autoExtract === true}
            disabled={settings === null || !enabled}
            onChange={(next) =>
              void updateSettings({ enabled: settings?.enabled ?? true, autoExtract: next })
            }
          />
        </SettingsGroup>

        <SettingsGroup title="Add a fact">
          <SettingsRow align="stack">
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
                placeholder="Something to remember"
                aria-label="Add a fact to remember"
                maxLength={2000}
              />
              <button type="submit" disabled={draft.trim().length === 0}>
                Add
              </button>
            </form>
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup
          title={items.length > 0 ? `Remembered · ${items.length}` : "Remembered"}
          footer={items.length > 0 ? "Swipe a memory to pause or forget it." : undefined}
        >
          {items.length === 0 ? (
            <p className="mobile-memory-empty">
              Nothing remembered yet. Facts are picked up from your chats, or add one above.
            </p>
          ) : (
            items.map((memory) => (
              <SwipeableRow
                key={memory.id}
                actions={[
                  {
                    label: memory.disabled ? "Resume" : "Pause",
                    tone: "neutral",
                    onAction: () => void toggleMemory(memory),
                  },
                  {
                    label: "Forget",
                    tone: "destructive",
                    onAction: () => void removeMemory(memory),
                  },
                ]}
              >
                <div className="mobile-memory-row" data-paused={memory.disabled}>
                  <span className="mobile-memory-text">{memory.text}</span>
                  <span className="mobile-memory-meta">
                    {memory.source === "manual" ? "Added by you" : "Learned from a conversation"}
                    {memory.disabled ? " · paused" : ""}
                  </span>
                </div>
              </SwipeableRow>
            ))
          )}
        </SettingsGroup>

        {items.length > 0 ? (
          <SettingsGroup>
            <SettingsActionRow
              label={confirmingClear ? "Tap again to forget everything" : "Forget all memories"}
              tone="destructive"
              onClick={() => void clearAll()}
            />
          </SettingsGroup>
        ) : null}

        {error ? <p className="mobile-memory-error">{error}</p> : null}
      </div>
    </div>
  );
}
