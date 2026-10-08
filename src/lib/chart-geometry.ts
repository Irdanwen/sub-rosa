// The chart arithmetic is shared with the web client
// (`@subrosa/chat-core/chart-geometry`); the app formats in its own locale
// and words.
import { formatPercentIn, formatTickIn, formatValueIn } from "@subrosa/chat-core/chart-geometry";
import { intlLocale, t } from "./i18n";

export * from "@subrosa/chat-core/chart-geometry";

/** A value as the tooltip and the table show it: full precision, grouped. */
export function formatValue(value: number | null, unit?: string): string {
  return formatValueIn(intlLocale(), t("No value"), value, unit);
}

/** A tick label: short, so 1,200,000 reads 1.2M on a narrow axis. */
export function formatTick(value: number, unit?: string): string {
  return formatTickIn(intlLocale(), value, unit);
}

export function formatPercent(fraction: number): string {
  return formatPercentIn(intlLocale(), fraction);
}
