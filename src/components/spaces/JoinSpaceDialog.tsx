import { useState } from "react";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import {
  type InvitationPreview,
  looksLikeInvitation,
  spacesAcceptInvitation,
  spacesOpenInvitation,
} from "../../lib/spaces";
import { Dialog, DialogField } from "../ui/Dialog";
import { SafetyNumber } from "./SafetyNumber";

/**
 * Joining a shared project from a link someone sent. The link carries the
 * owner's identity, so the safety number shown here can be compared with
 * theirs before anything is accepted.
 */
export function JoinSpaceDialog({
  open,
  onClose,
  onJoined,
}: {
  open: boolean;
  onClose: () => void;
  onJoined: () => void;
}) {
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setCode("");
    setPreview(null);
    setJoined(false);
    setError(null);
    onClose();
  }
  async function run(action: () => Promise<void>) {
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

  return (
    <Dialog
      open={open}
      onClose={close}
      title={preview ? preview.spaceName || t("Shared project") : t("Join a shared project")}
      description={
        preview
          ? undefined
          : t("Paste the link or the code the owner sent you. It works once, for one account.")
      }
      footer={
        joined ? (
          <button type="button" className="btn btn-primary" onClick={close}>
            {t("Done")}
          </button>
        ) : preview ? (
          <>
            <button type="button" className="btn btn-secondary" onClick={close}>
              {t("Cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await spacesAcceptInvitation(code);
                  setJoined(true);
                  onJoined();
                })
              }
            >
              {t("Join")}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !looksLikeInvitation(code)}
            onClick={() => void run(async () => setPreview(await spacesOpenInvitation(code)))}
          >
            {t("Continue")}
          </button>
        )
      }
    >
      {error ? (
        <p role="alert" className="dialog-description">
          {error}
        </p>
      ) : null}
      {joined ? (
        <p className="dialog-description">
          {t(
            "You asked to join. The owner lets you in from their device, and the project appears here once they do.",
          )}
        </p>
      ) : preview ? (
        <>
          <p className="dialog-description">
            {t(
              "Before you join, compare this safety number with the owner's, in person or on a call. If it differs, someone may be in between: do not join.",
            )}
          </p>
          <SafetyNumber groups={preview.safetyNumber} />
        </>
      ) : (
        <DialogField label={t("Invitation link")} htmlFor="space-invitation-code">
          <input
            id="space-invitation-code"
            className="dialog-input"
            value={code}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setCode(event.target.value.trim())}
          />
        </DialogField>
      )}
    </Dialog>
  );
}
