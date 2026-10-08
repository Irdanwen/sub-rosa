/**
 * What the transactions say, as pure functions: the browser's port of
 * `finance/summary.rs` (with `rules::pattern_for` and `text::normalize`), so
 * the Finances panel and the assistant's tools say on the web what they say
 * in the app. Amounts are integers in minor units, as the rows travel.
 */
import exported from "@subrosa/chat-core/web/finance.json";

export interface FinanceExport {
  tools: {
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }[];
  categories: string[];
  notSpending: string[];
  uncategorized: string;
  searchLimit: number;
  topMerchants: number;
  tables: Record<string, { kind: "settings" | "artifact"; columns: string[] }>;
}
export const FINANCE = exported as FinanceExport;

export interface TransactionRow {
  id: string;
  account: string;
  /** `YYYY-MM-DD`. */
  bookedOn: string;
  amountMinor: number;
  currency: string;
  description: string;
  counterparty: string;
  category: string;
  balanceMinor: number | null;
  createdAt: string;
}

export interface CategoryAmount {
  category: string;
  amountMinor: number;
}
export interface MonthSpending {
  month: string;
  spendingMinor: number;
  incomeMinor: number;
  byCategory: CategoryAmount[];
}
export interface MerchantAmount {
  name: string;
  amountMinor: number;
  count: number;
}
export interface BalancePoint {
  day: string;
  balanceMinor: number;
}
export interface Overview {
  currency: string;
  currencies: string[];
  transactions: number;
  spendingMinor: number;
  incomeMinor: number;
  months: MonthSpending[];
  categories: CategoryAmount[];
  merchants: MerchantAmount[];
  balance: BalancePoint[];
  balanceKnown: boolean;
}

const FOLD: Record<string, string> = {
  à: "a",
  á: "a",
  â: "a",
  ä: "a",
  ã: "a",
  å: "a",
  ç: "c",
  è: "e",
  é: "e",
  ê: "e",
  ë: "e",
  ì: "i",
  í: "i",
  î: "i",
  ï: "i",
  ñ: "n",
  ò: "o",
  ó: "o",
  ô: "o",
  ö: "o",
  õ: "o",
  ù: "u",
  ú: "u",
  û: "u",
  ü: "u",
  " ": " ",
  " ": " ",
  "\t": " ",
};

/** `text::normalize`: lowercase, the listed accents folded, trimmed of
 * spaces, colons and quotes, one space between words. */
export function normalize(text: string): string {
  const folded = Array.from(text.toLowerCase())
    .map((character) => FOLD[character] ?? character)
    .join("");
  return folded
    .replace(/^[\s:"]+|[\s:"]+$/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** `rules::pattern_for`: the payee when there is one, else the first three
 * words of the description that hold no digit. */
export function patternFor(description: string, counterparty: string): string {
  if (counterparty.trim()) return counterparty.trim();
  return description
    .split(/\s+/)
    .filter((word) => word && !/[0-9]/.test(word))
    .slice(0, 3)
    .join(" ");
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function spends(row: TransactionRow) {
  return row.amountMinor < 0 && !FINANCE.notSpending.includes(row.category);
}
function earns(row: TransactionRow) {
  return row.amountMinor > 0 && !FINANCE.notSpending.includes(row.category);
}

function sorted(totals: Map<string, number>): CategoryAmount[] {
  return [...totals]
    .map(([category, amountMinor]) => ({ category, amountMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor || compare(a.category, b.category));
}

/** The currency most rows use. */
export function mainCurrency(rows: TransactionRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.currency, (counts.get(row.currency) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))[0]?.[0] ?? "";
}

/** Summarises `rows` (oldest first) in `currency`, or in the main one. */
export function overview(rows: TransactionRow[], currency?: string | null): Overview {
  const chosen = currency ?? mainCurrency(rows);
  const currencies = [...new Set(rows.map((row) => row.currency))].sort(compare);
  const own = rows.filter((row) => row.currency === chosen);
  const months = new Map<
    string,
    { spending: number; income: number; categories: Map<string, number> }
  >();
  const categories = new Map<string, number>();
  const merchants = new Map<string, MerchantAmount>();
  let spending = 0;
  let income = 0;
  for (const row of own) {
    const month = Array.from(row.bookedOn).slice(0, 7).join("");
    let entry = months.get(month);
    if (!entry) {
      entry = { spending: 0, income: 0, categories: new Map() };
      months.set(month, entry);
    }
    if (spends(row)) {
      const amount = -row.amountMinor;
      spending += amount;
      entry.spending += amount;
      entry.categories.set(row.category, (entry.categories.get(row.category) ?? 0) + amount);
      categories.set(row.category, (categories.get(row.category) ?? 0) + amount);
      const name = patternFor(row.description, row.counterparty);
      const key = normalize(name);
      const merchant = merchants.get(key) ?? { name, amountMinor: 0, count: 0 };
      merchant.amountMinor += amount;
      merchant.count += 1;
      merchants.set(key, merchant);
    } else if (earns(row)) {
      income += row.amountMinor;
      entry.income += row.amountMinor;
    }
  }
  const ranked = [...merchants]
    .filter(([key]) => key !== "")
    .map(([, merchant]) => merchant)
    .sort((a, b) => b.amountMinor - a.amountMinor || compare(a.name, b.name))
    .slice(0, FINANCE.topMerchants);
  const { points, known } = balanceSeries(own);
  return {
    currency: chosen,
    currencies,
    transactions: own.length,
    spendingMinor: spending,
    incomeMinor: income,
    months: [...months]
      .sort(([a], [b]) => compare(a, b))
      .map(([month, value]) => ({
        month,
        spendingMinor: value.spending,
        incomeMinor: value.income,
        byCategory: sorted(value.categories),
      })),
    categories: sorted(categories),
    merchants: ranked,
    balance: points,
    balanceKnown: known,
  };
}

/** One point a day: with stated balances, each account's latest carried
 * forward and added across accounts; without, the running sum. */
export function balanceSeries(rows: TransactionRow[]): { points: BalancePoint[]; known: boolean } {
  const known = rows.some((row) => row.balanceMinor !== null);
  const days = new Map<string, number>();
  if (known) {
    const latest = new Map<string, number>();
    for (const row of rows) {
      if (row.balanceMinor !== null) latest.set(row.account, row.balanceMinor);
      days.set(
        row.bookedOn,
        [...latest.values()].reduce((sum, value) => sum + value, 0),
      );
    }
  } else {
    let running = 0;
    for (const row of rows) {
      running += row.amountMinor;
      days.set(row.bookedOn, running);
    }
  }
  return {
    points: [...days]
      .sort(([a], [b]) => compare(a, b))
      .map(([day, balanceMinor]) => ({ day, balanceMinor })),
    known,
  };
}
