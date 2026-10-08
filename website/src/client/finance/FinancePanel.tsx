import { useMemo, useState } from "react";
import { number, t } from "../../lib/i18n";
import type { FeatureHost } from "../feature";
import { filtered, transactions } from "./data";
import { overview } from "./summary";
import "./finance.css";

const MAX_ROWS = 200;

function money(minor: number, currency: string): string {
  return `${number(minor / 100, 2)} ${currency}`;
}

/** The person's synchronised transactions: what they spend by category and
 * by month, and the rows themselves, searchable. Read only, like the
 * assistant's tools: statements are imported and filed in the app. */
export function FinancePanel({ host }: { host: FeatureHost }) {
  const [query, setQuery] = useState("");
  const all = transactions(host.sync);
  const summary = useMemo(() => overview(all), [all]);
  const shown = filtered(all, { query, limit: MAX_ROWS });
  const label = (category: string) => category || t("Not filed yet", "Pas encore classé");

  return (
    <div className="wc-fin-panel">
      <h1>{t("Finances", "Finances")}</h1>
      {all.length === 0 ? (
        <p className="lede">
          {t(
            "No transactions here yet. They appear when you import a bank statement in the app and turn on finance sync there: nothing leaves a device until you opt in.",
            "Aucune transaction ici pour l’instant. Elles apparaissent quand vous importez un relevé bancaire dans l’app et y activez la synchronisation des finances : rien ne quitte un appareil sans votre accord.",
          )}
        </p>
      ) : (
        <>
          <p className="quiet">
            {t(
              "Synchronised from the devices where you imported your statements. Transfers and savings are left out of spending.",
              "Synchronisées depuis les appareils où vous avez importé vos relevés. Les virements et l’épargne ne comptent pas dans les dépenses.",
            )}
          </p>
          <p>
            {t("Spent", "Dépensé")}:{" "}
            <strong>{money(summary.spendingMinor, summary.currency)}</strong>
            {" · "}
            {t("Received", "Reçu")}: <strong>{money(summary.incomeMinor, summary.currency)}</strong>
          </p>
          {summary.currencies.length > 1 && (
            <p className="quiet">
              {t(
                `Figures are in ${summary.currency}; other currencies are listed below, never added in.`,
                `Les montants sont en ${summary.currency} ; les autres devises sont listées plus bas, jamais additionnées.`,
              )}
            </p>
          )}
          <h2>{t("By category", "Par catégorie")}</h2>
          <table className="wc-fin-table">
            <tbody>
              {summary.categories.map((item) => (
                <tr key={item.category || "none"}>
                  <th scope="row">{label(item.category)}</th>
                  <td>{money(item.amountMinor, summary.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>{t("By month", "Par mois")}</h2>
          <table className="wc-fin-table">
            <thead>
              <tr>
                <th scope="col">{t("Month", "Mois")}</th>
                <th scope="col">{t("Spent", "Dépensé")}</th>
                <th scope="col">{t("Received", "Reçu")}</th>
              </tr>
            </thead>
            <tbody>
              {summary.months.map((month) => (
                <tr key={month.month}>
                  <th scope="row">{month.month}</th>
                  <td>{money(month.spendingMinor, summary.currency)}</td>
                  <td>{money(month.incomeMinor, summary.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>{t("Transactions", "Transactions")}</h2>
          <label className="wc-search">
            <span className="sr-only">
              {t("Search transactions", "Rechercher des transactions")}
            </span>
            <input
              type="search"
              value={query}
              placeholder={t("Search transactions", "Rechercher des transactions")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {shown.length === 0 ? (
            <p className="quiet">
              {t("No transaction matches.", "Aucune transaction ne correspond.")}
            </p>
          ) : (
            <table className="wc-fin-table">
              <tbody>
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>{row.bookedOn}</td>
                    <td>{row.counterparty || row.description}</td>
                    <td>{label(row.category)}</td>
                    <td>{money(row.amountMinor, row.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
