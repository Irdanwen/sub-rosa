import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IconChainLink1 } from "central-icons/IconChainLink1";
import { useEffect, useState } from "react";
import {
  accountShareNote,
  SHARE_WINDOWS,
  type ShareLink,
  type ShareWindow,
} from "../../lib/account";
import { t } from "../../lib/i18n";
import { accountError } from "../settings/AccountSettingsSection";
import { Dialog } from "../ui/Dialog";

/**
 * Making a link to a note.
 *
 * Two things are load bearing here and neither is decoration. The deadline is
 * chosen before the link exists, because a link with no end is the one thing
 * the service cannot undo for you. And the sentence under the button says what
 * revoking does and does not do: the honest reading of
 * [ADR 0050](../../../docs/adr/0050-vault-admission-uses-an-out-of-band-secret.md),
 * at the moment it is worth reading, rather than in a document nobody opens.
 */
const WINDOW_LABELS: Record<ShareWindow, () => string> = {
  24: () => t("24 hours"),
  168: () => t("7 days"),
  720: () => t("30 days"),
};

export function ShareNoteDialog({
  noteId,
  open,
  onClose,
}: {
  noteId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [window, setWindow] = useState<ShareWindow>(SHARE_WINDOWS[0]);
  const [link, setLink] = useState<ShareLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // A dialog reopened on another note must never show the previous link.
  useEffect(() => {
    if (!open) return;
    setLink(null);
    setError(null);
    setCopied(false);
    setWindow(SHARE_WINDOWS[0]);
  }, [open]);

  async function create() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setLink(await accountShareNote(noteId, window));
    } catch (cause) {
      setError(accountError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("Share this note")}
      leading={<IconChainLink1 size={16} aria-hidden="true" />}
      description={t(
        "Anyone with the link can read this note in a browser. Sub Rosa stores it encrypted and never receives the key that opens it.",
      )}
      footer={
        link ? (
          <button type="button" className="primary-action primary-solid" onClick={onClose}>
            {t("Done")}
          </button>
        ) : (
          <>
            <button type="button" className="primary-action" onClick={onClose}>
              {t("Cancel")}
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              onClick={() => void create()}
              disabled={busy}
            >
              {busy ? t("Creating the link...") : t("Create the link")}
            </button>
          </>
        )
      }
    >
      {error ? (
        <p className="dialog-field-hint dialog-share-error" role="alert">
          {error}
        </p>
      ) : null}
      {link ? (
        <div className="share-result">
          <input
            className="share-link"
            readOnly
            value={link.url}
            onFocus={(event) => event.currentTarget.select()}
            aria-label={t("Link to this note")}
          />
          <button
            type="button"
            className="primary-action"
            onClick={() => {
              void writeText(link.url).then(() => setCopied(true));
            }}
          >
            {copied ? t("Copied") : t("Copy")}
          </button>
        </div>
      ) : (
        <fieldset className="share-windows">
          <legend>{t("How long the link works")}</legend>
          {SHARE_WINDOWS.map((hours) => (
            <label key={hours} className="share-window" data-active={window === hours || undefined}>
              <input
                type="radio"
                name="share-window"
                value={hours}
                checked={window === hours}
                onChange={() => setWindow(hours)}
              />
              {WINDOW_LABELS[hours]()}
            </label>
          ))}
        </fieldset>
      )}
      <p className="dialog-field-hint">
        {t(
          "Revoking stops the link working. It cannot erase a copy someone has already downloaded.",
        )}
      </p>
    </Dialog>
  );
}
