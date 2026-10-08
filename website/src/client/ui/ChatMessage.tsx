import { useState } from "react";
import { MessageBody } from "../../lib/chat-blocks";
import { t } from "../../lib/i18n";
import type { Message } from "../library";
import type { MemorySource, Rating } from "../local";

export interface MessageActions {
  onCopy(message: Message): void;
  onReadAloud(message: Message): void;
  onRate(message: Message, rating: Rating | null): void;
  onRegenerate(): void;
  onBranch(message: Message): void;
  onEdit(message: Message, content: string): void;
}

/** One message with what can be done to it. The controls are the app's:
 * copy, read aloud, rate, regenerate the last reply, branch from a reply,
 * edit a question. */
export function ChatMessage({
  message,
  last,
  busy,
  temporary,
  reading,
  rating,
  sources,
  actions,
}: {
  message: Message;
  /** The last reply of the chat: the one Regenerate replaces. */
  last: boolean;
  busy: boolean;
  temporary: boolean;
  reading: boolean;
  rating: Rating | null;
  sources?: MemorySource[];
  actions: MessageActions;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  const mine = message.role === "user";
  return (
    <article className={`wc-message ${mine ? "wc-user" : "wc-assistant"}`} data-role={message.role}>
      <h3 className="sr-only">{mine ? t("You", "Vous") : "Sub Rosa"}</h3>
      {editing !== null ? (
        <form
          className="wc-edit"
          onSubmit={(event) => {
            event.preventDefault();
            if (editing.trim()) actions.onEdit(message, editing);
            setEditing(null);
          }}
        >
          <label className="sr-only" htmlFor={`edit-${message.id}`}>
            {t("Edit your message", "Modifier votre message")}
          </label>
          <textarea
            id={`edit-${message.id}`}
            value={editing}
            rows={Math.min(10, editing.split("\n").length + 1)}
            onChange={(event) => setEditing(event.target.value)}
          />
          <div className="wc-row">
            <button className="button primary" type="submit" disabled={!editing.trim()}>
              {t("Send", "Envoyer")}
            </button>
            <button className="button" type="button" onClick={() => setEditing(null)}>
              {t("Cancel", "Annuler")}
            </button>
          </div>
        </form>
      ) : mine ? (
        <p className="wc-question">{message.content}</p>
      ) : (
        <div className="wc-reply">
          <MessageBody content={message.content} />
        </div>
      )}
      {editing === null && (
        <div
          className="wc-actions"
          role="toolbar"
          aria-label={t("Message actions", "Actions du message")}
        >
          <button type="button" onClick={() => actions.onCopy(message)}>
            {t("Copy", "Copier")}
          </button>
          {mine ? (
            <button type="button" disabled={busy} onClick={() => setEditing(message.content)}>
              {t("Edit", "Modifier")}
            </button>
          ) : (
            <>
              <button
                type="button"
                aria-pressed={reading}
                onClick={() => actions.onReadAloud(message)}
              >
                {reading
                  ? t("Stop reading", "Arrêter la lecture")
                  : t("Read aloud", "Lire à voix haute")}
              </button>
              <button
                type="button"
                aria-pressed={rating === "up"}
                aria-label={t("Good reply", "Bonne réponse")}
                onClick={() => actions.onRate(message, rating === "up" ? null : "up")}
              >
                {t("Good", "Bien")}
              </button>
              <button
                type="button"
                aria-pressed={rating === "down"}
                aria-label={t("Bad reply", "Mauvaise réponse")}
                onClick={() => actions.onRate(message, rating === "down" ? null : "down")}
              >
                {t("Not good", "Pas bien")}
              </button>
              {last && (
                <button type="button" disabled={busy} onClick={actions.onRegenerate}>
                  {t("Regenerate", "Régénérer")}
                </button>
              )}
              {!temporary && (
                <button type="button" disabled={busy} onClick={() => actions.onBranch(message)}>
                  {t("Branch", "Bifurquer")}
                </button>
              )}
              {sources && sources.length > 0 && (
                <button
                  type="button"
                  className="wc-chip"
                  aria-expanded={showSources}
                  onClick={() => setShowSources((open) => !open)}
                >
                  {sources.length === 1
                    ? t("1 memory used", "1 souvenir utilisé")
                    : t(`${sources.length} memories used`, `${sources.length} souvenirs utilisés`)}
                </button>
              )}
            </>
          )}
        </div>
      )}
      {showSources && sources && (
        <ul
          className="wc-sources"
          aria-label={t("Memories this reply was given", "Souvenirs donnés à cette réponse")}
        >
          {sources.map((source) => (
            <li key={source.id}>{source.text}</li>
          ))}
        </ul>
      )}
    </article>
  );
}
