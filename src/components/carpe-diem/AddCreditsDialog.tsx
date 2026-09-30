import { useCallback, useEffect, useRef, useState } from "react";
import { useCarpeDiemCredits } from "../../lib/carpe-diem-credits";
import {
  type CreditTier,
  type Purchase,
  carpeDiemCreditTiers,
  carpeDiemOpenCheckout,
  carpeDiemPurchases,
  formatUsdCents,
  onAddCreditsRequested,
  takeFirstPurchasePending,
  usePayPolicy,
  watchForPayment,
} from "../../lib/credits-purchase";
import { messageFromError } from "../../lib/errors";
import { intlLocale, t } from "../../lib/i18n";
import { formatCredits } from "../../lib/studio/catalog";
import { carpeDiemGetCredits, carpeDiemOpenDashboard } from "../../lib/tauri";
import { Dialog } from "../ui/Dialog";
import "./add-credits.css";

type Phase =
  | { kind: "choose" }
  | { kind: "opening"; tier: string }
  | { kind: "waiting" }
  | { kind: "arrived"; available: number }
  | { kind: "failed"; message: string };

/**
 * The balance, and a way to add to it where one may be offered (ADR-0069).
 *
 * The tiers come from Carpe Diem, which is the merchant; a tap opens its pay
 * page in the browser and the sheet waits for the balance to move. Where the
 * store or the country rules a link out (`store-policy.ts`) the sheet is the
 * balance and the history, and says nothing about buying elsewhere.
 */
export function AddCreditsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const credits = useCarpeDiemCredits();
  const policy = usePayPolicy();
  const [tiers, setTiers] = useState<CreditTier[] | null>(null);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "choose" });
  const stopWatching = useRef<(() => void) | null>(null);
  const card = policy?.linkAllowed === true && policy.fiat;

  useEffect(() => {
    if (!open) return;
    let live = true;
    setPhase({ kind: "choose" });
    carpeDiemPurchases().then(
      (list) => live && setPurchases(list),
      () => undefined,
    );
    if (card) {
      carpeDiemCreditTiers().then(
        (next) => live && setTiers(next.tiers),
        () => live && setTiers([]),
      );
    }
    return () => {
      live = false;
    };
  }, [open, card]);

  useEffect(
    () => () => {
      stopWatching.current?.();
    },
    [],
  );

  const buy = useCallback(
    async (tier: CreditTier) => {
      setPhase({ kind: "opening", tier: tier.id });
      try {
        await carpeDiemOpenCheckout(tier.id);
        setPhase({ kind: "waiting" });
        stopWatching.current?.();
        stopWatching.current = watchForPayment({
          baseline: credits?.availableCredits ?? 0,
          read: () => carpeDiemGetCredits().then((next) => next.availableCredits),
          onArrived: (available) => {
            setPhase({ kind: "arrived", available });
            void carpeDiemPurchases().then(setPurchases, () => undefined);
          },
        });
      } catch (cause) {
        setPhase({ kind: "failed", message: messageFromError(cause) });
      }
    },
    [credits?.availableCredits],
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={card ? t("Add credits") : t("Your credits")}
      width={440}
      footer={
        <button type="button" className="primary-action" onClick={onClose}>
          {t("Close")}
        </button>
      }
    >
      <div className="add-credits">
        <p className="add-credits-balance">
          {credits ? formatCredits(credits.availableCredits) : t("Balance unavailable")}
          <span className="settings-row-description">
            {" "}
            {t("on your Carpe Diem account, shared by your devices")}
          </span>
        </p>

        {card ? (
          <>
            {phase.kind === "waiting" ? (
              <p role="status" className="settings-row-description">
                {t(
                  "Finish paying in your browser. Your balance updates here by itself when Carpe Diem confirms it.",
                )}
              </p>
            ) : phase.kind === "arrived" ? (
              <p role="status" className="settings-row-description">
                {t("Your credits arrived. You now have {credits}.", {
                  credits: formatCredits(phase.available),
                })}
              </p>
            ) : (
              <>
                <p className="settings-row-description">
                  {t(
                    "Choose an amount. Payment happens on Carpe Diem's page in your browser; your card never reaches Sub Rosa.",
                  )}
                </p>
                <div className="add-credits-tiers">
                  {tiers === null ? (
                    <p role="status" className="settings-row-description">
                      {t("Loading amounts…")}
                    </p>
                  ) : tiers.length === 0 ? (
                    <p className="settings-row-description">
                      {t("Amounts are unavailable right now. Try again in a moment.")}
                    </p>
                  ) : (
                    tiers.map((tier) => (
                      <button
                        key={tier.id}
                        type="button"
                        className="add-credits-tier"
                        disabled={phase.kind === "opening"}
                        onClick={() => void buy(tier)}
                      >
                        <strong>{formatUsdCents(tier.usdCents, intlLocale())}</strong>
                        <span>{formatCredits(tier.credits)}</span>
                      </button>
                    ))
                  )}
                </div>
                {phase.kind === "failed" ? (
                  <p role="alert" className="settings-row-description" data-ok="false">
                    {phase.message}
                  </p>
                ) : null}
              </>
            )}
          </>
        ) : null}

        {policy?.linkAllowed ? (
          <p className="settings-row-description">
            <button
              type="button"
              className="add-credits-link"
              onClick={() => void carpeDiemOpenDashboard().catch(() => undefined)}
            >
              {card ? t("Pay with USDC instead") : t("Add funds on the Carpe Diem site")}
            </button>
          </p>
        ) : null}

        {purchases.length > 0 ? (
          <div className="add-credits-history">
            <h3 className="settings-row-title">{t("Recent purchases")}</h3>
            <ul>
              {purchases.slice(0, 8).map((purchase) => (
                <li key={purchase.id}>
                  <span>{formatPurchaseDate(purchase.at)}</span>
                  <span>
                    {purchase.kind === "refund"
                      ? t("Refund: minus {credits}", { credits: formatCredits(purchase.credits) })
                      : t("{amount}: plus {credits}", {
                          amount: formatUsdCents(Math.round(purchase.usd * 100), intlLocale()),
                          credits: formatCredits(purchase.credits),
                        })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function formatPurchaseDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium" }).format(date);
}

/**
 * Mounted once per shell. Anything can ask for the sheet through
 * `requestAddCredits()`; the shell does not have to thread a callback down.
 */
export function AddCreditsHost() {
  const [open, setOpen] = useState(() => takeFirstPurchasePending());
  useEffect(() => onAddCreditsRequested(() => setOpen(true)), []);
  // Mounted only while open, so its balance poll runs only while it is seen.
  return open ? <AddCreditsDialog open onClose={() => setOpen(false)} /> : null;
}
