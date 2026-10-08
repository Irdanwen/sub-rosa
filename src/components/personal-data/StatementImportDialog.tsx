import { useEffect, useRef, useState } from "react";
import { messageFromError } from "../../lib/errors";
import {
  type CsvMapping,
  type DateOrder,
  financeImport,
  financePreview,
  formatMoney,
  type ImportResult,
  presetLabel,
  type StatementPreview,
} from "../../lib/finance";
import { t } from "../../lib/i18n";
import { fileToBase64 } from "../../lib/projects";
import { Dialog } from "../ui/Dialog";

type Props = {
  file: File | null;
  onClose: () => void;
  onImported: (result: ImportResult) => void;
};

/** Sample rows keyed by what they say, numbered when two say the same. */
function sampleRows(sample: StatementPreview["sample"]) {
  const seen = new Map<string, number>();
  return sample.map((row) => {
    const base = `${row.bookedOn}|${row.amountMinor}|${row.description}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { key: `${base}|${count}`, row };
  });
}

type Column = keyof Pick<
  CsvMapping,
  "date" | "amount" | "debit" | "credit" | "balance" | "currency" | "reference" | "counterparty"
>;

/**
 * Importing one statement: what the file is, what will be added, and for a
 * CSV the column mapping the person checks before anything is written. The
 * file never leaves the device; it is read by the app (ADR-0099).
 */
export function StatementImportDialog({ file, onClose, onImported }: Props) {
  const [data, setData] = useState<string | null>(null);
  const [preview, setPreview] = useState<StatementPreview | null>(null);
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  useEffect(() => {
    setData(null);
    setPreview(null);
    setMapping(null);
    setAccount("");
    setError(null);
    if (!file) return;
    let cancelled = false;
    void fileToBase64(file)
      .then(async (encoded) => {
        const first = await financePreview({ fileName: file.name, data: encoded });
        if (cancelled) return;
        setData(encoded);
        setPreview(first);
        setMapping(first.csv?.mapping ?? null);
        setAccount(first.account);
      })
      .catch((err) => {
        if (!cancelled) setError(messageFromError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  // A corrected mapping reads the file again, so the counts and the sample
  // show what the import will actually do.
  const update = (next: CsvMapping) => {
    setMapping(next);
    if (!file || !data) return;
    const ticket = ++request.current;
    void financePreview({ fileName: file.name, data, mapping: next, account })
      .then((fresh) => {
        if (ticket === request.current) setPreview(fresh);
      })
      .catch((err) => setError(messageFromError(err)));
  };

  const submit = async () => {
    if (!file || !data) return;
    setBusy(true);
    setError(null);
    try {
      onImported(await financeImport({ fileName: file.name, data, mapping, account }));
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBusy(false);
    }
  };

  const headers = preview?.csv?.headers ?? [];
  const columnLabel = (index: number) =>
    headers[index]?.trim() || t("Column {number}", { number: index + 1 });
  const columnSelect = (key: Column, label: string, optional = true) =>
    mapping ? (
      <label className="personal-field">
        {label}
        <select
          className="personal-select"
          value={mapping[key] ?? ""}
          onChange={(event) =>
            update({
              ...mapping,
              [key]: event.target.value === "" ? null : Number(event.target.value),
            })
          }
        >
          {optional ? <option value="">{t("None")}</option> : null}
          {headers.map((_, index) => (
            <option key={columnLabel(index) + String(index)} value={index}>
              {columnLabel(index)}
            </option>
          ))}
        </select>
      </label>
    ) : null;

  return (
    <Dialog
      open={file !== null}
      onClose={onClose}
      title={t("Import a statement")}
      description={file?.name}
      width={720}
      footer={
        <>
          <button type="button" className="personal-button" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button
            type="button"
            className="personal-button"
            data-tone="primary"
            disabled={busy || !preview || preview.count === 0}
            onClick={() => void submit()}
          >
            {preview && preview.newCount > 0
              ? preview.newCount === 1
                ? t("Import 1 transaction")
                : t("Import {count} transactions", { count: preview.newCount })
              : t("Import")}
          </button>
        </>
      }
    >
      <div className="personal-section personal-dialog-scroll">
        {error ? (
          <p className="personal-error" role="alert">
            {error}
          </p>
        ) : null}
        {!preview && !error ? <p className="personal-quiet">{t("Reading the statement")}</p> : null}
        {preview ? (
          <>
            <p className="personal-quiet">
              {preview.format === "csv"
                ? t("CSV export, {bank}", { bank: presetLabel(preview.preset) })
                : preview.format === "ofx"
                  ? t("OFX statement")
                  : t("ISO 20022 statement (camt.053)")}
              {preview.firstDay && preview.lastDay
                ? ` · ${t("{from} to {to}", { from: preview.firstDay, to: preview.lastDay })}`
                : ""}
            </p>
            <p className="personal-quiet">
              {t("{count} transactions read, {fresh} new, {skipped} lines left out.", {
                count: preview.count,
                fresh: preview.newCount,
                skipped: preview.skipped,
              })}
            </p>
            {preview.alreadyImported ? (
              <p className="personal-quiet">
                {t("This exact file was imported before. Only new transactions are added.")}
              </p>
            ) : null}
            <label className="personal-field">
              {t("Account name")}
              <input
                className="personal-input"
                value={account}
                placeholder={t("For example, the IBAN or a name you recognise")}
                onChange={(event) => setAccount(event.target.value)}
              />
            </label>
            {mapping ? (
              <fieldset className="personal-section">
                <legend className="personal-section-title">{t("Columns")}</legend>
                <p className="personal-quiet">
                  {t("Check which column holds what. The preview below follows your choices.")}
                </p>
                <div className="personal-mapping">
                  {columnSelect("date", t("Date"), false)}
                  <label className="personal-field">
                    {t("Date order")}
                    <select
                      className="personal-select"
                      value={mapping.dateOrder}
                      onChange={(event) =>
                        update({ ...mapping, dateOrder: event.target.value as DateOrder })
                      }
                    >
                      <option value="dmy">{t("Day, month, year")}</option>
                      <option value="ymd">{t("Year, month, day")}</option>
                      <option value="mdy">{t("Month, day, year")}</option>
                    </select>
                  </label>
                  {[0, 1].map((slot) => (
                    <label key={slot} className="personal-field">
                      {slot === 0 ? t("Description") : t("More description")}
                      <select
                        className="personal-select"
                        value={mapping.description[slot] ?? ""}
                        onChange={(event) => {
                          const next = [...mapping.description];
                          if (event.target.value === "") next.splice(slot, 1);
                          else next[slot] = Number(event.target.value);
                          update({
                            ...mapping,
                            description: next.filter((value) => value !== undefined),
                          });
                        }}
                      >
                        <option value="">{t("None")}</option>
                        {headers.map((_, index) => (
                          <option key={columnLabel(index) + String(index)} value={index}>
                            {columnLabel(index)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  {columnSelect("amount", t("Amount (signed)"))}
                  {columnSelect("debit", t("Money out"))}
                  {columnSelect("credit", t("Money in"))}
                  {columnSelect("balance", t("Balance"))}
                  {columnSelect("currency", t("Currency"))}
                  {columnSelect("reference", t("Bank reference"))}
                  {columnSelect("counterparty", t("Payee"))}
                  <label className="personal-field">
                    {t("Currency when no column says")}
                    <input
                      className="personal-input"
                      value={mapping.defaultCurrency}
                      maxLength={3}
                      onChange={(event) =>
                        update({ ...mapping, defaultCurrency: event.target.value.toUpperCase() })
                      }
                    />
                  </label>
                  <label className="personal-check">
                    <input
                      type="checkbox"
                      checked={mapping.decimalComma}
                      onChange={(event) =>
                        update({ ...mapping, decimalComma: event.target.checked })
                      }
                    />
                    {t("Amounts use a decimal comma")}
                  </label>
                </div>
              </fieldset>
            ) : null}
            {preview.sample.length > 0 ? (
              <div className="personal-scroll-x">
                <table className="personal-sample">
                  <caption className="personal-quiet">
                    {t("First transactions as they will be imported")}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("Date")}</th>
                      <th scope="col">{t("Description")}</th>
                      <th scope="col">{t("Amount")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sampleRows(preview.sample).map(({ key, row }) => (
                      <tr key={key}>
                        <td data-nowrap>{row.bookedOn}</td>
                        <td>{row.description}</td>
                        <td data-numeric>{formatMoney(row.amountMinor, row.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
