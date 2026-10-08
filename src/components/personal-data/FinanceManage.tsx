import { IconTrashCan } from "central-icons/IconTrashCan";
import { useCallback, useEffect, useRef, useState } from "react";
import { messageFromError } from "../../lib/errors";
import {
  CATEGORY_KEYS,
  categoryLabel,
  type FinanceRule,
  type FinanceStatus,
  financeExport,
  financeForget,
  financeImportRules,
  financeRuleAdd,
  financeRuleRemove,
  financeRules,
  financeSetSync,
  presetLabel,
  readFileText,
} from "../../lib/finance";
import { intlLocale, t } from "../../lib/i18n";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Switch } from "../ui/Switch";

/**
 * What the person controls about their finances: the rules that file
 * transactions, the statements imported, whether finances travel with their
 * account, and the manual bridge to the household budget engine.
 */
export function FinanceManage({
  status,
  onChanged,
}: {
  status: FinanceStatus;
  onChanged: (status?: FinanceStatus) => void;
}) {
  const [rules, setRules] = useState<FinanceRule[]>([]);
  const [pattern, setPattern] = useState("");
  const [category, setCategory] = useState<string>(CATEGORY_KEYS[0]);
  const [isRegex, setIsRegex] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const rulesInput = useRef<HTMLInputElement>(null);

  const loadRules = useCallback(
    () =>
      financeRules()
        .then(setRules)
        .catch((err) => setError(messageFromError(err))),
    [],
  );

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  /** Runs one change and says how it went. Answers whether it worked. */
  const act = async (
    work: () => Promise<unknown>,
    done?: (value: unknown) => string | null,
  ): Promise<boolean> => {
    setError(null);
    setNotice(null);
    try {
      const value = await work();
      setNotice(done ? done(value) : null);
      await loadRules();
      onChanged(
        value && typeof value === "object" && "statements" in value
          ? (value as FinanceStatus)
          : undefined,
      );
      return true;
    } catch (err) {
      setError(messageFromError(err));
      return false;
    }
  };

  const importedAt = (iso: string) =>
    new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium" }).format(new Date(iso));

  return (
    <>
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

      <section className="personal-section">
        <h2 className="personal-section-title">{t("Rules")}</h2>
        <p className="personal-quiet">
          {t(
            "A rule files every transaction whose description or payee contains the text. Your own choices always win over a rule.",
          )}
        </p>
        <form
          className="personal-row"
          onSubmit={(event) => {
            event.preventDefault();
            void act(
              () => financeRuleAdd(pattern, category, isRegex),
              (count) =>
                count === 1
                  ? t("1 transaction filed by the new rule.")
                  : t("{count} transactions filed by the new rule.", { count: Number(count) }),
            ).then((worked) => {
              if (worked) setPattern("");
            });
          }}
        >
          <input
            className="personal-input"
            value={pattern}
            placeholder={t("Text to match, such as Migros")}
            aria-label={t("Text to match")}
            onChange={(event) => setPattern(event.target.value)}
          />
          <select
            className="personal-select"
            value={category}
            aria-label={t("Category")}
            onChange={(event) => setCategory(event.target.value)}
          >
            {CATEGORY_KEYS.map((key) => (
              <option key={key} value={key}>
                {categoryLabel(key)}
              </option>
            ))}
          </select>
          <label className="personal-check">
            <input
              type="checkbox"
              checked={isRegex}
              onChange={(event) => setIsRegex(event.target.checked)}
            />
            {t("Regular expression")}
          </label>
          <button type="submit" className="personal-button" disabled={!pattern.trim()}>
            {t("Add rule")}
          </button>
        </form>
        {rules.length > 0 ? (
          <ul className="personal-list">
            {rules.map((rule) => (
              <li key={rule.id} className="personal-list-row">
                <div className="personal-list-main">
                  <span className="personal-list-title">{rule.pattern}</span>
                  <span className="personal-list-meta">
                    {rule.isRegex
                      ? t("{category}, regular expression", {
                          category: categoryLabel(rule.category),
                        })
                      : categoryLabel(rule.category)}
                  </span>
                </div>
                <button
                  type="button"
                  className="personal-button"
                  aria-label={t("Remove the rule {rule}", { rule: rule.pattern })}
                  onClick={() => void act(() => financeRuleRemove(rule.id))}
                >
                  <IconTrashCan size={16} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="personal-section">
        <h2 className="personal-section-title">{t("Statements")}</h2>
        {status.statements.length === 0 ? (
          <p className="personal-quiet">{t("No statement imported on this device.")}</p>
        ) : (
          <ul className="personal-list">
            {status.statements.map((statement) => (
              <li key={statement.id} className="personal-list-row">
                <div className="personal-list-main">
                  <span className="personal-list-title">{statement.fileName}</span>
                  <span className="personal-list-meta">
                    {t("{date}, {bank}, {count} added", {
                      date: importedAt(statement.importedAt),
                      bank:
                        statement.format === "csv"
                          ? presetLabel(statement.preset)
                          : statement.format === "ofx"
                            ? "OFX"
                            : "camt.053",
                      count: statement.added,
                    })}
                  </span>
                </div>
                <button
                  type="button"
                  className="personal-button"
                  data-tone="danger"
                  onClick={() => void act(() => financeForget(statement.id))}
                >
                  {t("Remove its transactions")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="personal-section">
        <h2 className="personal-section-title">{t("Sync and privacy")}</h2>
        <span className="personal-check">
          <Switch
            checked={status.sync}
            onCheckedChange={(sync) => void act(() => financeSetSync(sync))}
            aria-label={t("Sync finances with your account")}
          />
          {t("Sync finances with your account")}
        </span>
        <p className="personal-quiet">
          {t(
            "Off by default. Statements are read on this device and no bank or aggregator is ever contacted. When sync is on, transactions and rules are encrypted with your account like your notes. Suggested categories send descriptions only, never amounts or accounts, and only when you ask.",
          )}
        </p>
        <div className="personal-row">
          <button
            type="button"
            className="personal-button"
            data-tone="danger"
            onClick={() => setConfirmAll(true)}
          >
            {t("Delete all finances on this device")}
          </button>
        </div>
      </section>

      <section className="personal-section">
        <h2 className="personal-section-title">{t("Budget engine")}</h2>
        <p className="personal-quiet">
          {t(
            "For the household budget engine: export transactions in its column names, export your rules in its rules.json shape to merge by hand, or import its rules.json. Files only, nothing is sent to it.",
          )}
        </p>
        <div className="personal-row">
          <button
            type="button"
            className="personal-button"
            onClick={() => void act(() => financeExport("transactions"))}
          >
            {t("Export transactions")}
          </button>
          <button
            type="button"
            className="personal-button"
            onClick={() => void act(() => financeExport("rules"))}
          >
            {t("Export rules")}
          </button>
          <button
            type="button"
            className="personal-button"
            onClick={() => rulesInput.current?.click()}
          >
            {t("Import rules.json")}
          </button>
          <input
            ref={rulesInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              void act(
                async () => financeImportRules(await readFileText(file)),
                (count) =>
                  count === 1
                    ? t("1 rule imported.")
                    : t("{count} rules imported.", { count: Number(count) }),
              );
            }}
          />
        </div>
      </section>

      <ConfirmDialog
        open={confirmAll}
        title={t("Delete all finances on this device?")}
        description={t(
          "Every transaction, statement and rule on this device is deleted. Your bank files are untouched.",
        )}
        confirmLabel={t("Delete")}
        destructive
        onClose={() => setConfirmAll(false)}
        onConfirm={() => {
          setConfirmAll(false);
          void act(() => financeForget());
        }}
      />
    </>
  );
}
