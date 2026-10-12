// Today's credit rate, said the way a person reads it. The API calls it a
// price multiplier ("x0.43"); both Studio shells show it as a discount next to
// the balance, and say what it means when the balance is opened.

import { t } from "../i18n";

/** Today's rate as a discount ("-57 %"), or nothing at the base price. */
export function rateBadge(multiplier: number | undefined): string | undefined {
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier)) return undefined;
  const percent = Math.round((1 - multiplier) * 100);
  if (percent === 0) return undefined;
  return percent > 0
    ? t("-{percent} %", { percent })
    : t("+{percent} %", { percent: Math.abs(percent) });
}

/** What the rate means, for the surface behind the credits pill. */
export function rateSentence(multiplier: number | undefined): string {
  const base = t("Credits pay for renders at the provider's price.");
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier)) return base;
  const percent = Math.round((1 - multiplier) * 100);
  if (percent === 0) return `${base} ${t("Today's rate is the base price.")}`;
  return `${base} ${
    percent > 0
      ? t(
          "Today's rate is {percent}% below the base price. It changes every day at midnight UTC.",
          {
            percent,
          },
        )
      : t(
          "Today's rate is {percent}% above the base price. It changes every day at midnight UTC.",
          {
            percent: Math.abs(percent),
          },
        )
  }`;
}
