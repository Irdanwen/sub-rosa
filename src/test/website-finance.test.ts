// Finances in the web client (ADR-0099): the port of `finance/summary.rs`
// with its tests' vectors, the two read-only tools over synchronised rows,
// and when a turn is offered them.
// @ts-expect-error node:crypto is available in the Vitest runtime.
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isKnownTable } from "../../website/src/client/codec";
import type { FeatureHost } from "../../website/src/client/feature";
import { financeFeature } from "../../website/src/client/finance";
import { search, spending, transactions } from "../../website/src/client/finance/data";
import {
  balanceSeries,
  FINANCE,
  overview,
  patternFor,
  type TransactionRow,
} from "../../website/src/client/finance/summary";
import { memoryClientStore } from "../../website/src/client/store";
import { SyncClient } from "../../website/src/client/sync";
import { FakeJournal } from "./website-client-fakes";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

function row(day: string, amount: number, category: string, description: string): TransactionRow {
  return {
    id: `${day}${amount}${description}`,
    account: "CH93",
    bookedOn: day,
    amountMinor: amount,
    currency: "CHF",
    description,
    counterparty: "",
    category,
    balanceMinor: null,
    createdAt: "",
  };
}

describe("the summary (summary.rs)", () => {
  it("leaves transfers and income out of spending", () => {
    const summary = overview([
      row("2026-09-01", 520_000, "income", "Salaire"),
      row("2026-09-02", -8_450, "groceries", "Migros M Lausanne"),
      row("2026-09-03", -100_000, "transfers", "Virement compte epargne"),
      row("2026-09-15", -4_200, "groceries", "Migros M Lausanne"),
      row("2026-10-01", -180_000, "housing", "Loyer octobre"),
      row("2026-10-02", -1_250, "", "Kiosk"),
    ]);
    expect(summary.currency).toBe("CHF");
    expect(summary.spendingMinor).toBe(8_450 + 4_200 + 180_000 + 1_250);
    expect(summary.incomeMinor).toBe(520_000);
    expect(summary.months.map((month) => month.month)).toEqual(["2026-09", "2026-10"]);
    expect(summary.months[0].spendingMinor).toBe(12_650);
    expect(summary.categories[0].category).toBe("housing");
    expect(summary.categories).toContainEqual({ category: "", amountMinor: 1_250 });
    const migros = summary.merchants.find((merchant) => merchant.name.startsWith("Migros"));
    expect([migros?.amountMinor, migros?.count]).toEqual([12_650, 2]);
  });

  it("lists another currency, never adds it", () => {
    const euro = { ...row("2026-09-05", -5_000, "travel", "Hotel Lyon"), currency: "EUR" };
    const rows = [
      row("2026-09-02", -1_000, "dining", "Cafe"),
      row("2026-09-03", -2_000, "dining", "Cafe"),
      euro,
    ];
    expect(overview(rows).currencies).toEqual(["CHF", "EUR"]);
    expect(overview(rows).spendingMinor).toBe(3_000);
    expect(overview(rows, "EUR").spendingMinor).toBe(5_000);
  });

  it("carries stated balances forward across accounts", () => {
    const first = { ...row("2026-09-01", -1_000, "", "A"), balanceMinor: 10_000 };
    const second = { ...row("2026-09-02", -500, "", "B"), account: "FR76", balanceMinor: 2_000 };
    const third = { ...row("2026-09-03", -1_000, "", "C"), balanceMinor: 9_000 };
    const { points, known } = balanceSeries([first, second, third]);
    expect(known).toBe(true);
    expect(points.map((point) => point.balanceMinor)).toEqual([10_000, 12_000, 11_000]);
  });

  it("draws the net flow without balances", () => {
    const { points, known } = balanceSeries([
      row("2026-09-01", 1_000, "", "A"),
      row("2026-09-01", -300, "", "B"),
      row("2026-09-04", -200, "", "C"),
    ]);
    expect(known).toBe(false);
    expect(points.map((point) => point.balanceMinor)).toEqual([700, 500]);
  });

  it("names a merchant by its payee or the words without digits", () => {
    expect(patternFor("CARTE 1234 MIGROS M LAUSANNE 02.09", "")).toBe("CARTE MIGROS M");
    expect(patternFor("whatever", "  Coop  ")).toBe("Coop");
  });
});

describe("the tools over synchronised rows", () => {
  const ACCOUNT = "0191d1a4-0000-7000-8000-00000000a11c";
  async function synced() {
    const sync = new SyncClient(
      ACCOUNT,
      new Uint8Array(32).fill(3),
      memoryClientStore(),
      new FakeJournal().transport(),
    );
    const write = (
      id: string,
      day: string,
      amount: number,
      category: string,
      description: string,
    ) =>
      sync.write("transactions", {
        id,
        dedup_key: id,
        account: "CH93",
        booked_on: day,
        amount_minor: amount,
        currency: "CHF",
        description,
        counterparty: "",
        reference: null,
        balance_minor: null,
        category,
        category_source: "rule",
        created_at: `${day}T08:00:00.000Z`,
        updated_at: `${day}T08:00:00.000Z`,
      });
    await write(
      "0192f000-0000-7000-8000-000000000001",
      "2026-09-02",
      -8_450,
      "groceries",
      "Migros M Lausanne",
    );
    await write(
      "0192f000-0000-7000-8000-000000000002",
      "2026-09-20",
      -2_000,
      "dining",
      "Cafe du Port",
    );
    await write("0192f000-0000-7000-8000-000000000003", "2026-10-01", 520_000, "income", "Salaire");
    return sync;
  }

  it("registers the tables Rust exported", () => {
    expect(isKnownTable("transactions")).toBe(true);
    expect(isKnownTable("finance_rules")).toBe(true);
    expect(FINANCE.tools.map((tool) => tool.function.name)).toEqual([
      "spending_summary",
      "transactions_search",
    ]);
  });

  it("summarises spending in a period and searches newest first", async () => {
    const rows = transactions(await synced());
    expect(rows.map((item) => item.bookedOn)).toEqual(["2026-09-02", "2026-09-20", "2026-10-01"]);
    const summary = spending(rows, { from: "2026-09-01", to: "2026-10-31" }, new Date(2026, 9, 8));
    expect(summary).toMatchObject({
      currency: "CHF",
      spending: 104.5,
      income: 5200,
      transactions: 3,
    });
    expect(
      spending(rows, { category: "dining", from: "2026-09-01" }, new Date(2026, 9, 8)),
    ).toMatchObject({
      spending: 20,
    });
    expect(spending(rows, { from: "soon" })).toEqual({ error: "This date is not valid." });
    const found = search(rows, { query: "migros" });
    expect(found).toMatchObject({ count: 1 });
    expect(search(rows, {}).transactions?.map((item) => item.date)).toEqual([
      "2026-10-01",
      "2026-09-20",
      "2026-09-02",
    ]);
    expect(search(rows, { max_amount: 0, limit: 1 }).transactions).toEqual([
      expect.objectContaining({ amount: -20, category: "dining" }),
    ]);
  });

  it("offers the tools only when there is data, never in a temporary chat", async () => {
    const empty = new SyncClient(
      ACCOUNT,
      new Uint8Array(32).fill(3),
      memoryClientStore(),
      new FakeJournal().transport(),
    );
    const host = (sync: SyncClient) => ({ sync }) as unknown as FeatureHost;
    const turn = { chatId: "c", temporary: false, question: "How much did I spend?" };
    expect(await financeFeature.turn?.(host(empty), turn)).toBeNull();
    const sync = await synced();
    expect(
      await financeFeature.turn?.(host(sync), { ...turn, chatId: null, temporary: true }),
    ).toBeNull();
    const addition = await financeFeature.turn?.(host(sync), turn);
    expect(addition?.tools.map((tool) => tool.function.name)).toEqual([
      "spending_summary",
      "transactions_search",
    ]);
    const answer = JSON.parse(
      (await addition?.run?.("transactions_search", { query: "cafe" }, turn)) ?? "{}",
    );
    expect(answer.transactions[0].description).toBe("Cafe du Port");
    expect(await addition?.run?.("web_search", {}, turn)).toBeUndefined();
  });
});
