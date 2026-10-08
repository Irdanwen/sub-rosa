import type { ReactNode } from "react";
import { t } from "../../../website/src/lib/i18n";

/**
 * A model's answer, shown before anything touches the document: the note
 * editor's rule (ADR-0038), applied to Office. What replaces the person's text
 * or adds to their file happens only through one of `actions`.
 */
export function Proposal({
  text,
  pending,
  children,
  actions,
  onDiscard,
}: {
  text: string;
  pending: boolean;
  /** What the proposal holds beyond its text (a formula, a list of slides). */
  children?: ReactNode;
  actions?: ReactNode;
  onDiscard: () => void;
}) {
  return (
    <section className="office-proposal" aria-live="polite" aria-busy={pending}>
      <h2>{pending ? t("Writing…", "Rédaction…") : t("Proposal", "Proposition")}</h2>
      {text && <div className="office-proposal-text">{text}</div>}
      {children}
      <div className="actions">
        {!pending && actions}
        <button className="button" type="button" onClick={onDiscard}>
          {pending ? t("Stop", "Arrêter") : t("Discard", "Ignorer")}
        </button>
      </div>
    </section>
  );
}
