import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { DEFAULT_BLOCKED_COUNTRIES, carpeDiemIssuanceStatus } from "./carpe-diem-issue";
import { type StoreContext, payLinkAllowed } from "./store-policy";

/**
 * Buying credits by card (ADR-0069). Carpe Diem is the merchant: the app asks
 * it for a checkout with this device's key, opens the pay page in the
 * browser, and then only watches the balance. The card never reaches the app.
 */

export type CreditTier = { id: string; usdCents: number; credits: number };
export type CreditTiers = { currency: "usd"; tiers: CreditTier[] };
export type Purchase = {
  id: string;
  kind: "purchase" | "refund";
  usd: number;
  credits: number;
  at: string;
};

export const carpeDiemCreditTiers = () => invoke<CreditTiers>("carpe_diem_credit_tiers");
export const carpeDiemOpenCheckout = (tier: string | null) =>
  invoke<{ expiresAt: string }>("carpe_diem_open_checkout", { tier });
export const carpeDiemPurchases = () => invoke<Purchase[]>("carpe_diem_purchases");
export const storeContext = () => invoke<StoreContext>("store_context");

export {
  markFirstPurchasePending,
  notifyCreditsChanged,
  onAddCreditsRequested,
  takeFirstPurchasePending,
  onCreditsChanged,
  requestAddCredits,
} from "./credits-events";
import { notifyCreditsChanged } from "./credits-events";

// --- Watching for the payment to land ------------------------------------------

export const FAST_POLL_MS = 3_000;
export const FAST_POLL_WINDOW_MS = 120_000;

/**
 * After the pay page opens, asks for the balance every few seconds for two
 * minutes and stops at the first increase. A convenience only: the ordinary
 * minute poll and the refresh on focus remain the truth, so a phone that
 * suspends mid-payment loses nothing (ADR-0018).
 */
export function watchForPayment({
  baseline,
  read,
  onArrived,
  intervalMs = FAST_POLL_MS,
  windowMs = FAST_POLL_WINDOW_MS,
}: {
  baseline: number;
  read: () => Promise<number | null>;
  onArrived: (available: number) => void;
  intervalMs?: number;
  windowMs?: number;
}) {
  const until = Date.now() + windowMs;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      const available = await read();
      if (stopped) return;
      if (available !== null && available > baseline) {
        stopped = true;
        notifyCreditsChanged();
        onArrived(available);
        return;
      }
    } catch {
      // A failed read is just a missed beat.
    }
    if (Date.now() + intervalMs > until) return;
    timer = setTimeout(() => void tick(), intervalMs);
  };
  timer = setTimeout(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

// --- May this copy show a pay link? ---------------------------------------------

export type PayPolicy = {
  /** A pay link may be shown here. */
  linkAllowed: boolean;
  /** Carpe Diem sells credits by card. */
  fiat: boolean;
};

let cached: Promise<PayPolicy> | null = null;

async function loadPolicy(): Promise<PayPolicy> {
  const [context, status] = await Promise.all([
    storeContext().catch(() => null),
    carpeDiemIssuanceStatus().catch(() => null),
  ]);
  const blocked =
    status && Array.isArray(status.blockedCountries)
      ? status.blockedCountries
      : DEFAULT_BLOCKED_COUNTRIES;
  return {
    linkAllowed: payLinkAllowed(context, blocked),
    fiat: status?.fiat === true,
  };
}

/** Test seam: forget the cached answer. */
export function resetPayPolicyCache() {
  cached = null;
}

/**
 * The pay-link answer for this copy of the app, asked once per launch.
 * `null` while it is on its way: callers show no purchase control until they
 * know one is allowed.
 */
export function usePayPolicy(): PayPolicy | null {
  const [policy, setPolicy] = useState<PayPolicy | null>(null);
  useEffect(() => {
    let live = true;
    cached ??= loadPolicy().catch(() => ({ linkAllowed: false, fiat: false }));
    void cached.then((next) => {
      if (live) setPolicy(next);
    });
    return () => {
      live = false;
    };
  }, []);
  return policy;
}

/**
 * Whether this copy of the app may point anywhere a purchase happens, Carpe
 * Diem's own site included: getting a key there means funding it. False while
 * the answer is on its way, and on a store that forbids pointing outside it.
 * Every link or sentence that sends someone to buy goes through this, not only
 * the Add credits sheet.
 */
export function usePurchaseLinksAllowed(): boolean {
  return usePayPolicy()?.linkAllowed === true;
}

/** "$10", "$2.50": whole dollars without cents. */
export function formatUsdCents(cents: number, locale?: string) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}
