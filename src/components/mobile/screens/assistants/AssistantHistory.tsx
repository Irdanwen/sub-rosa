// Every conversation with an assistant, newest first, findable by its words
// or by the assistant's name.

import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccountSyncUpdated } from "../../../../lib/account-sync-events";
import {
  type AssistantConversation,
  type AssistantDefinition,
  listAssistantArchive,
  listAssistants,
} from "../../../../lib/assistants";
import { messageFromError } from "../../../../lib/errors";
import { t } from "../../../../lib/i18n";
import { EmptyState } from "../../../ui/EmptyState";
import { Spinner } from "../../../ui/Spinner";
import { PullToRefresh } from "../../PullToRefresh";
import { StackHeader } from "../../StackHeader";
import { ConversationRow } from "./AssistantsHome";

export function AssistantHistory({
  onBack,
  onOpenConversation,
}: {
  onBack: () => void;
  onOpenConversation: (taskId: string) => void;
}) {
  const [conversations, setConversations] = useState<AssistantConversation[] | null>(null);
  const [assistants, setAssistants] = useState<AssistantDefinition[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [archive, definitions] = await Promise.all([listAssistantArchive(), listAssistants()]);
      setConversations(archive);
      setAssistants(definitions);
    } catch (err) {
      setError(messageFromError(err));
      setConversations((current) => current ?? []);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useAccountSyncUpdated(refresh);

  const byId = useMemo(() => new Map(assistants.map((entry) => [entry.id, entry])), [assistants]);
  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return conversations ?? [];
    return (conversations ?? []).filter(({ task, definition }) =>
      [task.title, task.prompt, definition.name].some((value) =>
        value.toLocaleLowerCase().includes(needle),
      ),
    );
  }, [conversations, query]);

  return (
    <div className="mobile-screen-root">
      <StackHeader title={t("Conversations")} large onBack={onBack} backLabel={t("Assistants")} />
      {(conversations?.length ?? 0) > 0 ? (
        <div className="mobile-search">
          <IconMagnifyingGlass size={16} aria-hidden />
          <input
            type="search"
            placeholder={t("Search conversations")}
            aria-label={t("Search conversations")}
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
        {conversations === null ? (
          <Spinner aria-label={t("Loading")} />
        ) : shown.length === 0 ? (
          <EmptyState
            title={
              query.trim() ? t("No conversation matches your search.") : t("No conversations yet")
            }
          />
        ) : (
          <ul className="mobile-note-list">
            {shown.map(({ task, definition }) => (
              <li key={task.id}>
                <ConversationRow
                  task={task}
                  assistant={byId.get(definition.id) ?? definition}
                  showAssistant
                  onOpen={() => onOpenConversation(task.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </PullToRefresh>
    </div>
  );
}
