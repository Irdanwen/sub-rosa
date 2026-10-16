import type { DeviceKeyUsage } from "../../lib/carpe-diem-issue";
import { t } from "../../lib/i18n";
import { formatCredits } from "../../lib/studio/catalog";

/**
 * One line under a device in the account's list: whether it holds a Carpe
 * Diem key and what it spent over 30 days. Nothing for a device Carpe Diem
 * does not tie to a key (a pasted key, an older app, Carpe Diem unreachable):
 * an absence there means "not known", never "no key".
 */
export function DeviceKeyLine({ usage }: { usage: DeviceKeyUsage | undefined }) {
  if (!usage) return null;
  if (!usage.active)
    return <p className="settings-row-description">{t("Its Carpe Diem key no longer works.")}</p>;
  return (
    <p className="settings-row-description">
      {usage.spentCredits > 0
        ? t("Carpe Diem key active, {credits} spent in the last 30 days.", {
            credits: formatCredits(usage.spentCredits),
          })
        : t("Carpe Diem key active, nothing spent in the last 30 days.")}
    </p>
  );
}
