import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  balanceChart,
  categoryLabel,
  type FinanceOverview,
  formatMoney,
  monthlySpendingChart,
  monthsBack,
} from "../lib/finance";
import {
  dayRange,
  formatHealthValue,
  type HealthDay,
  healthAverage,
  healthChart,
  localDay,
} from "../lib/health";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { FinancesView } from "../components/personal-data/FinancesView";
import { HealthView } from "../components/personal-data/HealthView";
import { StatementImportDialog } from "../components/personal-data/StatementImportDialog";

const metrics = (
  overrides: Record<string, Partial<{ enabled: boolean; sync: boolean; days: number }>> = {},
) =>
  ["steps", "sleep", "heart_rate", "resting_heart_rate", "workouts", "weight"].map((metric) => ({
    metric,
    enabled: false,
    sync: false,
    days: 0,
    lastDay: null,
    ...overrides[metric],
  }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listen.mockResolvedValue(() => {});
});

describe("health helpers", () => {
  const today = new Date(2026, 9, 14);

  it("lists the days of a window oldest first in the local calendar", () => {
    expect(dayRange(3, today)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14"]);
    expect(localDay(today)).toBe("2026-10-14");
  });

  it("draws totals as bars, rates as lines, and a missing day as a gap", () => {
    const days: HealthDay[] = [
      { metric: "steps", day: "2026-10-14", value: 8412.4, samples: 0 },
      { metric: "heart_rate", day: "2026-10-13", value: 71.6, low: 50, high: 140, samples: 0 },
    ];
    const range = dayRange(3, today);
    const steps = healthChart("steps", days, range);
    expect(steps.type).toBe("bar");
    expect(steps.series[0].values).toEqual([null, null, 8412]);
    const heart = healthChart("heart_rate", days, range);
    expect(heart.type).toBe("line");
    expect(heart.series[0].values).toEqual([null, 72, null]);
    expect(healthAverage("steps", days)).toBeCloseTo(8412.4);
    expect(healthAverage("weight", days)).toBeNull();
  });

  it("reads values the way a person says them", () => {
    expect(formatHealthValue("sleep", 425)).toBe("7 h 05");
    expect(formatHealthValue("workouts", 45)).toBe("45 min");
    expect(formatHealthValue("weight", 72.44)).toBe("72.4 kg");
    expect(formatHealthValue("steps", 8412)).toBe("8,412 steps walked");
  });
});

describe("finance helpers", () => {
  const overview: FinanceOverview = {
    currency: "CHF",
    currencies: ["CHF"],
    transactions: 9,
    spendingMinor: 100_00,
    incomeMinor: 0,
    months: [
      {
        month: "2026-09",
        spendingMinor: 100_00,
        incomeMinor: 0,
        byCategory: [
          { category: "housing", amountMinor: 40_00 },
          { category: "groceries", amountMinor: 20_00 },
          { category: "dining", amountMinor: 15_00 },
          { category: "transport", amountMinor: 10_00 },
          { category: "leisure", amountMinor: 8_00 },
          { category: "fees", amountMinor: 4_00 },
          { category: "", amountMinor: 3_00 },
        ],
      },
    ],
    categories: [
      { category: "housing", amountMinor: 40_00 },
      { category: "groceries", amountMinor: 20_00 },
      { category: "dining", amountMinor: 15_00 },
      { category: "transport", amountMinor: 10_00 },
      { category: "leisure", amountMinor: 8_00 },
      { category: "fees", amountMinor: 4_00 },
      { category: "", amountMinor: 3_00 },
    ],
    merchants: [],
    balance: [],
    balanceKnown: false,
  };

  it("stacks the five largest categories and folds the rest", () => {
    const chart = monthlySpendingChart(overview);
    expect(chart.stacked).toBe(true);
    expect(chart.series.map((series) => series.name)).toEqual([
      "Housing",
      "Groceries",
      "Eating out",
      "Transport",
      "Leisure",
      "Everything else",
    ]);
    expect(chart.series[5].values).toEqual([7]);
  });

  it("names its own categories and keeps the person's words", () => {
    expect(categoryLabel("")).toBe("Uncategorized");
    expect(categoryLabel("subscriptions")).toBe("Subscriptions");
    expect(categoryLabel("Courses")).toBe("Courses");
  });

  it("says when the line is a net flow rather than a balance", () => {
    expect(balanceChart(overview).title).toBe("Net flow since the first transaction");
    expect(balanceChart({ ...overview, balanceKnown: true }).title).toBe("Balance");
    // Its days read like the monthly chart's months, never as ISO dates
    // that a phone's axis cuts in half.
    const days = balanceChart({
      ...overview,
      balance: [
        { day: "2026-05-01", balanceMinor: 0 },
        { day: "2026-09-10", balanceMinor: 100 },
      ],
    }).categories;
    expect(days).toEqual(["May 1, 26", "Sep 10, 26"]);
  });

  it("formats money in its currency and counts months back", () => {
    expect(formatMoney(-8405, "CHF")).toContain("84.05");
    expect(formatMoney(1250, "")).toBe("12.50");
    expect(monthsBack(2, new Date(2026, 0, 15))).toBe("2025-11-01");
  });
});

describe("Health view", () => {
  it("on a computer says the data comes from a phone and offers no reading", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "health_status") {
        return { source: "none", availability: "elsewhere", metrics: metrics() };
      }
      if (command === "health_days") return [];
      throw new Error(command);
    });
    render(<HealthView />);
    expect(await screen.findByText("No health data yet")).toBeTruthy();
    expect(screen.getByText(/This computer has no health app/)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("health_refresh");
  });

  it("on a phone asks for exactly the measures picked and syncs one by one", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "health_days") return [];
      return { source: "healthkit", availability: "available", metrics: metrics() };
    });
    render(<HealthView />);
    const read = await screen.findByRole("switch", { name: "Read Sleep" });
    fireEvent.click(read);
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("health_choose", { metrics: ["sleep"] }),
    );
    fireEvent.click(screen.getByRole("switch", { name: "Sync Weight with your account" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("health_set_sync", {
        metric: "weight",
        sync: true,
      }),
    );
  });
});

describe("Finances view", () => {
  it("starts empty with the import and no bank contacted", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "finance_status") {
        return { sync: false, transactions: 0, uncategorized: 0, suggestions: 0, statements: [] };
      }
      if (command === "finance_overview") {
        return {
          currency: "",
          currencies: [],
          transactions: 0,
          spendingMinor: 0,
          incomeMinor: 0,
          months: [],
          categories: [],
          merchants: [],
          balance: [],
          balanceKnown: false,
        };
      }
      if (command === "finance_rules") return [];
      throw new Error(command);
    });
    render(<FinancesView />);
    expect(await screen.findByText("No statement yet")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Import a statement/ }).length).toBeGreaterThan(0);
    expect(
      screen
        .getByRole("switch", { name: "Sync finances with your account" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });
});

describe("Statement import", () => {
  it("reads the file, shows the mapping, and reads again with a corrected column", async () => {
    const mapping = {
      delimiter: ";",
      headerRow: 0,
      date: 0,
      dateOrder: "dmy",
      description: [1],
      amount: 2,
      debit: null,
      credit: null,
      balance: null,
      currency: null,
      reference: null,
      counterparty: null,
      decimalComma: true,
      defaultCurrency: "EUR",
    };
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "finance_preview") {
        return {
          format: "csv",
          preset: "bnp",
          account: "",
          count: 3,
          newCount: 3,
          skipped: 0,
          firstDay: "2026-09-15",
          lastDay: "2026-09-30",
          sample: [
            {
              bookedOn: "2026-09-30",
              amountMinor: -3872,
              currency: "EUR",
              description: "MONOPRIX",
            },
          ],
          alreadyImported: false,
          csv: {
            preset: "bnp",
            mapping,
            headers: ["Date operation", "Libelle court", "Montant operation"],
            sample: [],
            account: "",
          },
        };
      }
      if (command === "finance_import")
        return { statementId: "s", added: 3, skipped: 0, categorized: 1 };
      throw new Error(command);
    });
    const onImported = vi.fn();
    const file = new File(["Date operation;Libelle court;Montant operation\n"], "bnp.csv", {
      type: "text/csv",
    });
    render(<StatementImportDialog file={file} onClose={() => {}} onImported={onImported} />);
    expect(await screen.findByText(/CSV export, BNP Paribas/)).toBeTruthy();
    expect(screen.getByText("MONOPRIX")).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: "Balance" }), { target: { value: "2" } });
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenLastCalledWith("finance_preview", {
        request: expect.objectContaining({ mapping: expect.objectContaining({ balance: 2 }) }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Import 3 transactions" }));
    await waitFor(() =>
      expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ added: 3 })),
    );
    expect(mocks.invoke).toHaveBeenCalledWith("finance_import", {
      request: expect.objectContaining({
        fileName: "bnp.csv",
        mapping: expect.objectContaining({ balance: 2 }),
      }),
    });
  });
});
