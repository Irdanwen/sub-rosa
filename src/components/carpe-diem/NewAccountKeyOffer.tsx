import { useState } from "react";
import { useIssuanceStatus } from "../../lib/carpe-diem-issue";
import { t } from "../../lib/i18n";
import { AccountSettingsSection } from "../settings/AccountSettingsSection";

/**
 * The first thing a new person on a computer is offered, above the key form:
 * an account with just an email address, and a Carpe Diem key made for this
 * device from it (ADR-0069). Hidden until Carpe Diem says it can do that, so
 * the key form stays the whole story before then.
 */
export function NewAccountKeyOffer() {
  const issuance = useIssuanceStatus();
  const [open, setOpen] = useState(false);
  if (!issuance?.keyIssuance) return null;
  return (
    <div className="settings-card account-card new-account-key-offer">
      {open ? (
        <AccountSettingsSection mode="create" onUseKey={() => setOpen(false)} />
      ) : (
        <>
          <h3 className="settings-row-title">{t("New here? Start with your email")}</h3>
          <p className="settings-row-description">
            {t(
              "Create your account and Carpe Diem makes a key for this device. No wallet, nothing to copy. You add credits by card afterwards.",
            )}
          </p>
          <div className="account-actions">
            <button
              type="button"
              className="primary-action primary-solid"
              onClick={() => setOpen(true)}
            >
              {t("Create my account")}
            </button>
          </div>
          <p className="settings-row-description">
            {t("Already have a Carpe Diem key? Paste it below.")}
          </p>
        </>
      )}
    </div>
  );
}
