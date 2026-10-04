// An assistant's settings on the phone, laid out the way iOS lays out
// settings: who it is at the top, then one row per thing it can be told,
// each opening what it needs (a model sheet, a full-screen text, the
// references). Unsaved edits are kept on the device as they are typed, so a
// tab switch or a dropped webview loses nothing; they are offered back the
// next time the assistant is opened.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AssistantDefinition,
  type AssistantTool,
  deleteAssistant,
  emptyAssistant,
  listAssistantReferences,
  listAssistants,
  saveAssistant,
} from "../../../../lib/assistants";
import {
  clearEditorDraft,
  readEditorDraft,
  writeEditorDraft,
} from "../../../../lib/assistant-draft";
import { messageFromError } from "../../../../lib/errors";
import { hapticNotify } from "../../../../lib/haptics";
import { intlLocale, t } from "../../../../lib/i18n";
import { useKeyboardInset } from "../../../../lib/keyboard-inset";
import { readableModelName } from "../../../../lib/model-names";
import { listVeniceModels, type VeniceModelDto } from "../../../../lib/tauri";
import { Spinner } from "../../../ui/Spinner";
import { ActionSheet } from "../../ActionSheet";
import { ModelSheet } from "../../ModelSheet";
import {
  SettingsActionRow,
  SettingsGroup,
  SettingsLinkRow,
  SettingsToggleRow,
} from "../../SettingsList";
import { StackHeader } from "../../StackHeader";
import { AssistantAvatar, AvatarSheet } from "./AssistantAvatar";
import { toolLabel } from "./AssistantChatScreen";

/** What the definition accepts, in bytes (`assistants::save`). */
const INSTRUCTIONS_LIMIT = 64_000;
const OPENING_LIMIT = 8_000;
const DESCRIPTION_LIMIT = 4_000;

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** The order the definition stores tools in, so toggling one off and on again
 * does not read as a change. */
const sortTools = (tools: AssistantTool[]) => [...new Set(tools)].sort();

type Sheet = "model" | "avatar" | "save-first" | "leave" | "delete" | null;
type Page = "instructions" | "opening" | null;

export function AssistantEditor({
  assistantId,
  onBack,
  onSaved,
  onTry,
  onOpenReferences,
  onDeleted,
}: {
  /** Absent for a new assistant (which may arrive drafted by the creator). */
  assistantId?: string;
  onBack: () => void;
  /** A new assistant was saved for the first time and now has an id. */
  onSaved?: (assistant: AssistantDefinition) => void;
  onTry: (assistantId: string) => void;
  onOpenReferences: (assistantId: string, assistantName: string) => void;
  onDeleted: () => void;
}) {
  const draftKey = assistantId ?? "";
  const [saved, setSaved] = useState<AssistantDefinition | null>(null);
  const [draft, setDraft] = useState<AssistantDefinition | null>(null);
  const [restored, setRestored] = useState(false);
  const [referenceCount, setReferenceCount] = useState<number | null>(null);
  const [models, setModels] = useState<VeniceModelDto[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [page, setPage] = useState<Page>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyboardInset = useKeyboardInset();
  const leaving = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const found = assistantId
          ? ((await listAssistants()).find((entry) => entry.id === assistantId) ?? null)
          : null;
        if (cancelled) return;
        if (assistantId && !found) {
          setError(t("This assistant no longer exists."));
          return;
        }
        const base = found ?? emptyAssistant();
        const stored = readEditorDraft(draftKey, base.revision);
        const differs = stored && JSON.stringify(stored.definition) !== JSON.stringify(base);
        setSaved(found);
        setDraft(differs && stored ? stored.definition : base);
        // A creator's draft is new by nature; only edits are "restored".
        setRestored(Boolean(differs && found));
      } catch (err) {
        if (!cancelled) setError(messageFromError(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assistantId, draftKey]);

  useEffect(() => {
    void listVeniceModels("generation")
      .then((result) => setModels(result.models))
      .catch((err) => setModelsError(messageFromError(err)));
  }, []);

  const savedId = saved?.id ?? "";
  useEffect(() => {
    if (!savedId) return;
    void listAssistantReferences(savedId)
      .then((rows) => setReferenceCount(rows.length))
      .catch(() => setReferenceCount(null));
  }, [savedId]);

  const base = saved ?? emptyAssistant();
  const dirty = Boolean(draft && JSON.stringify(draft) !== JSON.stringify(base));

  // Every edit lands on the device a moment after it is typed.
  useEffect(() => {
    if (!draft || leaving.current) return;
    const timer = window.setTimeout(() => {
      if (leaving.current) return;
      if (dirty) writeEditorDraft(draftKey, { definition: draft, baseRevision: base.revision });
      else clearEditorDraft(draftKey);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, draftKey, base.revision]);

  const patch = useCallback((value: Partial<AssistantDefinition>) => {
    setDraft((current) => (current ? { ...current, ...value } : current));
  }, []);

  const save = async (): Promise<AssistantDefinition | null> => {
    if (!draft || busy) return null;
    setBusy(true);
    setError(null);
    try {
      const result = await saveAssistant({ ...draft, tools: sortTools(draft.tools) });
      clearEditorDraft(draftKey);
      if (!saved) clearEditorDraft("");
      setSaved(result);
      setDraft(result);
      setRestored(false);
      hapticNotify("success");
      if (!saved) onSaved?.(result);
      return result;
    } catch (err) {
      setError(messageFromError(err));
      hapticNotify("error");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const leave = (discard: boolean) => {
    if (discard) {
      leaving.current = true;
      clearEditorDraft(draftKey);
    }
    onBack();
  };

  const discardRestored = () => {
    clearEditorDraft(draftKey);
    setDraft(base);
    setRestored(false);
  };

  const modelEntries = useMemo(
    () =>
      models.map((entry) => ({
        id: entry.id,
        name: readableModelName(entry.id, entry.name),
        keywords: [entry.name],
      })),
    [models],
  );

  if (!draft) {
    return (
      <div className="mobile-screen-root">
        <StackHeader title={t("Assistant")} onBack={onBack} backLabel={t("Back")} />
        <div className="mobile-scroll">
          {error ? (
            <p className="mobile-dictation-error" role="alert">
              {error}
            </p>
          ) : (
            <Spinner aria-label={t("Loading")} />
          )}
        </div>
      </div>
    );
  }

  const canSave = dirty && Boolean(draft.name.trim()) && !busy;
  const title = saved ? draft.name.trim() || t("Assistant") : t("New assistant");
  const modelName = draft.model
    ? readableModelName(draft.model, models.find((entry) => entry.id === draft.model)?.name)
    : t("Default");

  if (page) {
    const instructions = page === "instructions";
    const value = instructions ? draft.instructions : draft.opening_message;
    const limit = instructions ? INSTRUCTIONS_LIMIT : OPENING_LIMIT;
    const used = bytes(value);
    return (
      <div className="mobile-screen-root">
        <StackHeader
          title={instructions ? t("Instructions") : t("Opening message")}
          onBack={() => setPage(null)}
          backLabel={title}
        />
        <div
          className="mobile-assistant-page-body"
          style={keyboardInset ? { paddingBottom: keyboardInset } : undefined}
        >
          <textarea
            className="mobile-assistant-page-field"
            value={value}
            aria-label={instructions ? t("Instructions") : t("Opening message")}
            placeholder={
              instructions
                ? t("Describe how your assistant should think, speak and work.")
                : t("The first thing your assistant says in a new conversation.")
            }
            onChange={(event) =>
              patch(
                instructions
                  ? { instructions: event.target.value }
                  : { opening_message: event.target.value },
              )
            }
          />
          <p className="mobile-assistant-page-meta" data-over={used > limit ? "true" : undefined}>
            {instructions
              ? t(
                  "Changes apply to new conversations. Existing conversations keep the version they started with.",
                )
              : null}
            <span>
              {used.toLocaleString(intlLocale())} / {limit.toLocaleString(intlLocale())}
            </span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mobile-screen-root">
      <StackHeader
        title={title}
        onBack={() => (dirty ? setSheet("leave") : leave(false))}
        backLabel={t("Back")}
        trailing={
          <button
            type="button"
            className="mobile-header-text-button"
            disabled={!canSave}
            onClick={() => void save()}
          >
            {busy ? t("Saving…") : t("Save")}
          </button>
        }
      />
      <div
        className="mobile-scroll mobile-assistant-editor"
        style={keyboardInset ? { paddingBottom: keyboardInset } : undefined}
      >
        {restored ? (
          <p className="mobile-assistant-flow-note" role="status">
            {t("Your unsaved changes were restored.")}{" "}
            <button type="button" className="mobile-assistant-flow-link" onClick={discardRestored}>
              {t("Discard them")}
            </button>
          </p>
        ) : null}
        {error ? (
          <p className="mobile-dictation-error" role="alert">
            {error}
          </p>
        ) : null}

        <section className="mobile-assistant-identity">
          <button
            type="button"
            className="mobile-assistant-identity-face"
            aria-label={t("Change the avatar")}
            onClick={() => setSheet(saved && !dirty ? "avatar" : "save-first")}
          >
            <AssistantAvatar assistant={draft} size={84} />
            <span>{t("Edit")}</span>
          </button>
          <input
            className="mobile-assistant-identity-name"
            value={draft.name}
            maxLength={120}
            aria-label={t("Name")}
            placeholder={t("Name")}
            onChange={(event) => patch({ name: event.target.value })}
          />
          <textarea
            className="mobile-assistant-identity-description"
            value={draft.description}
            rows={2}
            maxLength={DESCRIPTION_LIMIT}
            aria-label={t("Description")}
            placeholder={t("What it helps with, in a sentence")}
            onChange={(event) => patch({ description: event.target.value })}
          />
        </section>

        <SettingsGroup title={t("Behaviour")}>
          <SettingsLinkRow label={t("Model")} value={modelName} onClick={() => setSheet("model")} />
          <SettingsLinkRow
            label={t("Instructions")}
            value={
              draft.instructions.trim()
                ? t("{count} characters", {
                    count: draft.instructions.length.toLocaleString(intlLocale()),
                  })
                : t("None")
            }
            onClick={() => setPage("instructions")}
          />
          <SettingsLinkRow
            label={t("Opening message")}
            value={draft.opening_message.trim() ? t("Written") : t("None")}
            onClick={() => setPage("opening")}
          />
        </SettingsGroup>

        <SettingsGroup
          title={t("Knowledge")}
          footer={
            saved
              ? t("Text, PDF, images, Office documents and notes your assistant can read.")
              : t("Save your assistant before adding references.")
          }
        >
          <SettingsLinkRow
            label={t("References")}
            value={saved ? (referenceCount ?? "") : ""}
            onClick={() =>
              saved ? onOpenReferences(saved.id, saved.name) : setSheet("save-first")
            }
          />
          <SettingsToggleRow
            label={t("Access my notes")}
            detail={t("Search and read your notes when a request needs them.")}
            checked={draft.allow_notes}
            onChange={(next) => patch({ allow_notes: next })}
          />
          <SettingsToggleRow
            label={t("Use my personal memory")}
            detail={t("Recall and remember facts about you when Memory is enabled in settings.")}
            checked={draft.allow_memory}
            onChange={(next) => patch({ allow_memory: next })}
          />
        </SettingsGroup>

        <SettingsGroup
          title={t("Tools")}
          footer={t("Media generation always asks you to confirm before spending credits.")}
        >
          {(["web", "image", "video", "music", "speech"] as const).map((tool) => (
            <SettingsToggleRow
              key={tool}
              label={toolLabel(tool)}
              detail={toolDetail(tool)}
              checked={draft.tools.includes(tool)}
              onChange={(next) =>
                patch({
                  tools: sortTools(
                    next ? [...draft.tools, tool] : draft.tools.filter((id) => id !== tool),
                  ),
                })
              }
            />
          ))}
        </SettingsGroup>

        {saved ? (
          <SettingsGroup>
            <SettingsActionRow
              label={dirty ? t("Save, then try it") : t("Try it")}
              disabled={busy || !draft.name.trim()}
              onClick={async () => {
                const ready = dirty ? await save() : saved;
                if (ready) onTry(ready.id);
              }}
            />
            <SettingsActionRow
              label={t("Delete assistant")}
              tone="destructive"
              disabled={busy}
              onClick={() => setSheet("delete")}
            />
          </SettingsGroup>
        ) : null}
      </div>

      {sheet === "model" ? (
        <ModelSheet
          title={t("Assistant model")}
          entries={modelEntries}
          selectedId={draft.model}
          defaultOption={{ label: t("Default"), subtitle: t("Recommended model") }}
          error={modelsError}
          onSelect={(id) => {
            patch({ model: id });
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === "avatar" && saved ? (
        <AvatarSheet
          assistant={saved}
          onChanged={(next) => {
            setSaved(next);
            setDraft(next);
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === "save-first" ? (
        <ActionSheet
          title={saved ? t("Save your changes first") : t("Save your assistant first")}
          subtitle={t("A picture and references belong to a saved assistant.")}
          actions={
            draft.name.trim()
              ? [
                  {
                    label: t("Save"),
                    onAction: () => void save(),
                  },
                ]
              : []
          }
          closeLabel={draft.name.trim() ? t("Cancel") : t("OK")}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === "leave" ? (
        <ActionSheet
          title={t("Save your changes?")}
          subtitle={t("They stay on this device until you save or discard them.")}
          actions={[
            ...(draft.name.trim()
              ? [
                  {
                    label: t("Save"),
                    onAction: () =>
                      void save().then((result) => {
                        if (result) leave(false);
                      }),
                  },
                ]
              : []),
            { label: t("Discard changes"), destructive: true, onAction: () => leave(true) },
          ]}
          closeLabel={t("Keep editing")}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === "delete" && saved ? (
        <ActionSheet
          title={t("Delete this assistant?")}
          subtitle={t(
            "Your existing conversations remain available. The assistant and its references are removed.",
          )}
          actions={[
            {
              label: t("Delete"),
              destructive: true,
              onAction: () =>
                void deleteAssistant(saved)
                  .then(() => {
                    leaving.current = true;
                    clearEditorDraft(draftKey);
                    onDeleted();
                  })
                  .catch((err) => setError(messageFromError(err))),
            },
          ]}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </div>
  );
}

function toolDetail(tool: AssistantTool): string {
  switch (tool) {
    case "web":
      return t("Find current information and sources on the web.");
    case "image":
      return t("Propose images, edits and enlarged images.");
    case "video":
      return t("Propose video clips from your ideas.");
    case "music":
      return t("Propose songs and instrumental tracks.");
    case "speech":
      return t("Propose spoken audio from your text.");
  }
}
