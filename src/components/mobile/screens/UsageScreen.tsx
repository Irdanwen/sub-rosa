import { intlLocale, t } from "../../../lib/i18n";
import { useEffect, useState } from "react";
import { type CacheUsage, hasMeasuredTurns, parseCacheUsage } from "../../../lib/carpe-diem-cache";
import {
  estimateCostUsd,
  priceFor,
  type TextPrice,
  textPricing,
} from "../../../lib/carpe-diem-text-pricing";
import { carpeDiemCacheStats } from "../../../lib/tauri";
import { SettingsGroup, SettingsRow } from "../SettingsList";
import { StackHeader } from "../StackHeader";
import { storedChatModel } from "./AgentScreen";

/**
 * What this phone has spent, as its own pushed screen.
 *
 * The desktop has had a usage panel for a while; the phone had the credit
 * balance in the Studio header and nothing else, so there was no way to see
 * what a long chat had actually consumed. The ledger behind this is the same
 * one on both shells - Rust counts every completion either shell makes - so
 * this screen is a read, not a second accounting.
 *
 * The cost is estimated rather than reported: the operator stopped returning a
 * price per turn, so it is priced from the tokens at the operator's own rates
 * (see `carpe-diem-text-pricing`). It says so.
 */
export function UsageScreen({ onBack }: { onBack: () => void }) {
  const [usage, setUsage] = useState<CacheUsage | null>(null);
  const [prices, setPrices] = useState<TextPrice[]>([]);
  const model = storedChatModel();

  useEffect(() => {
    let cancelled = false;
    carpeDiemCacheStats().then(
      (raw) => {
        if (!cancelled) setUsage(parseCacheUsage(raw));
      },
      () => {},
    );
    textPricing().then(
      (next) => {
        if (!cancelled) setPrices(next);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const measured = usage ? hasMeasuredTurns(usage) : false;
  const price = priceFor(model, prices);
  const estimate = usage
    ? estimateCostUsd(
        {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cachedTokens: usage.cachedTokens,
        },
        price,
      )
    : undefined;
  const cachePercent =
    usage?.hitRatio !== undefined ? `${Math.round(usage.hitRatio * 100)}%` : undefined;

  return (
    <div className="mobile-screen">
      <StackHeader title={t("Usage")} onBack={onBack} />
      <div className="mobile-screen-body">
        {measured ? (
          <>
            <SettingsGroup title={t("Since launch")}>
              <SettingsRow label={t("Turns")} detail={formatCount(usage?.turns)} />
              <SettingsRow label={t("Prompt tokens")} detail={formatCount(usage?.promptTokens)} />
              <SettingsRow
                label={t("Completion tokens")}
                detail={formatCount(usage?.completionTokens)}
              />
              <SettingsRow
                label={t("Served from cache")}
                detail={
                  cachePercent
                    ? `${formatCount(usage?.cachedTokens)} · ${cachePercent}`
                    : formatCount(usage?.cachedTokens)
                }
              />
            </SettingsGroup>

            <SettingsGroup title={t("Cost")}>
              {estimate !== undefined ? (
                <SettingsRow
                  label={t("At most")}
                  detail={`$${estimate < 0.01 ? estimate.toFixed(4) : estimate.toFixed(2)}`}
                />
              ) : (
                <SettingsRow
                  label={t("Estimate")}
                  detail={
                    price
                      ? t("Nothing measured yet")
                      : t("No published price for the current chat model")
                  }
                />
              )}
            </SettingsGroup>

            <p className="mobile-settings-footnote">
              {price
                ? t(
                    "Priced from these tokens at {model} rates, the provider's own, with its multiplier applied. It is an upper bound: the provider no longer returns what it charged per turn. Counts every request this app has made since it started.",
                    { model: price.model },
                  )
                : t("Counts every request this app has made since it started.")}
            </p>
          </>
        ) : (
          <p className="mobile-settings-footnote">
            {t(
              "Nothing measured yet. Counting starts when the app does, so this is empty after a restart until the next message.",
            )}
          </p>
        )}
      </div>
    </div>
  );
}

function formatCount(value: number | undefined): string {
  return value === undefined ? t("Unavailable") : value.toLocaleString(intlLocale());
}
