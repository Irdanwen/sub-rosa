import { useState } from "react";
import { date, t } from "../../lib/i18n";
import type { Message } from "../library";
import {
  createConversationShare,
  SHARE_WINDOWS,
  ShareError,
  type ShareLink,
  type ShareTransport,
  serviceShareTransport,
} from "../share";
import { ModalDialog } from "./ModalDialog";

const WINDOW_LABELS: Record<number, () => string> = {
  24: () => t("One day", "Un jour"),
  168: () => t("One week", "Une semaine"),
  720: () => t("Thirty days", "Trente jours"),
};

function failure(error: unknown): string {
  if (error instanceof ShareError) {
    if (error.code === "share_empty")
      return t(
        "This chat has nothing to share yet.",
        "Cette discussion n’a encore rien à partager.",
      );
    if (error.code === "share_too_large")
      return t(
        "This chat is too long to share as a link.",
        "Cette discussion est trop longue pour un lien.",
      );
  }
  return t(
    "The link could not be made. Check your connection and try again.",
    "Le lien n’a pas pu être créé. Vérifiez votre connexion et réessayez.",
  );
}

/** "Share link" for a chat (ADR-0053): a deadline among three, a link whose
 * key never reaches the service, and what revoking cannot do, said here. */
export function ShareDialog({
  open,
  title,
  messages,
  onClose,
  transport = serviceShareTransport,
}: {
  open: boolean;
  title: string;
  messages: Message[];
  onClose: () => void;
  transport?: ShareTransport;
}) {
  const [hours, setHours] = useState<number>(SHARE_WINDOWS[1]);
  const [link, setLink] = useState<ShareLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const close = () => {
    setLink(null);
    setError("");
    setStatus("");
    onClose();
  };
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      setLink(await createConversationShare(title, messages, hours, transport));
    } catch (failed) {
      setError(failure(failed));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    if (!link) return;
    setBusy(true);
    try {
      await transport.revoke(link.id);
      setLink(null);
      setStatus(t("The link no longer works.", "Le lien ne fonctionne plus."));
    } catch {
      setError(
        t(
          "The link could not be revoked. Try again.",
          "Le lien n’a pas pu être révoqué. Réessayez.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalDialog open={open} labelledBy="wc-share-title" onClose={close}>
      <div className="form">
        <h2 id="wc-share-title">{t("Share this chat", "Partager cette discussion")}</h2>
        <p className="quiet">
          {t(
            "Anyone with the link can read what you and Sub Rosa said here, until it expires. The key that opens it is in the link itself and never reaches the service. Revoking stops the link working; it cannot erase a copy someone already opened.",
            "Toute personne qui a le lien peut lire ce que vous et Sub Rosa avez dit ici, jusqu’à son expiration. La clé qui l’ouvre est dans le lien et n’atteint jamais le service. Révoquer arrête le lien ; cela n’efface pas une copie déjà ouverte.",
          )}
        </p>
        {!link ? (
          <>
            <fieldset className="wc-choices">
              <legend>{t("The link works for", "Le lien fonctionne pendant")}</legend>
              {SHARE_WINDOWS.map((value) => (
                <label key={value} className="check">
                  <input
                    type="radio"
                    name="share-window"
                    checked={hours === value}
                    onChange={() => setHours(value)}
                  />
                  {WINDOW_LABELS[value]()}
                </label>
              ))}
            </fieldset>
            <div className="wc-row">
              <button
                className="button primary"
                type="button"
                disabled={busy}
                onClick={() => void create()}
              >
                {t("Create link", "Créer le lien")}
              </button>
              <button className="button" type="button" onClick={close}>
                {t("Close", "Fermer")}
              </button>
            </div>
          </>
        ) : (
          <>
            <label>
              <span>{t("Link", "Lien")}</span>
              <input readOnly value={link.url} onFocus={(event) => event.target.select()} />
            </label>
            <p className="quiet">
              {t(
                `Works until ${date(link.expiresAt)}.`,
                `Fonctionne jusqu’au ${date(link.expiresAt)}.`,
              )}
            </p>
            <div className="wc-row">
              <button
                className="button primary"
                type="button"
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(link.url)
                    .then(() => setStatus(t("Link copied.", "Lien copié.")))
                    .catch(() => setStatus(""))
                }
              >
                {t("Copy link", "Copier le lien")}
              </button>
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => void revoke()}
              >
                {t("Revoke link", "Révoquer le lien")}
              </button>
              <button className="button" type="button" onClick={close}>
                {t("Close", "Fermer")}
              </button>
            </div>
          </>
        )}
        {status && (
          <p className="quiet" role="status">
            {status}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </ModalDialog>
  );
}
