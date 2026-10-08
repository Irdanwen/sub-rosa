import "../../styles/personal-data.css";
import "../../styles/chat-data.css";
import { IconBank } from "central-icons/IconBank";
import { IconImport } from "central-icons/IconImport";
import { IconSparkle } from "central-icons/IconSparkle";
import { listen } from "@tauri-apps/api/event";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ACCOUNT_SYNC_UPDATED_EVENT } from "../../lib/account-sync-events";
import { messageFromError } from "../../lib/errors";
import {
  balanceChart,
  categoryChart,
  type FinanceOverview,
  type FinanceStatus,
  financeOverview,
  financeStatus,
  financeSuggest,
  formatMoney,
  type ImportResult,
  merchantChart,
  monthlySpendingChart,
  monthsBack,
} from "../../lib/finance";
import { localDay } from "../../lib/health";
import { t } from "../../lib/i18n";
import { ChartCard } from "../chat-blocks/ChartCard";
import { EmptyState } from "../ui/EmptyState";
import { SegmentedControl } from "../ui/SegmentedControl";
import { FinanceManage } from "./FinanceManage";
import { FinanceTransactions } from "./FinanceTransactions";
import { StatementImportDialog } from "./StatementImportDialog";

type Span = "3" | "6" | "12";

/** The statement formats the file picker offers. */
const STATEMENT_TYPES = ".csv,.txt,.ofx,.qfx,.xml,text/csv,application/xml,text/xml";

/**
 * Finances (ADR-0099): bank statements the person imported, as spending by
 * month and category, the merchants the money goes to and the balance over
 * time, with the transactions to file and the rules that file them. The
 * same view on both shells.
 */
export function FinancesView({ header }: { header?: ReactNode }) {
  const [status, setStatus] = useState<FinanceStatus | null>(null);
  const [overview, setOverview] = useState<FinanceOverview | null>(null);
  const [span, setSpan] = useState<Span>("6");
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [next, summary] = await Promise.all([
        financeStatus(),
        financeOverview(monthsBack(Number(span) - 1), localDay(new Date())),
      ]);
      setStatus(next);
      setOverview(summary);
    } catch (err) {
      setError(messageFromError(err));
    }
  }, [span]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen(ACCOUNT_SYNC_UPDATED_EVENT, () => {
      void load();
      setVersion((value) => value + 1);
    }).then((stop) => {
      unlisten = stop;
    });
    return () => unlisten?.();
  }, [load]);

  const changed = (next?: FinanceStatus) => {
    if (next) setStatus(next);
    setVersion((value) => value + 1);
    void load();
  };

  const imported = (result: ImportResult) => {
    setFile(null);
    setNotice(
      result.added === 1
        ? t("1 transaction added.")
        : t("{count} transactions added.", { count: result.added }),
    );
    changed();
  };

  const suggest = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const count = await financeSuggest();
      setNotice(
        count === 0
          ? t("No suggestion this time. File these by hand or add a rule.")
          : count === 1
            ? t("1 suggestion to review under Suggestions.")
            : t("{count} suggestions to review under Suggestions.", { count }),
      );
      changed();
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(false);
    }
  };

  const empty = status !== null && status.transactions === 0;

  return (
    <div className="personal-view">
      {header}
      <p className="personal-view-lead">
        {t(
          "Import the statements you export from your bank. They are read on this device, and no bank or aggregator is ever contacted.",
        )}
      </p>
      <div className="personal-row">
        <button
          type="button"
          className="personal-button"
          data-tone="primary"
          onClick={() => picker.current?.click()}
        >
          <IconImport size={16} />
          {t("Import a statement")}
        </button>
        {status && status.uncategorized > 0 ? (
          <button
            type="button"
            className="personal-button"
            disabled={busy}
            onClick={() => void suggest()}
          >
            <IconSparkle size={16} />
            {t("Suggest categories")}
          </button>
        ) : null}
        <input
          ref={picker}
          type="file"
          accept={STATEMENT_TYPES}
          hidden
          onChange={(event) => {
            const picked = event.target.files?.[0] ?? null;
            event.target.value = "";
            setNotice(null);
            setFile(picked);
          }}
        />
      </div>
      {error ? (
        <p className="personal-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="personal-quiet" role="status">
          {notice}
        </p>
      ) : null}

      {empty ? (
        <EmptyState
          icon={<IconBank size={28} />}
          title={t("No statement yet")}
          description={t(
            "Export a statement as CSV, OFX or camt.053 from your e-banking (UBS, PostFinance, Raiffeisen, BCV, Crédit Agricole, BNP Paribas and most others) and import it here.",
          )}
        />
      ) : null}

      {overview && overview.transactions > 0 ? (
        <section className="personal-section" aria-label={t("Overview")}>
          <SegmentedControl
            value={span}
            onValueChange={setSpan}
            aria-label={t("Time range")}
            options={[
              { value: "3", label: t("3 months") },
              { value: "6", label: t("6 months") },
              { value: "12", label: t("12 months") },
            ]}
          />
          <div className="personal-tiles">
            <div className="personal-tile">
              <span className="personal-tile-label">{t("Spent")}</span>
              <span className="personal-tile-value">
                {formatMoney(overview.spendingMinor, overview.currency)}
              </span>
            </div>
            <div className="personal-tile">
              <span className="personal-tile-label">{t("Received")}</span>
              <span className="personal-tile-value">
                {formatMoney(overview.incomeMinor, overview.currency)}
              </span>
            </div>
            <div className="personal-tile">
              <span className="personal-tile-label">{t("Difference")}</span>
              <span className="personal-tile-value">
                {formatMoney(overview.incomeMinor - overview.spendingMinor, overview.currency)}
              </span>
            </div>
          </div>
          {overview.currencies.length > 1 ? (
            <p className="personal-quiet">
              {t("Figures in {currency}. Transactions in other currencies are not added in.", {
                currency: overview.currency,
              })}
            </p>
          ) : null}
          <div className="personal-charts">
            {overview.months.length > 0 ? (
              <ChartCard block={monthlySpendingChart(overview)} />
            ) : null}
            {overview.categories.length > 0 ? <ChartCard block={categoryChart(overview)} /> : null}
            {overview.merchants.length > 0 ? <ChartCard block={merchantChart(overview)} /> : null}
            {overview.balance.length > 1 ? <ChartCard block={balanceChart(overview)} /> : null}
          </div>
        </section>
      ) : null}

      {status && status.transactions > 0 ? (
        <FinanceTransactions version={version} onChanged={() => changed()} />
      ) : null}
      {status ? <FinanceManage status={status} onChanged={changed} /> : null}

      <StatementImportDialog file={file} onClose={() => setFile(null)} onImported={imported} />
    </div>
  );
}
