import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  type Space,
  type SpaceMessage,
  spacesMessages,
  spacesNewConversation,
  spacesRetryTurn,
  spacesSendMessage,
} from "../../lib/spaces";

/** Who wrote a message, as the group sees it. */
export function authorLine(message: SpaceMessage): string {
  if (message.role === "assistant") {
    return message.paidByName
      ? t("Assistant, answered with {name}'s key", { name: message.paidByName })
      : t("Assistant");
  }
  if (message.isMine) return t("You");
  return message.authorName ?? t("A member");
}

/**
 * The group chats of a shared project. Every member's messages reach every
 * member; asking the assistant runs the reply on this device, with this
 * account's key, and everyone sees whose key paid.
 */
export function SpaceChat({
  space,
  version,
  onChanged,
}: {
  space: Space;
  version: number;
  onChanged: () => Promise<void>;
}) {
  const [openId, setOpenId] = useState<string | null>(space.conversations[0]?.id ?? null);
  const [messages, setMessages] = useState<SpaceMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writable = space.summary.state === "active";

  const load = useCallback(async () => {
    if (!openId) return setMessages([]);
    try {
      setMessages(await spacesMessages(space.summary.id, openId));
    } catch (cause) {
      setError(messageFromError(cause));
    }
  }, [openId, space.summary.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` changes when the space was read again
  useEffect(() => {
    void load();
  }, [load, version]);

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
      await load();
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setBusy(false);
    }
  }

  // A chat reads from the bottom: the newest message is the one in view,
  // whatever the height the dialog leaves the thread.
  const thread = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const list = thread.current;
    if (list && messages.length > 0) list.scrollTop = list.scrollHeight;
  }, [messages]);

  const turns = space.turns.filter((turn) => turn.conversationId === openId);
  return (
    <div className="spaces-chat">
      <aside className="spaces-chat-list" aria-label={t("Chats")}>
        {space.conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            className="spaces-chat-item"
            aria-current={conversation.id === openId}
            onClick={() => setOpenId(conversation.id)}
          >
            {conversation.title || t("Untitled chat")}
          </button>
        ))}
        {writable ? (
          <form
            className="spaces-row"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                setOpenId(await spacesNewConversation(space.summary.id, title.trim()));
                setTitle("");
              });
            }}
          >
            <input
              className="dialog-input"
              placeholder={t("New chat")}
              value={title}
              maxLength={300}
              onChange={(event) => setTitle(event.target.value)}
            />
            <button type="submit" className="btn btn-secondary" disabled={busy || !title.trim()}>
              {t("Add")}
            </button>
          </form>
        ) : null}
      </aside>
      <section className="spaces-chat-thread">
        {error ? (
          <p role="alert" className="spaces-hint">
            {error}
          </p>
        ) : null}
        {!openId ? (
          <p className="spaces-hint">
            {t("Start a chat everyone in this project can read and answer.")}
          </p>
        ) : (
          <>
            <ol ref={thread} className="spaces-messages" aria-live="polite">
              {messages.map((message) => (
                <li
                  key={message.id}
                  className="spaces-message"
                  data-role={message.role}
                  data-mine={message.isMine || undefined}
                >
                  <span className="spaces-message-author">
                    {authorLine(message)}
                    {message.pending ? ` · ${t("sending")}` : ""}
                  </span>
                  <span className="spaces-message-text">{message.text}</span>
                  {message.role === "assistant" && message.model ? (
                    <span className="spaces-message-meta">{message.model}</span>
                  ) : null}
                </li>
              ))}
              {turns.map((turn) => (
                <li key={turn.id} className="spaces-message" data-role="assistant">
                  {turn.failed ? (
                    <span className="spaces-row">
                      <span className="spaces-message-text">
                        {t("The assistant could not answer.")}
                      </span>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => void run(() => spacesRetryTurn(turn.id))}
                      >
                        {t("Try again")}
                      </button>
                    </span>
                  ) : (
                    <span className="spaces-message-meta">{t("The assistant is answering…")}</span>
                  )}
                </li>
              ))}
            </ol>
            {writable ? (
              <div className="spaces-composer">
                <textarea
                  className="dialog-textarea"
                  rows={3}
                  value={draft}
                  aria-label={t("Message")}
                  placeholder={t("Write to everyone in this project")}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div className="spaces-row">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy || !draft.trim()}
                    onClick={() =>
                      void run(async () => {
                        await spacesSendMessage(space.summary.id, openId, draft, false);
                        setDraft("");
                      })
                    }
                  >
                    {t("Send")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy || !draft.trim()}
                    title={t("Your device answers with your key, and everyone sees that you paid.")}
                    onClick={() =>
                      void run(async () => {
                        await spacesSendMessage(space.summary.id, openId, draft, true);
                        setDraft("");
                      })
                    }
                  >
                    {t("Send and ask the assistant")}
                  </button>
                </div>
                <p className="spaces-hint">
                  {t(
                    "The assistant answers from your device, with your key: you pay for that reply.",
                  )}
                </p>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
