import { useEffect, useState } from "react";
import { useCarpeDiemCredits } from "../../lib/carpe-diem-credits";
import {
  LOW_BALANCE_THRESHOLDS,
  type LowBalance,
  carpeDiemLowBalance,
  carpeDiemSetLowBalance,
} from "../../lib/carpe-diem-issue";
import { usePurchaseLinksAllowed } from "../../lib/credits-purchase";
import { requestAddCredits } from "../../lib/credits-events";
import { messageFromError } from "../../lib/errors";
import { t } from "../../lib/i18n";
import { ensureNotificationPermission } from "../../lib/notifications";
import { formatCredits } from "../../lib/studio/catalog";
import { carpeDiemOpenDashboard } from "../../lib/tauri";
import { IssuedKeyRow } from "./IssuedKeyRow";

/**
 * Carpe Diem, seen from the account: the balance every device of the account
 * draws on, a way to add to it where one may be offered, this device's key,
 * an alert when the balance runs low, and the way to what only Carpe Diem
 * can change. The rail and the endpoint stay in the Carpe Diem tab.
 *
 * Where the store or the country rules a purchase link out
 * (`store-policy.ts`), nothing here points at buying elsewhere: the credits
 * sheet shows the balance and its history, and the dashboard link is left
 * out, since that page sells credits too.
 */
export function AccountCarpeDiemCard({
  issuedKey,
  onKeyChanged,
}: {
  issuedKey: boolean;
  onKeyChanged: () => void | Promise<void>;
}) {
  const credits = useCarpeDiemCredits();
  const linkAllowed = usePurchaseLinksAllowed();
  const [alert, setAlert] = useState<LowBalance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    carpeDiemLowBalance().then(
      (next) => {
        if (live && next && typeof next === "object") setAlert(next);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  const chooseThreshold = async (value: string) => {
    setError(null);
    const threshold = value === "" ? null : Number(value);
    try {
      if (threshold !== null) await ensureNotificationPermission("balance");
      setAlert(await carpeDiemSetLowBalance(threshold));
    } catch (cause) {
      setError(messageFromError(cause));
    }
  };

  return (
    <div className="settings-card account-card account-carpe-diem">
      <h3 className="settings-row-title">{t("Carpe Diem")}</h3>
      <div className="settings-row">
        <div className="settings-row-info">
          <p className="settings-row-title">
            {credits
              ? t("{credits} available", { credits: formatCredits(credits.availableCredits) })
              : t("Balance unavailable")}
          </p>
          <p className="settings-row-description">
            {credits
              ? t("Every device of your account draws on this balance.")
              : t("Your balance shows here once this device has a Carpe Diem key.")}
          </p>
        </div>
        <div className="settings-row-control">
          <button type="button" className="btn btn-secondary" onClick={() => requestAddCredits()}>
            {linkAllowed ? t("Add credits") : t("Balance and purchases")}
          </button>
        </div>
      </div>

      {issuedKey ? <IssuedKeyRow onChanged={onKeyChanged} /> : null}

      <div className="settings-row">
        <div className="settings-row-info">
          <label className="settings-row-title" htmlFor="low-balance-threshold">
            {t("Tell me when the balance runs low")}
          </label>
          <p className="settings-row-description">
            {t(
              "A notification on this device when your balance drops under the amount you choose, once each time.",
            )}
          </p>
          {error ? (
            <p role="alert" className="settings-row-description" data-ok="false">
              {error}
            </p>
          ) : null}
        </div>
        <div className="settings-row-control">
          <select
            id="low-balance-threshold"
            value={alert?.threshold == null ? "" : String(alert.threshold)}
            disabled={alert === null}
            onChange={(event) => void chooseThreshold(event.target.value)}
          >
            <option value="">{t("Off")}</option>
            {LOW_BALANCE_THRESHOLDS.map((threshold) => (
              <option key={threshold} value={threshold}>
                {t("Under {credits}", { credits: formatCredits(threshold) })}
              </option>
            ))}
          </select>
        </div>
      </div>

      {linkAllowed ? (
        <div className="settings-row">
          <div className="settings-row-info">
            <p className="settings-row-title">{t("Your Carpe Diem account")}</p>
            <p className="settings-row-description">
              {t(
                "Delete it, link a wallet or revoke a key on Carpe Diem's dashboard. It asks for a code sent to your email.",
              )}
            </p>
          </div>
          <div className="settings-row-control">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void carpeDiemOpenDashboard().catch(() => undefined)}
            >
              {t("Open the dashboard")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
