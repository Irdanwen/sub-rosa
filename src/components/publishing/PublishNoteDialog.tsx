import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IconGlobe } from "central-icons/IconGlobe";
import { useEffect, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  type NotePublication,
  notePublication,
  publishNote,
  unpublishPage,
} from "../../lib/publishing";
import { Dialog } from "../ui/Dialog";
import "./publishing.css";

/**
 * Publishing a note or a canvas as a public page (ADR-0097).
 *
 * This is the one place a note leaves the device unencrypted, so the dialog
 * says what that means before the button, every time: anybody can read it,
 * the service stores it as written, and unpublishing cannot reach a copy
 * somebody already saved. Nothing is published until the person taps.
 */
export function PublishNoteDialog({
  noteId,
  kind = "note",
  open,
  onClose,
}: {
  noteId: string;
  kind?: "note" | "canvas";
  open: boolean;
  onClose: () => void;
}) {
  const [state, setState] = useState<NotePublication | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setState(null);
    setError(null);
    setCopied(false);
    setConfirming(false);
    setLoading(true);
    notePublication(noteId)
      .then((value) => {
        if (alive) setState(value);
      })
      .catch((cause) => {
        if (alive) setError(messageFromError(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, noteId]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(messageFromError(cause));
    } finally {
      setBusy(false);
    }
  }

  const page = state?.page ?? null;
  const publish = () =>
    run(async () => {
      setState(await publishNote(noteId, kind));
      setCopied(false);
    });
  const unpublish = () =>
    run(async () => {
      if (!page) return;
      await unpublishPage(page.id);
      setState((current) =>
        current ? { ...current, page: null, url: null, changed: false } : current,
      );
      setConfirming(false);
    });

  const footer = page ? (
    <>
      {confirming ? (
        <button
          type="button"
          className="primary-action"
          onClick={() => void unpublish()}
          disabled={busy}
        >
          {t("Unpublish now")}
        </button>
      ) : (
        <button
          type="button"
          className="primary-action"
          onClick={() => setConfirming(true)}
          disabled={busy}
        >
          {t("Unpublish")}
        </button>
      )}
      {page.taken_down ? null : (
        <button
          type="button"
          className="primary-action primary-solid"
          onClick={() => void publish()}
          disabled={busy || !state?.changed}
        >
          {busy ? t("Publishing...") : t("Publish changes")}
        </button>
      )}
    </>
  ) : (
    <>
      <button type="button" className="primary-action" onClick={onClose}>
        {t("Cancel")}
      </button>
      <button
        type="button"
        className="primary-action primary-solid"
        onClick={() => void publish()}
        disabled={busy || loading || (!state && !!error)}
      >
        {busy ? t("Publishing...") : t("Publish")}
      </button>
    </>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={kind === "canvas" ? t("Publish this canvas") : t("Publish this note")}
      leading={<IconGlobe size={16} aria-hidden="true" />}
      description={t(
        "A published page is public: anyone with its address can read it, and search engines may list it.",
      )}
      footer={footer}
    >
      {error ? (
        <p className="dialog-field-hint dialog-share-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="dialog-field-hint" role="status">
          {t("Checking what is published...")}
        </p>
      ) : page && state?.url ? (
        <div className="publish-state">
          {page.taken_down ? (
            <p className="dialog-field-hint" role="status">
              {t("The service took this page down. It is no longer shown to anyone.")}
            </p>
          ) : (
            <div className="share-result">
              <input
                className="share-link"
                readOnly
                value={state.url}
                onFocus={(event) => event.currentTarget.select()}
                aria-label={t("Address of the page")}
              />
              <button
                type="button"
                className="primary-action"
                onClick={() => {
                  void writeText(state.url ?? "").then(() => setCopied(true));
                }}
              >
                {copied ? t("Copied") : t("Copy")}
              </button>
            </div>
          )}
          <p className="dialog-field-hint">
            {state.changed
              ? t(
                  "This note changed since you published it. Publish the changes to update the page.",
                )
              : t("The page shows this note as it is now.")}
          </p>
          {confirming ? (
            <p className="dialog-field-hint" role="alert">
              {t(
                "Unpublishing removes the page at once. It cannot erase a copy someone has already saved.",
              )}
            </p>
          ) : null}
        </div>
      ) : (
        <ul className="publish-facts">
          <li>{t("The text is sent and stored unencrypted, unlike your synced notes.")}</li>
          <li>{t("It stays online until you unpublish it. There is no end date.")}</li>
          <li>{t("Edit it here, then publish the changes. Images are not published.")}</li>
          <li>
            {t(
              "Unpublishing removes it from the service. It cannot erase a copy someone already saved.",
            )}
          </li>
        </ul>
      )}
    </Dialog>
  );
}
