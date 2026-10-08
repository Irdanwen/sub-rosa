import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { useEffect, useState } from "react";
import { messageFromError } from "../../lib/errors";
import {
  CATEGORY_KEYS,
  categoryLabel,
  financeResolveSuggestions,
  financeSetCategory,
  financeTransactions,
  formatMoney,
  type Transaction,
} from "../../lib/finance";
import { t } from "../../lib/i18n";
import { SegmentedControl } from "../ui/SegmentedControl";

type Filter = "all" | "open" | "suggested";
const PAGE = 100;

/**
 * The transactions, newest first, each with its category. Filing one by
 * hand files the ones like it too, unless the person turns that off; a
 * model's suggestion waits here until the person accepts or dismisses it.
 */
export function FinanceTransactions({
  version,
  onChanged,
}: {
  /** Bumped by the parent when something it did changed the rows. */
  version: number;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Transaction[]>([]);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the parent's signal that the rows changed underneath
  useEffect(() => {
    let cancelled = false;
    const query =
      filter === "open"
        ? { category: "", search, limit: PAGE }
        : filter === "suggested"
          ? { suggested: true, search, limit: PAGE }
          : { search, limit: PAGE };
    const timer = setTimeout(() => {
      void financeTransactions(query)
        .then((found) => {
          if (!cancelled) setRows(found);
        })
        .catch((err) => {
          if (!cancelled) setError(messageFromError(err));
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [filter, search, version]);

  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      onChanged();
    } catch (err) {
      setError(messageFromError(err));
    }
  };

  const suggested = rows.filter((row) => row.suggestion && row.categorySource !== "person");
  const options = (current: string) => {
    const keys: string[] = [...CATEGORY_KEYS];
    if (current && !keys.includes(current)) keys.push(current);
    return keys;
  };

  return (
    <section className="personal-section">
      <h2 className="personal-section-title">{t("Transactions")}</h2>
      <div className="personal-row">
        <SegmentedControl
          value={filter}
          onValueChange={setFilter}
          aria-label={t("Show")}
          options={[
            { value: "all", label: t("All") },
            { value: "open", label: t("Uncategorized") },
            { value: "suggested", label: t("Suggestions") },
          ]}
        />
        <label className="personal-row personal-input">
          <IconMagnifyingGlass size={16} />
          <input
            className="personal-input"
            type="search"
            value={search}
            placeholder={t("Search transactions")}
            aria-label={t("Search transactions")}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      <label className="personal-check">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        />
        {t("Also file similar transactions when I choose a category")}
      </label>
      {filter === "suggested" && suggested.length > 0 ? (
        <div className="personal-row">
          <button
            type="button"
            className="personal-button"
            data-tone="primary"
            onClick={() =>
              void act(() =>
                financeResolveSuggestions(
                  suggested.map((row) => row.id),
                  true,
                ),
              )
            }
          >
            {t("Accept all suggestions")}
          </button>
          <button
            type="button"
            className="personal-button"
            onClick={() =>
              void act(() =>
                financeResolveSuggestions(
                  suggested.map((row) => row.id),
                  false,
                ),
              )
            }
          >
            {t("Decline all")}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="personal-error" role="alert">
          {error}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="personal-quiet">{t("No transaction matches.")}</p>
      ) : (
        <ul className="personal-list">
          {rows.map((row) => (
            <li key={row.id} className="personal-list-row">
              <div className="personal-list-main">
                <span className="personal-list-title" title={row.description}>
                  {row.description || row.counterparty || t("No description")}
                </span>
                <span className="personal-list-meta">
                  {row.account ? `${row.bookedOn} · ${row.account}` : row.bookedOn}
                </span>
                {row.suggestion && row.categorySource !== "person" ? (
                  <span className="personal-suggestion">
                    {t("Suggested: {category}", { category: categoryLabel(row.suggestion) })}
                    <button
                      type="button"
                      className="personal-button"
                      onClick={() => void act(() => financeResolveSuggestions([row.id], true))}
                    >
                      {t("Accept")}
                    </button>
                    <button
                      type="button"
                      className="personal-button"
                      onClick={() => void act(() => financeResolveSuggestions([row.id], false))}
                    >
                      {t("Decline")}
                    </button>
                  </span>
                ) : null}
              </div>
              <span className="personal-amount" data-sign={row.amountMinor > 0 ? "in" : "out"}>
                {formatMoney(row.amountMinor, row.currency)}
              </span>
              <select
                className="personal-select"
                value={row.category}
                aria-label={t("Category of {transaction}", { transaction: row.description })}
                onChange={(event) =>
                  void act(() => financeSetCategory(row.id, event.target.value, remember))
                }
              >
                <option value="">{t("Uncategorized")}</option>
                {options(row.category).map((key) => (
                  <option key={key} value={key}>
                    {categoryLabel(key)}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
