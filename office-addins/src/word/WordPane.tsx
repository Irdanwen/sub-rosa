import { useState } from "react";
import { t } from "../../../website/src/lib/i18n";
import { type Engine, officeTurn, rewrite } from "../model";
import { promptLanguageName, shownLanguageName, TARGET_LANGUAGES } from "../languages";
import { Proposal } from "../pane/Proposal";
import { useProposal } from "../pane/useProposal";
import { fill, OFFICE, type RewriteKind } from "../words";
import type { WordHost } from "./host";

type Made = { kind: "rewrite"; source: string } | { kind: "draft" };

const ACTIONS: [RewriteKind, () => string][] = [
  ["reformulate", () => t("Rewrite", "Reformuler")],
  ["shorten", () => t("Shorten", "Raccourcir")],
  ["correct", () => t("Correct", "Corriger")],
  ["summarize", () => t("Summarize", "Résumer")],
];

/**
 * Word: rewrite, summarize or translate the selection, or draft at the
 * cursor. Each answer is a proposal; the document changes only on "Replace"
 * or "Insert" (ADR-0102, after ADR-0038).
 */
export function WordPane({
  host,
  engine,
  language,
}: {
  host: WordHost;
  engine: Engine;
  /** Office's display language, the default target of a translation. */
  language: string;
}) {
  const { proposal, error, setError, ask, discard } = useProposal<Made>();
  const [tab, setTab] = useState<"edit" | "draft">("edit");
  const [target, setTarget] = useState(() => {
    const code = language.slice(0, 2).toLowerCase();
    return (TARGET_LANGUAGES as readonly string[]).includes(code) && code !== "en" ? code : "fr";
  });
  const [instruction, setInstruction] = useState("");
  const [request, setRequest] = useState("");
  const [useContext, setUseContext] = useState(true);
  const [notice, setNotice] = useState("");

  const runRewrite = (kind: RewriteKind) =>
    ask(async ({ signal, onText }) => {
      setNotice("");
      const source = await host.readSelection();
      const text = await rewrite(
        engine,
        kind,
        source,
        { language: promptLanguageName(target), instruction },
        { signal, onText },
      );
      return { text, value: { kind: "rewrite", source } as Made };
    });

  const runDraft = () =>
    ask(async ({ signal, onText }) => {
      setNotice("");
      const context = useContext ? (await host.readSelection()).trim() : "";
      const question = context
        ? fill(OFFICE.word.draftWithContext, { request: request.trim(), context })
        : request.trim();
      const text = await officeTurn(engine, question, [{ tools: [], prompt: OFFICE.word.draft }], {
        signal,
        onText,
      });
      return { text, value: { kind: "draft" } as Made };
    });

  const apply = async (how: "replace" | "insert") => {
    if (!proposal?.value) return;
    try {
      if (how === "replace" && proposal.value.kind === "rewrite") {
        const outcome = await host.replaceSelection(proposal.value.source, proposal.text);
        if (outcome === "changed") {
          setNotice(
            t(
              "The selection changed since this was written. Select the same passage again, or insert the proposal instead.",
              "La sélection a changé depuis cette proposition. Sélectionnez à nouveau le même passage, ou insérez plutôt la proposition.",
            ),
          );
          return;
        }
      } else {
        await host.insert(proposal.text);
      }
      discard();
    } catch {
      setError(
        t(
          "Word did not accept the change. Try again.",
          "Word n’a pas accepté la modification. Réessayez.",
        ),
      );
    }
  };

  return (
    <>
      <div className="office-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "edit"}
          className={tab === "edit" ? "active" : ""}
          onClick={() => setTab("edit")}
        >
          {t("Edit the selection", "Modifier la sélection")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "draft"}
          className={tab === "draft" ? "active" : ""}
          onClick={() => setTab("draft")}
        >
          {t("Draft", "Rédiger")}
        </button>
      </div>
      {tab === "edit" ? (
        <section className="office-section">
          <p className="quiet">
            {t(
              "Select a passage in the document, then choose what to do with it.",
              "Sélectionnez un passage du document, puis choisissez quoi en faire.",
            )}
          </p>
          <div className="office-grid">
            {ACTIONS.map(([kind, label]) => (
              <button
                key={kind}
                className="button"
                type="button"
                disabled={proposal?.pending}
                onClick={() => void runRewrite(kind)}
              >
                {label()}
              </button>
            ))}
          </div>
          <div className="office-row">
            <select
              aria-label={t("Translate into", "Traduire en")}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              {TARGET_LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {shownLanguageName(code)}
                </option>
              ))}
            </select>
            <button
              className="button"
              type="button"
              disabled={proposal?.pending}
              onClick={() => void runRewrite("translate")}
            >
              {t("Translate", "Traduire")}
            </button>
          </div>
          <label className="office-field">
            {t("Or describe the change", "Ou décrivez la modification")}
            <textarea
              rows={2}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
            />
          </label>
          <button
            className="button primary"
            type="button"
            disabled={proposal?.pending || !instruction.trim()}
            onClick={() => void runRewrite("custom")}
          >
            {t("Apply to the selection", "Appliquer à la sélection")}
          </button>
        </section>
      ) : (
        <section className="office-section">
          <label className="office-field">
            {t("What should Sub Rosa write here?", "Que doit écrire Sub Rosa ici ?")}
            <textarea
              rows={4}
              value={request}
              onChange={(event) => setRequest(event.target.value)}
            />
          </label>
          <label className="office-check">
            <input
              type="checkbox"
              checked={useContext}
              onChange={(event) => setUseContext(event.target.checked)}
            />
            {t("Use the selected text as context", "Utiliser le texte sélectionné comme contexte")}
          </label>
          <button
            className="button primary"
            type="button"
            disabled={proposal?.pending || !request.trim()}
            onClick={() => void runDraft()}
          >
            {t("Draft", "Rédiger")}
          </button>
        </section>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {proposal && (
        <Proposal
          text={proposal.text}
          pending={proposal.pending}
          onDiscard={discard}
          actions={
            proposal.value?.kind === "rewrite" ? (
              <>
                <button
                  className="button primary"
                  type="button"
                  onClick={() => void apply("replace")}
                >
                  {t("Replace the selection", "Remplacer la sélection")}
                </button>
                <button className="button" type="button" onClick={() => void apply("insert")}>
                  {t("Insert after it", "Insérer après")}
                </button>
              </>
            ) : (
              <button className="button primary" type="button" onClick={() => void apply("insert")}>
                {t("Insert at the cursor", "Insérer au curseur")}
              </button>
            )
          }
        />
      )}
    </>
  );
}
