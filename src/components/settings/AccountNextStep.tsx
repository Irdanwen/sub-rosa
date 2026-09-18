import { t } from "../../lib/i18n";
import type { AccountStep } from "../../lib/account-next-step";

/**
 * The account panel is a page of controls. This says which one matters now, so
 * connecting a second device reads as a sequence rather than a search.
 */
export function AccountNextStep({
  step,
  busy,
  onRestoreKey,
}: {
  step: AccountStep;
  busy: boolean;
  onRestoreKey: () => void;
}) {
  if (step.id === "done") return null;

  const copy: Record<Exclude<AccountStep["id"], "done">, { title: string; detail: string }> = {
    "sign-in": {
      title: t("Sign in to your account"),
      detail: t("Approve this device in your browser, then come back here."),
    },
    "create-vault": {
      title: t("Create your vault"),
      detail: t(
        "Your notes and key are encrypted before they leave this device. Creating the vault gives you a recovery key; keep it safe.",
      ),
    },
    "open-vault": {
      title: t("Open your vault"),
      detail: t("Enter your recovery key below. Signing in alone cannot unlock your data."),
    },
    "confirm-recovery": {
      title: t("Confirm your recovery key"),
      detail: t("Type it back below, so a lost device never costs you your notes."),
    },
    "restore-key": {
      title: t("Bring your Carpe Diem key to this device"),
      detail: t("It is restored from your vault; nothing is typed again."),
    },
  };
  const { title, detail } = copy[step.id];

  return (
    <div className="settings-card account-card account-next-step">
      <p className="account-next-step-position">
        {t("Step {index} of {total}", { index: String(step.index), total: String(step.total) })}
      </p>
      <strong>{title}</strong>
      <p className="settings-row-description">{detail}</p>
      {step.id === "restore-key" ? (
        <div className="account-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onRestoreKey}>
            {t("Restore my key")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
