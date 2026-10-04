// The Assistants tab on the phone: your assistants, the conversations you had
// with them lately, and ideas to start from. A tap talks to an assistant; a
// long press offers the rest (edit, duplicate, delete).

import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccountSyncUpdated } from "../../../../lib/account-sync-events";
import {
  type AssistantConversation,
  type AssistantDefinition,
  deleteAssistant,
  duplicateAssistant,
  listAssistantArchive,
  listAssistants,
} from "../../../../lib/assistants";
import { messageFromError } from "../../../../lib/errors";
import { hapticNotify } from "../../../../lib/haptics";
import { t } from "../../../../lib/i18n";
import { useLongPress } from "../../../../lib/long-press";
import { BrandMark } from "../../../brand/Marks";
import { assistantTemplates } from "../../../assistants/templates";
import { ActionSheet } from "../../ActionSheet";
import { PullToRefresh } from "../../PullToRefresh";
import { StackHeader } from "../../StackHeader";
import { formatNoteTime } from "../NoteRow";
import { AssistantAvatar } from "./AssistantAvatar";

/** From this many assistants on, a search field earns its place. */
const SEARCH_FROM = 6;
const RECENT = 5;

type Sheet =
  | { kind: "actions"; assistant: AssistantDefinition }
  | { kind: "delete"; assistant: AssistantDefinition }
  | null;

export function AssistantsHome({
  onOpenChat,
  onOpenConversation,
  onCreate,
  onEdit,
  onOpenHistory,
}: {
  onOpenChat: (assistantId: string) => void;
  onOpenConversation: (taskId: string) => void;
  /** The guided creator, from scratch or from a template's idea. */
  onCreate: (idea?: string) => void;
  onEdit: (assistantId: string) => void;
  onOpenHistory: () => void;
}) {
  const [assistants, setAssistants] = useState<AssistantDefinition[] | null>(null);
  const [conversations, setConversations] = useState<AssistantConversation[]>([]);
  const [query, setQuery] = useState("");
  const [sheet, setSheet] = useState<Sheet>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [definitions, archive] = await Promise.all([listAssistants(), listAssistantArchive()]);
      setAssistants(definitions);
      setConversations(archive);
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
      setAssistants((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useAccountSyncUpdated(refresh);

  // The last time each assistant was talked to: the list is ordered by it.
  const lastTalked = useMemo(() => {
    const latest = new Map<string, string>();
    for (const { task, definition } of conversations) {
      const seen = latest.get(definition.id);
      if (!seen || task.updatedAt > seen) latest.set(definition.id, task.updatedAt);
    }
    return latest;
  }, [conversations]);

  const ordered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...(assistants ?? [])]
      .filter(
        (assistant) =>
          !needle ||
          assistant.name.toLocaleLowerCase().includes(needle) ||
          assistant.description.toLocaleLowerCase().includes(needle),
      )
      .sort((a, b) =>
        (lastTalked.get(b.id) ?? b.updated_at).localeCompare(lastTalked.get(a.id) ?? a.updated_at),
      );
  }, [assistants, lastTalked, query]);

  const byId = useMemo(
    () => new Map((assistants ?? []).map((assistant) => [assistant.id, assistant])),
    [assistants],
  );

  const remove = async (assistant: AssistantDefinition) => {
    try {
      await deleteAssistant(assistant);
      hapticNotify("success");
      await refresh();
    } catch (err) {
      setError(messageFromError(err));
    }
  };

  const duplicate = async (assistant: AssistantDefinition) => {
    try {
      await duplicateAssistant(assistant.id);
      await refresh();
    } catch (err) {
      setError(messageFromError(err));
    }
  };

  const empty = assistants !== null && assistants.length === 0;
  const recent = conversations.slice(0, RECENT);

  return (
    <div className="mobile-screen-root">
      <StackHeader
        title={t("Assistants")}
        large
        trailing={
          <button
            type="button"
            className="mobile-icon-button"
            aria-label={t("New assistant")}
            onClick={() => onCreate()}
          >
            <IconPlusMedium size={20} />
          </button>
        }
      />
      {(assistants?.length ?? 0) >= SEARCH_FROM ? (
        <div className="mobile-search">
          <IconMagnifyingGlass size={16} aria-hidden />
          <input
            type="search"
            placeholder={t("Search assistants")}
            aria-label={t("Search assistants")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
          />
        </div>
      ) : null}
      <PullToRefresh className="mobile-list-scroll" onRefresh={refresh}>
        {error ? (
          <p className="mobile-dictation-error" role="alert">
            {error}
          </p>
        ) : null}
        {assistants === null ? (
          <ul className="mobile-note-list" aria-hidden>
            {[0, 1, 2].map((row) => (
              <li key={row} className="mobile-skeleton-row">
                <span className="mobile-skeleton-bar" style={{ width: "48%" }} />
                <span className="mobile-skeleton-bar" style={{ width: "76%" }} />
              </li>
            ))}
          </ul>
        ) : empty ? (
          <div className="mobile-assistants-empty">
            <span className="mobile-chat-hero-mark" aria-hidden>
              <BrandMark />
            </span>
            <h2>{t("Your own assistants")}</h2>
            <p>
              {t(
                "An assistant is a conversation with its own instructions, references and tools. Make one for something you do often.",
              )}
            </p>
            <button
              type="button"
              className="mobile-studio-generate mobile-assistants-empty-cta"
              onClick={() => onCreate()}
            >
              {t("Create an assistant")}
            </button>
          </div>
        ) : (
          <section aria-label={t("My assistants")}>
            {ordered.length === 0 ? (
              <p className="mobile-assistants-none">{t("No assistant matches your search.")}</p>
            ) : (
              <ul className="mobile-note-list">
                {ordered.map((assistant) => (
                  <li key={assistant.id}>
                    <AssistantRow
                      assistant={assistant}
                      lastTalked={lastTalked.get(assistant.id)}
                      onOpen={() => onOpenChat(assistant.id)}
                      onActions={() => setSheet({ kind: "actions", assistant })}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {!empty && recent.length > 0 && !query.trim() ? (
          <section className="mobile-assistants-section" aria-label={t("Recent conversations")}>
            <div className="mobile-assistants-section-head">
              <h2 className="mobile-list-section-title">{t("Recent conversations")}</h2>
              {conversations.length > RECENT ? (
                <button
                  type="button"
                  className="mobile-assistant-flow-link"
                  onClick={onOpenHistory}
                >
                  {t("See all")}
                </button>
              ) : null}
            </div>
            <ul className="mobile-note-list">
              {recent.map(({ task, definition }) => (
                <li key={task.id}>
                  <ConversationRow
                    task={task}
                    assistant={byId.get(definition.id) ?? definition}
                    onOpen={() => onOpenConversation(task.id)}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {!query.trim() ? (
          <section className="mobile-assistants-section" aria-label={t("Start from an idea")}>
            <h2 className="mobile-list-section-title">{t("Start from an idea")}</h2>
            <div className="mobile-assistants-ideas">
              {assistantTemplates().map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="mobile-assistants-idea"
                  onClick={() => onCreate(template.prompt)}
                >
                  <AssistantAvatar
                    assistant={{ id: template.id, name: template.name, avatar_ref: null }}
                    size={36}
                  />
                  <strong>{template.name}</strong>
                  <span className="mobile-assistants-idea-text">{template.description}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </PullToRefresh>

      {sheet?.kind === "actions" ? (
        <ActionSheet
          title={sheet.assistant.name}
          subtitle={sheet.assistant.description || undefined}
          actions={[
            { label: t("New conversation"), onAction: () => onOpenChat(sheet.assistant.id) },
            { label: t("Edit"), onAction: () => onEdit(sheet.assistant.id) },
            { label: t("Duplicate"), onAction: () => void duplicate(sheet.assistant) },
            {
              label: t("Delete"),
              destructive: true,
              onAction: () => setSheet({ kind: "delete", assistant: sheet.assistant }),
            },
          ]}
          onClose={() => setSheet((current) => (current?.kind === "actions" ? null : current))}
        />
      ) : null}
      {sheet?.kind === "delete" ? (
        <ActionSheet
          title={t("Delete this assistant?")}
          subtitle={t(
            "Your existing conversations remain available. The assistant and its references are removed.",
          )}
          actions={[
            {
              label: t("Delete"),
              destructive: true,
              onAction: () => void remove(sheet.assistant),
            },
          ]}
          onClose={() => setSheet((current) => (current?.kind === "delete" ? null : current))}
        />
      ) : null}
    </div>
  );
}

function AssistantRow({
  assistant,
  lastTalked,
  onOpen,
  onActions,
}: {
  assistant: AssistantDefinition;
  lastTalked?: string;
  onOpen: () => void;
  onActions: () => void;
}) {
  const longPress = useLongPress(onActions);
  const time = lastTalked ? formatNoteTime(lastTalked) : "";
  return (
    <button
      type="button"
      className="mobile-note-row mobile-assistant-row"
      aria-label={[assistant.name, assistant.description, time].filter(Boolean).join(", ")}
      // The browser synthesises a click after a long press; without this the
      // sheet opens and the chat opens behind it.
      onClick={() => {
        if (longPress.consumed()) return;
        onOpen();
      }}
      {...longPress.handlers}
    >
      <AssistantAvatar assistant={assistant} size={44} />
      <span className="mobile-note-row-body">
        <span className="mobile-note-row-title">{assistant.name}</span>
        {assistant.description ? (
          <span className="mobile-note-row-subtitle">{assistant.description}</span>
        ) : null}
      </span>
      {time ? <span className="mobile-note-row-time">{time}</span> : null}
    </button>
  );
}

export function ConversationRow({
  task,
  assistant,
  onOpen,
  showAssistant = false,
}: {
  task: AssistantConversation["task"];
  assistant: AssistantDefinition;
  onOpen: () => void;
  /** Name the assistant under the title (where rows mix assistants). */
  showAssistant?: boolean;
}) {
  const title = task.title.trim() || task.prompt.trim() || t("Conversation");
  const time = formatNoteTime(task.updatedAt);
  return (
    <button
      type="button"
      className="mobile-note-row mobile-assistant-row"
      aria-label={[title, assistant.name, time].filter(Boolean).join(", ")}
      onClick={onOpen}
    >
      <AssistantAvatar assistant={assistant} size={32} />
      <span className="mobile-note-row-body">
        <span className="mobile-note-row-title">{title}</span>
        {showAssistant || title !== assistant.name ? (
          <span className="mobile-note-row-subtitle">{assistant.name}</span>
        ) : null}
      </span>
      <span className="mobile-note-row-time">{time}</span>
    </button>
  );
}
