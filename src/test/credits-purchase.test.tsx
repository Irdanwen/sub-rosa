import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddCreditsDialog, AddCreditsHost } from "../components/carpe-diem/AddCreditsDialog";
import { onCreditsChanged, requestAddCredits } from "../lib/credits-events";
import {
  FAST_POLL_MS,
  FAST_POLL_WINDOW_MS,
  formatUsdCents,
  resetPayPolicyCache,
  watchForPayment,
} from "../lib/credits-purchase";
import { destinationUrl, parseDestination } from "../lib/destinations";
import { payLinkAllowed } from "../lib/store-policy";

/**
 * Credits by card (ADR-0069). Carpe Diem sells them; the app opens its page
 * and watches the balance. Where a store or a country rules a link out, the
 * app shows the balance and says nothing about buying elsewhere.
 */

const BLOCKED = ["IR", "KP", "CU", "SY", "SD", "SS", "MM", "RU", "BY", "US"];

describe("the pay-link policy", () => {
  it("lets a computer link anywhere Carpe Diem sells", () => {
    expect(payLinkAllowed({ platform: "desktop", distribution: "direct" }, BLOCKED)).toBe(true);
    expect(
      payLinkAllowed({ platform: "desktop", distribution: "direct", storefront: "RU" }, BLOCKED),
    ).toBe(false);
  });

  it("allows an iPhone link only on a storefront Apple allows and Carpe Diem serves", () => {
    const ios = (storefront: string | null) =>
      payLinkAllowed({ platform: "ios", distribution: "app-store", storefront }, BLOCKED);
    // Apple allows the US storefront, Carpe Diem does not sell there today.
    expect(ios("US")).toBe(false);
    expect(ios("CH")).toBe(false);
    expect(ios(null)).toBe(false);
    // The day Carpe Diem sells in the US, the US storefront gets its link.
    expect(
      payLinkAllowed({ platform: "ios", distribution: "app-store", storefront: "us" }, ["IR"]),
    ).toBe(true);
  });

  it("lets a sideloaded Android app link, and holds Play to the store rule", () => {
    expect(payLinkAllowed({ platform: "android", distribution: "direct" }, BLOCKED)).toBe(true);
    expect(
      payLinkAllowed({ platform: "android", distribution: "play", storefront: "US" }, BLOCKED),
    ).toBe(false);
    expect(
      payLinkAllowed({ platform: "android", distribution: "play", storefront: "US" }, []),
    ).toBe(true);
    expect(payLinkAllowed({ platform: "android", distribution: "play" }, [])).toBe(false);
    expect(payLinkAllowed({ platform: "android", distribution: "unknown" }, [])).toBe(false);
  });

  it("treats not knowing as no", () => {
    expect(payLinkAllowed(null, [])).toBe(false);
  });
});

describe("watching for a payment", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stops at the first increase and tells every balance to look again", async () => {
    const reads = [100, 100, 1100];
    const read = vi.fn(async () => reads.shift() ?? 1100);
    const arrived = vi.fn();
    const changed = vi.fn();
    const stopListening = onCreditsChanged(changed);
    watchForPayment({ baseline: 100, read, onArrived: arrived });
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 3);
    expect(arrived).toHaveBeenCalledWith(1100);
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 5);
    expect(read).toHaveBeenCalledTimes(3);
    stopListening();
  });

  it("gives up after two minutes, and survives failed reads", async () => {
    const read = vi.fn(async () => {
      throw new Error("offline");
    });
    watchForPayment({ baseline: 0, read, onArrived: vi.fn() });
    await vi.advanceTimersByTimeAsync(FAST_POLL_WINDOW_MS + FAST_POLL_MS * 3);
    expect(read.mock.calls.length).toBeLessThanOrEqual(FAST_POLL_WINDOW_MS / FAST_POLL_MS);
    expect(read.mock.calls.length).toBeGreaterThan(30);
  });

  it("can be stopped", async () => {
    const read = vi.fn(async () => 0);
    const stop = watchForPayment({ baseline: 0, read, onArrived: vi.fn() });
    stop();
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 4);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("the return link", () => {
  it("is one exact address, with nothing carried", () => {
    expect(parseDestination("subrosa://credits/return")).toEqual({ kind: "credits" });
    expect(parseDestination("subrosa://credits/return?session_id=cs_1")).toEqual({
      kind: "credits",
    });
    expect(parseDestination("subrosa://credits")).toBeNull();
    expect(parseDestination("subrosa://credits/steal")).toBeNull();
    expect(destinationUrl({ kind: "credits" })).toBe("subrosa://credits/return");
  });
});

describe("amounts", () => {
  it("reads as dollars", () => {
    expect(formatUsdCents(1000, "en-US")).toBe("$10");
    expect(formatUsdCents(250, "en-US")).toBe("$2.50");
  });
});

// --- The sheet ---------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getCredits: vi.fn(),
  openDashboard: vi.fn(async () => undefined),
  context: { platform: "desktop", distribution: "direct" } as Record<string, unknown>,
  fiat: true,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../lib/carpe-diem-credits", () => ({
  useCarpeDiemCredits: () => ({ availableCredits: 120, escrowCredits: 0, rail: "credits" }),
}));
vi.mock("../lib/tauri", () => ({
  carpeDiemGetCredits: mocks.getCredits,
  carpeDiemOpenDashboard: mocks.openDashboard,
  openExternalUrl: vi.fn(),
}));

beforeEach(() => {
  resetPayPolicyCache();
  mocks.invoke.mockReset();
  mocks.getCredits.mockReset();
  mocks.context = { platform: "desktop", distribution: "direct" };
  mocks.fiat = true;
  mocks.getCredits.mockResolvedValue({ availableCredits: 120 });
  mocks.invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case "store_context":
        return mocks.context;
      case "carpe_diem_issuance_status":
        return { keyIssuance: true, fiat: mocks.fiat, issued: true, blockedCountries: BLOCKED };
      case "carpe_diem_credit_tiers":
        return {
          currency: "usd",
          tiers: [
            { id: "usd_5", usdCents: 500, credits: 500 },
            { id: "usd_10", usdCents: 1000, credits: 1000 },
          ],
        };
      case "carpe_diem_purchases":
        return [
          { id: "cs:1", kind: "purchase", usd: 10, credits: 1000, at: "2026-09-30T10:00:00Z" },
        ];
      case "carpe_diem_open_checkout":
        return { expiresAt: "2030-01-01T00:00:00Z" };
      default:
        return undefined;
    }
  });
});

describe("the Add credits sheet", () => {
  it("offers Carpe Diem's amounts and opens its page for the one chosen", async () => {
    render(<AddCreditsDialog open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /\$10/ }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("carpe_diem_open_checkout", { tier: "usd_10" }),
    );
    expect(await screen.findByText(/Finish paying in your browser/)).toBeInTheDocument();
    expect(screen.getByText("Recent purchases")).toBeInTheDocument();
  });

  it("says the credits arrived once the balance moves", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<AddCreditsDialog open onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /\$5/ }));
    await screen.findByText(/Finish paying in your browser/);
    mocks.getCredits.mockResolvedValue({ availableCredits: 620 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
    });
    expect(await screen.findByText(/Your credits arrived/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("shows the balance and nothing to buy where no link may be shown", async () => {
    mocks.context = { platform: "ios", distribution: "app-store", storefront: "US" };
    render(<AddCreditsDialog open onClose={vi.fn()} />);
    expect(await screen.findByText("Recent purchases")).toBeInTheDocument();
    await act(async () => undefined);
    expect(screen.getByRole("heading", { name: "Your credits" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\$/ })).toBeNull();
    expect(screen.queryByText(/USDC|Carpe Diem site|browser/)).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("carpe_diem_credit_tiers");
  });

  it("points to the USDC path while card payments are not open yet", async () => {
    mocks.fiat = false;
    render(<AddCreditsDialog open onClose={vi.fn()} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Add funds on the Carpe Diem site" }),
    );
    expect(mocks.openDashboard).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /\$10/ })).toBeNull();
  });

  it("opens from anywhere through one request", async () => {
    render(<AddCreditsHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => requestAddCredits());
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
