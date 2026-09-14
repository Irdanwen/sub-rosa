import "../settings/account-settings.css";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  accountConversationsList,
  accountConversationGet,
  type PortableConversationSummary,
  type PortableConversation,
} from "../../lib/account";
import { useAccountSyncUpdated } from "../../lib/account-sync-events";
import { t } from "../../lib/i18n";
import { Dialog } from "../ui/Dialog";

/** Imported messages render as plain text. In particular historical action
 * proposals cannot become live buttons or grant the new runtime permissions. */
export function PortableConversationsDialog({
  open,
  onClose,
  onContinue,
}: {
  open: boolean;
  onClose: () => void;
  onContinue: (taskId: string, newMessage: string) => Promise<void>;
}) {
  const [items, setItems] = useState<PortableConversationSummary[]>([]);
  const [selected, setSelected] = useState<PortableConversation | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    if (!open) return;
    const request = epoch.current;
    try {
      const next = await accountConversationsList();
      if (request === epoch.current) {
        setItems(next);
        setError(null);
      }
    } catch {
      if (request === epoch.current)
        setError(t("Could not load your synced conversations. Try again."));
    } finally {
      if (request === epoch.current) setLoading(false);
    }
  }, [open]);
  useAccountSyncUpdated(refresh);
  useEffect(() => {
    epoch.current += 1;
    if (open) {
      setLoading(true);
      void refresh();
    } else {
      setSelected(null);
      setDraft("");
    }
    return () => {
      epoch.current += 1;
    };
  }, [open, refresh]);

  async function select(id: string) {
    setBusy(true);
    setError(null);
    const request = epoch.current;
    try {
      const next = await accountConversationGet(id);
      if (request === epoch.current) setSelected(next);
    } catch {
      if (request === epoch.current)
        setError(t("This conversation could not be loaded. Try again."));
    } finally {
      if (request === epoch.current) setBusy(false);
    }
  }
  async function submit() {
    if (!selected || !draft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onContinue(selected.id, draft.trim());
      onClose();
    } catch {
      setError(
        t("The conversation could not be continued. Check your connection before sending again."),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={t("Conversations from your devices")}
      description={t(
        "Read a synced conversation and send a new message to continue here. Past tool actions and permissions are not carried over.",
      )}
      width="min(720px, calc(100vw - 32px))"
      footer={
        <button className="btn btn-secondary" type="button" disabled={busy} onClick={onClose}>
          {t("Close")}
        </button>
      }
    >
      <div className="portable-conversations">
        {error ? (
          <p role="alert" className="settings-row-description">
            {error}
          </p>
        ) : null}
        {selected ? (
          <>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                setSelected(null);
                setDraft("");
              }}
            >
              {t("Back to conversations")}
            </button>
            <h3 className="settings-row-title">{selected.title}</h3>
            <section className="portable-history" aria-label={t("Synced conversation history")}>
              {selected.messages.map((message) => (
                <article className="portable-message" key={message.id}>
                  <strong>{message.role === "user" ? t("You") : t("Assistant")}</strong>
                  <p>{message.content}</p>
                </article>
              ))}
            </section>
            <form
              className="account-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <label className="account-field">
                <span>{t("Your new message")}</span>
                <textarea
                  rows={3}
                  value={draft}
                  maxLength={16000}
                  disabled={busy}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </label>
              <button
                className="primary-action primary-solid"
                type="submit"
                disabled={busy || !draft.trim()}
              >
                {busy ? t("Starting conversation…") : t("Continue on this device")}
              </button>
            </form>
          </>
        ) : (
          <>
            {loading ? (
              <p role="status">{t("Loading conversations…")}</p>
            ) : items.length === 0 ? (
              <p className="settings-row-description">
                {t(
                  "Your conversations from other devices will appear here after sync. Enable sync in Account and sync settings on both devices.",
                )}
              </p>
            ) : (
              <div className="portable-history">
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="portable-conversation-row"
                    disabled={busy}
                    onClick={() => void select(item.id)}
                  >
                    <span>{item.title}</span>
                    <span className="settings-row-description">
                      {t("{count} messages", { count: item.message_count })}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              {t("Refresh conversations")}
            </button>
          </>
        )}
      </div>
    </Dialog>
  );
}
