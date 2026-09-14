import { useState } from "react";
import {
  type AccountConflict,
  type AccountConflictPreview,
  accountSyncConflictPreview,
  accountSyncResolveConflict,
} from "../../lib/account";
import { errorCode } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { Dialog } from "../ui/Dialog";

export function AccountConflictReview({
  conflict,
  onResolved,
}: {
  conflict: AccountConflict;
  onResolved: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<AccountConflictPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<"keep_local" | "use_remote" | "copy" | null>(null);
  async function show() {
    setOpen(true);
    setPreview(null);
    setChoice(null);
    setError(null);
    setBusy(true);
    try {
      setPreview(await accountSyncConflictPreview(conflict.id));
    } catch {
      setError(t("This preserved version could not be read. Unlock your vault and try again."));
    } finally {
      setBusy(false);
    }
  }
  async function resolve() {
    if (!choice || busy) return;
    setBusy(true);
    setError(null);
    try {
      await accountSyncResolveConflict(conflict.id, choice);
      await onResolved();
      setOpen(false);
    } catch (cause) {
      setError(
        errorCode(cause) === "sync_pending_changes"
          ? t("Sync this device's pending changes first, then review this version again.")
          : t("Your choice could not be saved. Your versions are still preserved. Try again."),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={() => void show()}>
        {t("Review versions")}
      </button>
      <Dialog
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title={t("Choose which version to keep")}
        description={t(
          "Review both versions before deciding. Your choice will be shared with your other devices.",
        )}
        width="min(720px, calc(100vw - 32px))"
        footer={
          <>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {t("Cancel")}
            </button>
            <button
              className="primary-action primary-solid"
              type="button"
              disabled={busy || !choice || !preview}
              onClick={() => void resolve()}
            >
              {t("Confirm my choice")}
            </button>
          </>
        }
      >
        <div className="portable-conversations">
          {error ? <p role="alert">{error}</p> : null}
          {preview ? (
            <>
              <div className="portable-history">
                <article className="portable-message">
                  <h3>{t("On this device")}</h3>
                  <p>{preview.local_preview ?? t("No local version")}</p>
                </article>
                <article className="portable-message">
                  <h3>{t("From your other device")}</h3>
                  <p>
                    {preview.deleted
                      ? t("This item was deleted on your other device.")
                      : (preview.remote_preview ?? t("Preview unavailable"))}
                  </p>
                </article>
              </div>
              <fieldset className="account-form">
                <legend>{t("Your choice")}</legend>
                <label className="account-consent">
                  <input
                    type="radio"
                    name={`conflict-${conflict.id}`}
                    checked={choice === "keep_local"}
                    onChange={() => setChoice("keep_local")}
                  />
                  <span>{t("Keep the version on this device")}</span>
                </label>
                <label className="account-consent">
                  <input
                    type="radio"
                    name={`conflict-${conflict.id}`}
                    checked={choice === "use_remote"}
                    onChange={() => setChoice("use_remote")}
                  />
                  <span>
                    {preview.deleted
                      ? t("Accept the deletion on this device")
                      : t("Use the version from my other device")}
                  </span>
                </label>
                {preview.kind === "note" && !preview.deleted ? (
                  <label className="account-consent">
                    <input
                      type="radio"
                      name={`conflict-${conflict.id}`}
                      checked={choice === "copy"}
                      onChange={() => setChoice("copy")}
                    />
                    <span>{t("Keep both as separate notes")}</span>
                  </label>
                ) : null}
              </fieldset>
            </>
          ) : !error ? (
            <p role="status">{t("Loading preserved versions…")}</p>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
