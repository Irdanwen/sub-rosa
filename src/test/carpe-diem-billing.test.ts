import { describe, expect, it } from "vitest";
import { deriveBilling } from "../lib/carpe-diem-billing";
import type { CarpeDiemBillingDto } from "../lib/tauri";

const billing = (over: Partial<CarpeDiemBillingDto> = {}): CarpeDiemBillingDto => ({
  availableCredits: 0,
  availableUsdc: 0,
  prepaidRegistered: false,
  prepaidUsdcBalance: 0,
  rail: "auto",
  railFallback: false,
  hasPrepaidAccount: false,
  ...over,
});

describe("deriveBilling", () => {
  it("flags the 'Rosa - Spot' trap: auto routes to an empty prepaid while credits sit unused", () => {
    // Exactly the incident: 1000 credits ($10) available, prepaid account empty.
    const view = deriveBilling(
      billing({
        availableCredits: 1000,
        availableUsdc: 10,
        prepaidRegistered: true,
        prepaidUsdcBalance: 0,
        rail: "auto",
        hasPrepaidAccount: true,
      }),
    );
    expect(view.effectiveRail).toBe("prepaid");
    expect(view.activeRailEmpty).toBe(true);
    expect(view.fundsElsewhere).toBe(true);
    expect(view.otherBalanceUsdc).toBe(10);
  });

  it("is healthy once the rail is forced to credits", () => {
    const view = deriveBilling(
      billing({
        availableUsdc: 10,
        availableCredits: 1000,
        rail: "credits",
        hasPrepaidAccount: true,
      }),
    );
    expect(view.effectiveRail).toBe("credits");
    expect(view.activeRailEmpty).toBe(false);
  });

  it("auto resolves to credits when no prepaid account is registered", () => {
    const view = deriveBilling(
      billing({ availableUsdc: 5, rail: "auto", hasPrepaidAccount: false }),
    );
    expect(view.effectiveRail).toBe("credits");
    expect(view.activeRailEmpty).toBe(false);
  });

  it("reports no funds elsewhere when both rails are empty", () => {
    const view = deriveBilling(
      billing({ rail: "auto", hasPrepaidAccount: true, prepaidRegistered: true }),
    );
    expect(view.activeRailEmpty).toBe(true);
    expect(view.fundsElsewhere).toBe(false);
  });
});
