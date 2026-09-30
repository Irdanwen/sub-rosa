import { useState } from "react";
import { useIssuanceStatus } from "../../lib/carpe-diem-issue";
import {
  markFirstPurchasePending,
  takeFirstPurchasePending,
  usePayPolicy,
} from "../../lib/credits-purchase";
import { t } from "../../lib/i18n";
import { AccountSettingsSection } from "../settings/AccountSettingsSection";
import { AddCreditsDialog } from "./AddCreditsDialog";

/**
 * The first thing a new person on a computer is offered, above the key form:
 * an account with just an email address, and a Carpe Diem key made for this
 * device from it (ADR-0069). Hidden until Carpe Diem says it can do that, so
 * the key form stays the whole story before then.
 *
 * A new key starts at zero, so the step that follows it is buying credits:
 * a button here, and if it is not taken, the shell opens the sheet once when
 * it mounts (the first run and the key gate go away as the engine starts).
 */
export function NewAccountKeyOffer({ ready = false }: { ready?: boolean } = {}) {
  const issuance = useIssuanceStatus();
  const policy = usePayPolicy();
  const [open, setOpen] = useState(false);
  const [issued, setIssued] = useState(false);
  const [buying, setBuying] = useState(false);
  if (!issuance?.keyIssuance) return null;
  // Once the engine runs on a key, the offer has nothing left to offer,
  // unless the person is in the middle of it.
  if (ready && !open) return null;
  const canBuy = policy?.linkAllowed === true;
  return (
    <div className="settings-card account-card new-account-key-offer">
      {open ? (
        <>
          <AccountSettingsSection
            mode="create"
            onUseKey={() => setOpen(false)}
            onKeyIssued={() => {
              setIssued(true);
              if (canBuy) markFirstPurchasePending();
            }}
          />
          {issued && canBuy ? (
            <div className="account-actions">
              <button
                type="button"
                className="primary-action primary-solid"
                onClick={() => {
                  // Asked for here: the shell need not ask again later.
                  takeFirstPurchasePending();
                  setBuying(true);
                }}
              >
                {t("Add credits")}
              </button>
            </div>
          ) : null}
          {buying ? <AddCreditsDialog open onClose={() => setBuying(false)} /> : null}
        </>
      ) : (
        <>
          <h3 className="settings-row-title">{t("New here? Start with your email")}</h3>
          <p className="settings-row-description">
            {canBuy
              ? t(
                  "Create your account and Carpe Diem makes a key for this device. No wallet, nothing to copy. You add credits by card afterwards.",
                )
              : t(
                  "Create your account and Carpe Diem makes a key for this device. No wallet, nothing to copy.",
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
