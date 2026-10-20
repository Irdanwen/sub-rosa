import type { ReactNode } from "react";
import { useState } from "react";
import { t } from "../../lib/i18n";
import { Dialog } from "./Dialog";

type ConfirmDialogProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<unknown>;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = false,
}: ConfirmDialogProps) {
  // Defaults resolved at render, so they follow the locale like any other sentence.
  const confirmWords = confirmLabel ?? t("Confirm");
  const cancelWords = cancelLabel ?? t("Cancel");
  const [submitting, setSubmitting] = useState(false);

  async function handleConfirm() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onConfirm();
      onClose();
    } catch {
      // Keep the dialog open so callers can surface the error and retry.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
      title={title}
      description={description}
      width={420}
      footer={
        <>
          <button type="button" className="primary-action" onClick={onClose} disabled={submitting}>
            {cancelWords}
          </button>
          <button
            type="button"
            className={`primary-action primary-solid${destructive ? " primary-destructive" : ""}`}
            onClick={() => void handleConfirm()}
            disabled={submitting}
          >
            {confirmWords}
          </button>
        </>
      }
    >
      <div />
    </Dialog>
  );
}
