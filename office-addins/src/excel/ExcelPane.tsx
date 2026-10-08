import { useState } from "react";
import { analysisTurn } from "../../../website/src/client/analysis";
import { t } from "../../../website/src/lib/i18n";
import { complete, type Engine, officeTurn } from "../model";
import { promptLanguageName } from "../languages";
import { ShownError } from "../pane/errors";
import { Proposal } from "../pane/Proposal";
import { useProposal } from "../pane/useProposal";
import { fill, OFFICE } from "../words";
import {
  answerProse,
  answerTables,
  cellListing,
  parseFormulaAnswer,
  rangeCsv,
  sheetRows,
} from "./data";
import { type ExcelHost, firstCell, TooManyCells } from "./host";

type Made =
  | { kind: "explain" }
  | { kind: "formula"; address: string; formula: string; occupied: boolean }
  | { kind: "analysis"; answer: string; tables: number };

type Tab = "explain" | "formula" | "analyse";

/**
 * Excel: explain a formula, write one from a description, or analyse the
 * selected range with Python. A formula is written to the cell it was made
 * for, and an analysis to a new sheet, only when the person confirms
 * (ADR-0102).
 */
export function ExcelPane({
  host,
  engine,
  language,
}: {
  host: ExcelHost;
  engine: Engine;
  language: string;
}) {
  const { proposal, error, setError, ask, discard } = useProposal<Made>();
  const [tab, setTab] = useState<Tab>("explain");
  const [description, setDescription] = useState("");
  const [question, setQuestion] = useState("");
  const [done, setDone] = useState("");
  const languageName = promptLanguageName(language.slice(0, 2));

  const explain = () =>
    ask(async ({ signal, onText }) => {
      setDone("");
      const selection = await host.readSelection(1000);
      const formula = String(selection.formulas[0]?.[0] ?? "");
      if (!formula.startsWith("="))
        throw new ShownError(
          t(
            "The selected cell holds no formula. Select a cell that starts with =.",
            "La cellule sélectionnée ne contient pas de formule. Sélectionnez une cellule qui commence par =.",
          ),
        );
      const message = fill(OFFICE.excel.explain, {
        address: firstCell(selection.address),
        formula,
        value: String(selection.values[0]?.[0] ?? ""),
        language: languageName,
      });
      const text = await complete(engine, OFFICE.excel.system, message, { signal, onText });
      return { text, value: { kind: "explain" } as Made };
    });

  const writeFormula = () =>
    ask(async ({ signal }) => {
      setDone("");
      const selection = await host.readSelection(1000);
      const preview = await host.sheetPreview();
      const address = firstCell(selection.address);
      const message = fill(OFFICE.excel.write, {
        address,
        description: description.trim(),
        cells: cellListing(preview.address, preview.values, 6),
        language: languageName,
      });
      const answer = await complete(engine, OFFICE.excel.system, message, { signal });
      const parsed = parseFormulaAnswer(answer);
      if (!parsed)
        throw new ShownError(
          t(
            "The model did not answer with a formula. Describe it differently and try again.",
            "Le modèle n’a pas répondu par une formule. Décrivez-la autrement et réessayez.",
          ),
        );
      const current = selection.formulas[0]?.[0];
      return {
        text: parsed.explanation,
        value: {
          kind: "formula",
          address,
          formula: parsed.formula,
          occupied: current !== "" && current !== null && current !== undefined,
        } as Made,
      };
    });

  const analyse = () =>
    ask(async ({ signal, onText }) => {
      setDone("");
      const selection = await host.readSelection().catch((err) => {
        throw err instanceof TooManyCells
          ? new ShownError(
              t(
                "The selection is too large to analyse here. Select fewer cells.",
                "La sélection est trop grande pour être analysée ici. Sélectionnez moins de cellules.",
              ),
            )
          : err;
      });
      const csv = rangeCsv(selection.values);
      const message = fill(OFFICE.excel.analyseMessage, {
        question: question.trim(),
        address: selection.address,
        rows: String(selection.rowCount),
        columns: String(selection.columnCount),
        cells: cellListing(selection.address, selection.values, 20, selection.formulas),
      });
      let streamed = "";
      const answer = await officeTurn(
        engine,
        message,
        [
          analysisTurn([{ name: OFFICE.excel.selectionFile, text: csv }]),
          { tools: [], prompt: OFFICE.excel.analyse },
        ],
        {
          signal,
          onText: (fragment) => {
            streamed += fragment;
            onText(fragment);
          },
        },
      );
      return {
        text: answerProse(answer || streamed),
        value: { kind: "analysis", answer, tables: answerTables(answer).length } as Made,
      };
    });

  const apply = async () => {
    const value = proposal?.value;
    if (!value) return;
    try {
      if (value.kind === "formula") {
        await host.writeFormula(value.address, value.formula);
        setDone(t(`Written to ${value.address}.`, `Écrit dans ${value.address}.`));
      } else if (value.kind === "analysis") {
        const name = await host.addSheet(
          t("Sub Rosa analysis", "Analyse Sub Rosa"),
          sheetRows(value.answer),
        );
        setDone(t(`Written to the new sheet ${name}.`, `Écrit dans la nouvelle feuille ${name}.`));
      }
      discard();
    } catch {
      setError(
        t(
          "Excel did not accept the change. Try again.",
          "Excel n’a pas accepté la modification. Réessayez.",
        ),
      );
    }
  };

  const tabs: [Tab, string][] = [
    ["explain", t("Explain", "Expliquer")],
    ["formula", t("Write a formula", "Écrire une formule")],
    ["analyse", t("Analyse", "Analyser")],
  ];

  return (
    <>
      <div className="office-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <section className="office-section">
        {tab === "explain" ? (
          <>
            <p className="quiet">
              {t(
                "Select a cell that holds a formula.",
                "Sélectionnez une cellule qui contient une formule.",
              )}
            </p>
            <button
              className="button primary"
              type="button"
              disabled={proposal?.pending}
              onClick={() => void explain()}
            >
              {t("Explain the formula", "Expliquer la formule")}
            </button>
          </>
        ) : tab === "formula" ? (
          <>
            <label className="office-field">
              {t(
                "Select the cell for the formula and describe what it should do",
                "Sélectionnez la cellule de la formule et décrivez ce qu’elle doit faire",
              )}
              <textarea
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <button
              className="button primary"
              type="button"
              disabled={proposal?.pending || !description.trim()}
              onClick={() => void writeFormula()}
            >
              {t("Write the formula", "Écrire la formule")}
            </button>
          </>
        ) : (
          <>
            <label className="office-field">
              {t(
                "Select a range, then ask a question about it",
                "Sélectionnez une plage, puis posez une question à son sujet",
              )}
              <textarea
                rows={3}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
              />
            </label>
            <p className="quiet">
              {t(
                "Python runs in this add-in, on the selected cells only, when your browser allows it.",
                "Python s’exécute dans ce complément, sur les cellules sélectionnées seulement, quand votre navigateur le permet.",
              )}
            </p>
            <button
              className="button primary"
              type="button"
              disabled={proposal?.pending || !question.trim()}
              onClick={() => void analyse()}
            >
              {t("Analyse the selection", "Analyser la sélection")}
            </button>
          </>
        )}
      </section>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="notice" role="status">
          {done}
        </p>
      )}
      {proposal && (
        <Proposal
          text={proposal.text}
          pending={proposal.pending}
          onDiscard={discard}
          actions={
            proposal.value?.kind === "formula" && proposal.value.formula ? (
              <button className="button primary" type="button" onClick={() => void apply()}>
                {proposal.value.occupied
                  ? t(
                      `Replace what is in ${proposal.value.address}`,
                      `Remplacer le contenu de ${proposal.value.address}`,
                    )
                  : t(
                      `Put it in ${proposal.value.address}`,
                      `La mettre dans ${proposal.value.address}`,
                    )}
              </button>
            ) : proposal.value?.kind === "analysis" ? (
              <button className="button primary" type="button" onClick={() => void apply()}>
                {proposal.value.tables
                  ? t(
                      "Write the results to a new sheet",
                      "Écrire les résultats dans une nouvelle feuille",
                    )
                  : t(
                      "Write the answer to a new sheet",
                      "Écrire la réponse dans une nouvelle feuille",
                    )}
              </button>
            ) : null
          }
        >
          {proposal.value?.kind === "formula" && proposal.value.formula && (
            <code className="office-formula">{proposal.value.formula}</code>
          )}
        </Proposal>
      )}
    </>
  );
}
