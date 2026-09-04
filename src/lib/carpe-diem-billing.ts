// Sub Rosa fork: interpret the rail-aware Carpe Diem billing view.
//
// Carpe Diem bills through two rails the user owns — a self-custodial prepaid
// account (USDC) and a non-refundable credits pool — and the active one can be
// empty while the other has funds. With no fallback, that empties into a 402
// even though the balance "looks" fine. This derives the one thing the UI
// needs to say plainly: is the rail that actually pays out of money, and is
// there money on the other rail a switch would reach?
import { intlLocale } from "./i18n";
import type { CarpeDiemBillingDto } from "./tauri";

// Below this the rail can't cover even a trivial request (matches the studio's
// sub-cent per-request costs; the observed trap floored at ~0).
const MIN_SPENDABLE_USDC = 0.01;

export type CarpeDiemBillingView = {
  billing: CarpeDiemBillingDto;
  /** The rail that actually pays. "auto" resolves to the prepaid account when
   * one is registered, otherwise the credits pool. */
  effectiveRail: "credits" | "prepaid";
  effectiveBalanceUsdc: number;
  /** The non-active rail's spendable dollars. */
  otherBalanceUsdc: number;
  /** The active rail can't pay — requests will 402. */
  activeRailEmpty: boolean;
  /** ...and the other rail holds funds a switch (or fallback) would reach. */
  fundsElsewhere: boolean;
};

export function deriveBilling(billing: CarpeDiemBillingDto): CarpeDiemBillingView {
  const effectiveRail: "credits" | "prepaid" =
    billing.rail === "auto" ? (billing.hasPrepaidAccount ? "prepaid" : "credits") : billing.rail;
  const effectiveBalanceUsdc =
    effectiveRail === "prepaid" ? billing.prepaidUsdcBalance : billing.availableUsdc;
  const otherBalanceUsdc =
    effectiveRail === "prepaid" ? billing.availableUsdc : billing.prepaidUsdcBalance;
  return {
    billing,
    effectiveRail,
    effectiveBalanceUsdc,
    otherBalanceUsdc,
    activeRailEmpty: effectiveBalanceUsdc < MIN_SPENDABLE_USDC,
    fundsElsewhere: otherBalanceUsdc >= MIN_SPENDABLE_USDC,
  };
}

export function formatUsd(value: number): string {
  return `$${value.toLocaleString(intlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
