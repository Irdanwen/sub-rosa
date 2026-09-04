import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconPencilLine } from "central-icons/IconPencilLine";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconTrashCanSimple } from "central-icons/IconTrashCanSimple";
import type { FormEvent } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import {
  type MemoryDto,
  type MemorySettings,
  memoryAdd,
  memoryClear,
  memoryDelete,
  memoryList,
  memorySetSettings,
  memoryUpdate,
  listVeniceModels,
  type VeniceModelDto,
} from "../../lib/tauri";
import { Dialog, DialogField } from "../ui/Dialog";
import { Switch } from "../ui/Switch";

type Draft = {
  text: string;
};

const EMPTY_DRAFT: Draft = { text: "" };

export function MemorySettingsSection() {
  const [items, setItems] = useState<MemoryDto[]>([]);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [savingSettings, setSavingSettings] = useState(false);
  const extractionModelId = useId();
  const [extractionModels, setExtractionModels] = useState<VeniceModelDto[]>([]);
  useEffect(() => {
    let cancelled = false;
    // The text models the note generator can use are the ones extraction
    // can use; a catalog that cannot be read leaves only "same as the chat".
    Promise.resolve()
      .then(() => listVeniceModels("generation"))
      .then((response) => {
        if (!cancelled) setExtractionModels(response.models);
      })
      .catch(() => {
        if (!cancelled) setExtractionModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [confirmingClear, setConfirmingClear] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return items;
    return items.filter((item) => item.text.toLowerCase().includes(normalized));
  }, [items, query]);

  async function refresh() {
    try {
      const response = await memoryList();
      setItems(response.items);
      setSettings(response.settings);
      setError(undefined);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  async function updateSettings(next: MemorySettings) {
    setSavingSettings(true);
    try {
      setSettings(await memorySetSettings(next));
      setError(undefined);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSavingSettings(false);
    }
  }

  async function saveMemory() {
    const text = draft.text.trim();
    if (!text) return;
    try {
      const memory = editingId
        ? await memoryUpdate({ memoryId: editingId, text })
        : await memoryAdd(text);
      setItems((current) =>
        editingId
          ? current.map((item) => (item.id === memory.id ? memory : item))
          : [memory, ...current],
      );
      closeDialog();
    } catch (caught) {
      setSaveError(messageFromError(caught));
    }
  }

  async function toggleMemory(memory: MemoryDto, disabled: boolean) {
    try {
      const updated = await memoryUpdate({ memoryId: memory.id, disabled });
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setError(undefined);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  async function removeMemory(memoryId: string) {
    try {
      await memoryDelete(memoryId);
      setItems((current) => current.filter((item) => item.id !== memoryId));
      setError(undefined);
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
      setError(undefined);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  function startCreating() {
    setEditingId(undefined);
    setDraft(EMPTY_DRAFT);
    setSaveError(undefined);
    setDialogOpen(true);
  }

  function startEditing(memory: MemoryDto) {
    setEditingId(memory.id);
    setDraft({ text: memory.text });
    setSaveError(undefined);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setDraft(EMPTY_DRAFT);
    setEditingId(undefined);
    setSaveError(undefined);
  }

  const emptyMessage =
    items.length === 0
      ? "Nothing remembered yet. Facts are extracted automatically from your chats, or add one yourself."
      : `No memories match "${query.trim()}".`;

  return (
    <section className="settings-group" aria-labelledby="memory-heading">
      <h2 id="memory-heading" className="settings-group-heading">
        Memory
      </h2>
      <p className="settings-group-description">
        Sub Rosa remembers durable facts from your conversations, stored only on this device, and
        uses them so you never have to repeat yourself.
      </p>
      <div className="settings-card">
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">Use memory</h3>
              <p className="settings-row-description">
                Give the assistant your remembered facts in every conversation. Turning this off
                stops using memories but does not delete them.
              </p>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={settings?.enabled === true}
                disabled={settings === null || savingSettings}
                onCheckedChange={(enabled) =>
                  void updateSettings({
                    enabled,
                    autoExtract: settings?.autoExtract ?? true,
                    extractionModel: settings?.extractionModel,
                  })
                }
                aria-label="Use memory"
              />
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">Learn from conversations</h3>
              <p className="settings-row-description">
                Extract new facts automatically as you chat. Turn this off to only keep memories you
                add by hand.
              </p>
            </div>
            <div className="settings-row-control">
              <Switch
                checked={settings?.autoExtract === true}
                disabled={settings === null || savingSettings || settings?.enabled !== true}
                onCheckedChange={(autoExtract) =>
                  void updateSettings({
                    enabled: settings?.enabled ?? true,
                    autoExtract,
                    extractionModel: settings?.extractionModel,
                  })
                }
                aria-label="Learn from conversations"
              />
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-info">
              <label htmlFor={extractionModelId} className="settings-row-title">
                Extraction model
              </label>
              <p className="settings-row-description">
                Extraction is a short classification task, not a conversation; a smaller model does
                it for less. Leave it on the chat's model unless you have a reason.
              </p>
            </div>
            <div className="settings-row-control">
              <select
                id={extractionModelId}
                className="mcp-tools-select"
                value={settings?.extractionModel ?? ""}
                disabled={settings === null || savingSettings || settings?.enabled !== true}
                onChange={(event) =>
                  void updateSettings({
                    enabled: settings?.enabled ?? true,
                    autoExtract: settings?.autoExtract ?? true,
                    extractionModel: event.target.value || undefined,
                  })
                }
              >
                <option value="">Same as the chat</option>
                {extractionModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name || model.id}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>
      <div className="settings-card dictionary-card">
        <div className="dictionary-toolbar">
          <label className="folders-search">
            <IconMagnifyingGlass size={14} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search"
              aria-label="Search memories"
            />
          </label>
          <button type="button" className="primary-action primary-solid" onClick={startCreating}>
            <IconPlusMedium size={14} />
            Add memory
          </button>
        </div>
        {visibleItems.length === 0 ? (
          <p className="settings-empty">{emptyMessage}</p>
        ) : (
          <div className="settings-rows">
            {visibleItems.map((memory) => (
              <div key={memory.id} className="settings-row settings-row-compact">
                <div className="settings-row-info">
                  <h3 className="settings-row-title">{memory.text}</h3>
                  <p className="settings-row-description">
                    {memory.source === "manual" ? "Added by you" : "Learned from a conversation"}
                    {memory.disabled ? " · paused" : ""}
                  </p>
                </div>
                <div className="settings-row-control">
                  <Switch
                    checked={!memory.disabled}
                    onCheckedChange={(enabled) => void toggleMemory(memory, !enabled)}
                    aria-label={`Use "${memory.text}"`}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Edit "${memory.text}"`}
                    onClick={() => startEditing(memory)}
                  >
                    <IconPencilLine size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-button icon-button-destructive"
                    aria-label={`Delete "${memory.text}"`}
                    onClick={() => void removeMemory(memory.id)}
                  >
                    <IconTrashCanSimple size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {items.length > 0 ? (
          <div className="dictionary-toolbar">
            <button
              type="button"
              className="primary-action"
              onBlur={() => setConfirmingClear(false)}
              onClick={() => void clearAll()}
            >
              {confirmingClear ? "Click again to forget everything" : "Forget all memories"}
            </button>
          </div>
        ) : null}
      </div>
      {error ? <p className="settings-row-error">{error}</p> : null}

      <MemoryDialog
        open={dialogOpen}
        text={draft.text}
        editing={editingId !== undefined}
        error={saveError}
        onChange={(text) => {
          setDraft({ text });
          if (saveError) setSaveError(undefined);
        }}
        onClose={closeDialog}
        onSave={() => void saveMemory()}
      />
    </section>
  );
}

function MemoryDialog({
  open,
  text,
  editing,
  error,
  onChange,
  onClose,
  onSave,
}: {
  open: boolean;
  text: string;
  editing: boolean;
  error?: string;
  onChange: (text: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (text.trim()) onSave();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? "Edit memory" : "Add memory"}
      initialFocusSelector='input[name="memory-text"]'
      footer={
        <>
          <button type="button" className="primary-action" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="memory-form"
            className="primary-action primary-solid"
            disabled={text.trim().length === 0}
          >
            {editing ? "Save changes" : "Add memory"}
          </button>
        </>
      }
    >
      <form id="memory-form" className="dialog-body" onSubmit={handleSubmit}>
        <DialogField label="Fact to remember" htmlFor="memory-text">
          <input
            id="memory-text"
            name="memory-text"
            className="dialog-input"
            value={text}
            onChange={(event) => onChange(event.currentTarget.value)}
            placeholder="e.g. I prefer answers in French"
            autoComplete="off"
            maxLength={2000}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "memory-text-error" : undefined}
          />
        </DialogField>
        {error ? (
          <p id="memory-text-error" className="settings-row-error">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

function messageFromError(caught: unknown) {
  if (caught && typeof caught === "object" && "message" in caught) {
    return String((caught as { message: unknown }).message);
  }
  return String(caught);
}
