import { invoke } from "@tauri-apps/api/core";
import type { ChartChatBlock } from "./chat-blocks-data";
import { intlLocale, t } from "./i18n";

/**
 * Finances (ADR-0099), for both shells. Bank statements the person exports
 * from their bank (CSV, OFX or QFX, camt.053) are read on this device into
 * one table of transactions. No bank and no aggregator is ever contacted.
 * The commands live in `src-tauri/src/finance/`.
 */

export type DateOrder = "dmy" | "ymd" | "mdy";

/** Which column holds what, as the person confirmed it (indices are 0-based). */
export type CsvMapping = {
  delimiter: string;
  headerRow: number;
  date: number | null;
  dateOrder: DateOrder;
  description: number[];
  amount: number | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
  currency: number | null;
  reference: number | null;
  counterparty: number | null;
  decimalComma: boolean;
  defaultCurrency: string;
};

export type CsvLayout = {
  preset: string;
  mapping: CsvMapping;
  headers: string[];
  sample: string[][];
  account: string;
};

export type StatementPreview = {
  format: "csv" | "ofx" | "camt053";
  preset: string;
  account: string;
  count: number;
  newCount: number;
  skipped: number;
  firstDay?: string | null;
  lastDay?: string | null;
  sample: { bookedOn: string; amountMinor: number; currency: string; description: string }[];
  alreadyImported: boolean;
  csv?: CsvLayout | null;
};

export type ImportResult = {
  statementId: string;
  added: number;
  skipped: number;
  categorized: number;
};

export type StatementRow = {
  id: string;
  fileName: string;
  format: string;
  preset: string;
  account: string;
  added: number;
  skipped: number;
  importedAt: string;
};

export type FinanceStatus = {
  sync: boolean;
  transactions: number;
  uncategorized: number;
  suggestions: number;
  statements: StatementRow[];
};

export type Transaction = {
  id: string;
  account: string;
  bookedOn: string;
  amountMinor: number;
  currency: string;
  description: string;
  counterparty: string;
  category: string;
  categorySource: "" | "rule" | "person";
  suggestion: string;
  balanceMinor?: number | null;
};

export type TransactionQuery = {
  search?: string;
  category?: string;
  from?: string;
  to?: string;
  suggested?: boolean;
  limit?: number;
  offset?: number;
};

export type FinanceRule = {
  id: string;
  pattern: string;
  isRegex: boolean;
  category: string;
  position: number;
};

export type CategoryAmount = { category: string; amountMinor: number };

export type FinanceOverview = {
  currency: string;
  currencies: string[];
  transactions: number;
  spendingMinor: number;
  incomeMinor: number;
  months: {
    month: string;
    spendingMinor: number;
    incomeMinor: number;
    byCategory: CategoryAmount[];
  }[];
  categories: CategoryAmount[];
  merchants: { name: string; amountMinor: number; count: number }[];
  balance: { day: string; balanceMinor: number }[];
  balanceKnown: boolean;
};

export type StatementFile = {
  fileName: string;
  /** The file's bytes, base64. */
  data: string;
  mapping?: CsvMapping | null;
  account?: string | null;
};

export const financeStatus = () => invoke<FinanceStatus>("finance_status");
export const financeSetSync = (sync: boolean) =>
  invoke<FinanceStatus>("finance_set_sync", { sync });
export const financePreview = (request: StatementFile) =>
  invoke<StatementPreview>("finance_preview", { request });
export const financeImport = (request: StatementFile) =>
  invoke<ImportResult>("finance_import", { request });
export const financeTransactions = (query: TransactionQuery) =>
  invoke<Transaction[]>("finance_transactions", { query });
export const financeSetCategory = (id: string, category: string, remember: boolean) =>
  invoke<number>("finance_set_category", { id, category, remember });
export const financeOverview = (from: string, to: string) =>
  invoke<FinanceOverview>("finance_overview", { from, to });
export const financeRules = () => invoke<FinanceRule[]>("finance_rules");
export const financeRuleAdd = (pattern: string, category: string, isRegex: boolean) =>
  invoke<number>("finance_rule_add", { pattern, category, isRegex });
export const financeRuleRemove = (id: string) => invoke<void>("finance_rule_remove", { id });
export const financeSuggest = () => invoke<number>("finance_suggest");
export const financeResolveSuggestions = (ids: string[], accept: boolean) =>
  invoke<number>("finance_resolve_suggestions", { ids, accept });
export const financeForget = (statementId?: string) =>
  invoke<FinanceStatus>("finance_forget", { statementId: statementId ?? null });
/** The budget engine bridge, outward: `transactions` (CSV) or `rules` (rules.json). */
export const financeExport = (kind: "transactions" | "rules") =>
  invoke<{ path: string | null; bytes: number; shared: boolean }>("finance_export", { kind });
/** The budget engine bridge, inward: its `config/rules.json`. */
export const financeImportRules = (data: string) =>
  invoke<number>("finance_import_rules", { data });

/** The categories the app names in every language (`finance::CATEGORIES`). */
export const CATEGORY_KEYS = [
  "groceries",
  "dining",
  "transport",
  "housing",
  "utilities",
  "health",
  "insurance",
  "shopping",
  "leisure",
  "travel",
  "subscriptions",
  "education",
  "taxes",
  "fees",
  "cash",
  "income",
  "savings",
  "transfers",
  "other",
] as const;

/** A category as the person reads it: a known key translated, their own word as written. */
export function categoryLabel(category: string): string {
  switch (category) {
    case "":
      return t("Uncategorized");
    case "groceries":
      return t("Groceries");
    case "dining":
      return t("Eating out");
    case "transport":
      return t("Transport");
    case "housing":
      return t("Housing");
    case "utilities":
      return t("Utilities and phone");
    case "health":
      return t("Health care");
    case "insurance":
      return t("Insurance");
    case "shopping":
      return t("Shopping");
    case "leisure":
      return t("Leisure");
    case "travel":
      return t("Travel");
    case "subscriptions":
      return t("Subscriptions");
    case "education":
      return t("Education");
    case "taxes":
      return t("Taxes");
    case "fees":
      return t("Bank fees");
    case "cash":
      return t("Cash");
    case "income":
      return t("Income");
    case "savings":
      return t("Savings");
    case "transfers":
      return t("Transfers");
    case "other":
      return t("Other");
    default:
      return category;
  }
}

/** The bank whose export was recognised. */
export function presetLabel(preset: string): string {
  switch (preset) {
    case "ubs":
      return "UBS";
    case "postfinance":
      return "PostFinance";
    case "raiffeisen":
      return "Raiffeisen";
    case "bcv":
      return "BCV";
    case "credit_agricole":
      return "Crédit Agricole";
    case "bnp":
      return "BNP Paribas";
    default:
      return t("Another bank");
  }
}

export function formatMoney(minor: number, currency: string): string {
  const value = minor / 100;
  if (/^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(intlLocale(), { style: "currency", currency }).format(value);
    } catch {
      // An unknown code falls through to a plain number.
    }
  }
  const number = new Intl.NumberFormat(intlLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  return currency ? `${number} ${currency}` : number;
}

/** YYYY-MM-DD of the first day of the month `months` months before today's. */
export function monthsBack(months: number, today = new Date()): string {
  const date = new Date(today.getFullYear(), today.getMonth() - months, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
}

function monthLabel(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(intlLocale(), { month: "short", year: "2-digit" }).format(
    new Date(year, number - 1, 1),
  );
}

const units = (minor: number) => Math.round(minor) / 100;

/** How many categories a stacked chart names before folding the rest into "Other". */
const STACKED_CATEGORIES = 5;

/** Spending month by month, stacked by the largest categories. */
export function monthlySpendingChart(overview: FinanceOverview): ChartChatBlock {
  const top = overview.categories.slice(0, STACKED_CATEGORIES).map((entry) => entry.category);
  const rest = overview.categories.length > top.length;
  const series = top.map((category) => ({
    name: categoryLabel(category),
    values: overview.months.map((month) =>
      units(month.byCategory.find((entry) => entry.category === category)?.amountMinor ?? 0),
    ),
  }));
  if (rest) {
    series.push({
      name: t("Everything else"),
      values: overview.months.map((month) =>
        units(
          month.byCategory
            .filter((entry) => !top.includes(entry.category))
            .reduce((sum, entry) => sum + entry.amountMinor, 0),
        ),
      ),
    });
  }
  return {
    kind: "chart",
    type: "bar",
    title: t("Spending by month"),
    unit: overview.currency,
    stacked: true,
    categories: overview.months.map((month) => monthLabel(month.month)),
    series,
    scatter: [],
  };
}

/** Where the money went over the period, as a donut. */
export function categoryChart(overview: FinanceOverview): ChartChatBlock {
  return {
    kind: "chart",
    type: "donut",
    title: t("By category"),
    unit: overview.currency,
    stacked: false,
    categories: overview.categories.map((entry) => categoryLabel(entry.category)),
    series: [
      { name: t("Spending"), values: overview.categories.map((entry) => units(entry.amountMinor)) },
    ],
    scatter: [],
  };
}

export function merchantChart(overview: FinanceOverview): ChartChatBlock {
  return {
    kind: "chart",
    type: "bar",
    title: t("Top merchants"),
    unit: overview.currency,
    stacked: false,
    categories: overview.merchants.map((merchant) => merchant.name),
    series: [
      {
        name: t("Spending"),
        values: overview.merchants.map((merchant) => units(merchant.amountMinor)),
      },
    ],
    scatter: [],
  };
}

/** The balance over time, or the net flow when no statement stated a balance. */
export function balanceChart(overview: FinanceOverview): ChartChatBlock {
  const title = overview.balanceKnown ? t("Balance") : t("Net flow since the first transaction");
  return {
    kind: "chart",
    type: "line",
    title,
    unit: overview.currency,
    stacked: false,
    categories: overview.balance.map((point) => point.day),
    series: [{ name: title, values: overview.balance.map((point) => units(point.balanceMinor)) }],
    scatter: [],
  };
}

/** A file's text for the rules import (the budget engine's rules.json). */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error(t("This file could not be read. Choose it again.")));
    reader.readAsText(file);
  });
}
