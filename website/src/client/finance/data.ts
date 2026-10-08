/**
 * The person's transactions as this browser holds them: the synchronised
 * `transactions` rows (present only when they opted in to finance sync on a
 * device that imported a statement, ADR-0099), and the two read-only tools
 * answered from them the way `finance/tool.rs` answers from SQLite.
 */
import type { SyncClient } from "../sync";
import { FINANCE, overview, type TransactionRow } from "./summary";

const text = (value: unknown) => (typeof value === "string" ? value : "");
const integer = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;

/** Every live transaction, oldest first (`booked_on, created_at, id`). */
export function transactions(sync: SyncClient): TransactionRow[] {
  return sync
    .rows("transactions")
    .map((object) => {
      const row = object.row;
      return {
        id: object.id,
        account: text(row.account),
        bookedOn: text(row.booked_on),
        amountMinor: integer(row.amount_minor) ?? 0,
        currency: text(row.currency),
        description: text(row.description),
        counterparty: text(row.counterparty),
        category: text(row.category),
        balanceMinor: integer(row.balance_minor),
        createdAt: text(row.created_at),
      };
    })
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.bookedOn))
    .sort(
      (a, b) =>
        a.bookedOn.localeCompare(b.bookedOn) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
}

const units = (minor: number) => minor / 100;

function day(value: unknown): string | null | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || Number.isNaN(Date.parse(trimmed))) return null;
  return trimmed;
}
function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const INVALID_DAY = "This date is not valid.";

/** `spending_summary`. */
export function spending(
  rows: TransactionRow[],
  args: Record<string, unknown>,
  now = new Date(),
): Record<string, unknown> {
  const today = localDay(now);
  const back = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 92);
  const defaultFrom = localDay(new Date(back.getFullYear(), back.getMonth(), 1));
  const from = day(args.from);
  const to = day(args.to);
  if (from === null || to === null) return { error: INVALID_DAY };
  const start = from ?? defaultFrom;
  const end = to ?? today;
  let chosen = rows.filter((row) => row.bookedOn >= start && row.bookedOn <= end);
  if (typeof args.category === "string") {
    const category = args.category.trim();
    chosen = chosen.filter((row) => row.category === category);
  }
  const currency = typeof args.currency === "string" ? args.currency.toUpperCase() : null;
  const summary = overview(chosen, currency);
  const label = (category: string) => category || FINANCE.uncategorized;
  const last = summary.balance.at(-1);
  return {
    from: start,
    to: end,
    currency: summary.currency,
    otherCurrencies: summary.currencies.filter((code) => code !== summary.currency),
    transactions: summary.transactions,
    spending: units(summary.spendingMinor),
    income: units(summary.incomeMinor),
    byCategory: summary.categories.map((item) => ({
      category: label(item.category),
      spent: units(item.amountMinor),
    })),
    byMonth: summary.months.map((month) => ({
      month: month.month,
      spent: units(month.spendingMinor),
      income: units(month.incomeMinor),
      topCategories: month.byCategory.slice(0, 5).map((item) => ({
        category: label(item.category),
        spent: units(item.amountMinor),
      })),
    })),
    topMerchants: summary.merchants.map((merchant) => ({
      name: merchant.name,
      spent: units(merchant.amountMinor),
      count: merchant.count,
    })),
    balance: last
      ? { day: last.day, amount: units(last.balanceMinor), stated: summary.balanceKnown }
      : null,
  };
}

function minor(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : null;
}

export interface Filter {
  query?: string;
  category?: string;
  from?: string;
  to?: string;
  minAmount?: number | null;
  maxAmount?: number | null;
  limit?: number;
}

/** The store's search: every word in the description or the payee (case
 * folded like SQLite's LIKE), newest first. */
export function filtered(rows: TransactionRow[], filter: Filter): TransactionRow[] {
  const words = (filter.query ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 6);
  const out = rows.filter((row) => {
    const haystack = `${row.description}\n${row.counterparty}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word.toLowerCase()))) return false;
    if (filter.category !== undefined && row.category !== filter.category.trim()) return false;
    if (filter.from && row.bookedOn < filter.from) return false;
    if (filter.to && row.bookedOn > filter.to) return false;
    if (filter.minAmount != null && row.amountMinor < filter.minAmount) return false;
    if (filter.maxAmount != null && row.amountMinor > filter.maxAmount) return false;
    return true;
  });
  out.reverse();
  return filter.limit ? out.slice(0, filter.limit) : out;
}

/** `transactions_search`. */
export function search(rows: TransactionRow[], args: Record<string, unknown>) {
  const from = day(args.from);
  const to = day(args.to);
  if (from === null || to === null) return { error: INVALID_DAY };
  const asked = integer(args.limit);
  const found = filtered(rows, {
    query: typeof args.query === "string" ? args.query : undefined,
    category: typeof args.category === "string" ? args.category : undefined,
    from: from ?? undefined,
    to: to ?? undefined,
    minAmount: minor(args.min_amount),
    maxAmount: minor(args.max_amount),
    limit: asked === null ? 15 : Math.min(FINANCE.searchLimit, Math.max(1, asked)),
  });
  return {
    count: found.length,
    transactions: found.map((row) => ({
      date: row.bookedOn,
      amount: units(row.amountMinor),
      currency: row.currency,
      description: row.description,
      payee: row.counterparty,
      category: row.category || FINANCE.uncategorized,
      account: row.account,
    })),
  };
}

export const SPENDING_TOOL = "spending_summary";
export const SEARCH_TOOL = "transactions_search";

/** Runs whichever tool was called, as JSON text for the model. */
export function runTool(rows: TransactionRow[], name: string, args: Record<string, unknown>) {
  return JSON.stringify(name === SPENDING_TOOL ? spending(rows, args) : search(rows, args));
}
